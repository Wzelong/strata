import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createServer, getServerPort, redis, reddit, context, scheduler, settings } from '@devvit/web/server'
import type { MenuItemRequest, UiResponse, TriggerResponse } from '@devvit/web/shared'
import OpenAI from 'openai'
import { StrataEngine, normalize } from '../engine/index.js'
import { RedisKVStore, type RedisClient } from '../engine/storage/redis.js'
import { RedisAlertStore } from '../engine/storage/redis-alert-store.js'
import type { AlertStore } from '../engine/storage/alert-store.js'
import type { RawItem, Item, Hit, StoredItem, Entity, Alert, AlertConnection, AlertEntity, AlertStatus, FlagResult } from '../engine/types.js'
import {
  buildEmbeddingJsonl, buildExtractionJsonl, buildEntityEmbeddingJsonl,
  submitBatch, checkBatch, downloadBatchResults,
  parseEmbeddingResults, parseExtractionResults, storeResults,
  ingestChunkRealTime,
} from '../engine/batch-ingest.js'
import { buildScanPairs, classifyAndCreateAlerts, type ScanPair } from '../engine/scan.js'
import { routeFlag, formatReportReason, brigadeLockKey, BRIGADE_LOCK_TTL_MS } from '../engine/flag-routing.js'
import { estimateBackfill, estimateBackfillRealtime, estimateCurrentBytes, ITEM_CAPACITY, RT_ITEMS_PER_TICK, RT_TICK_SPACING_MS } from './backfill-estimates.js'
import { recordUsage, getUsageSummary } from './usage.js'
import { createChatHandler } from './chat/route.js'
import { runRecluster, assignItemLive, ClusterRepo } from './cluster-pipeline.js'
import { LOUVAIN_RESOLUTION, MIN_CLUSTER_SIZE } from '../engine/cluster.js'
import { dequantize } from '../engine/embed.js'
import { encrypt, decrypt } from './crypto.js'
import seedRawItems from './seed-raw.json' with { type: 'json' }
import { gunzipSync } from 'node:zlib'

const SEED_URL = 'https://raw.githubusercontent.com/Wzelong/strata/main/dataset/seed.json.gz'

const app = new Hono()

const redisClient: RedisClient = {
  hSet: (key, fieldValues) => redis.hSet(key, fieldValues),
  hGet: (key, field) => redis.hGet(key, field),
  hGetAll: (key) => redis.hGetAll(key),
  hDel: (key, fields) => redis.hDel(key, fields),
  hIncrBy: (key, field, value) => redis.hIncrBy(key, field, value),
  hScan: (key, cursor, pattern, count) => redis.hScan(key, cursor, pattern, count),
  zAdd: (key, ...members) => redis.zAdd(key, ...members),
  zRange: (key, start, stop, options) => redis.zRange(key, start as any, stop as any, options as any),
  zRem: (key, members) => redis.zRem(key, members),
  zCard: (key) => redis.zCard(key),
  del: (key) => redis.del(key) as Promise<void>,
}

const store = new RedisKVStore(redisClient)
const alertStore: AlertStore = new RedisAlertStore(redisClient)

function generateAlertId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function buildPermalink(item: Item, subredditName: string): string {
  if (item.type === 'comment') {
    return `/r/${subredditName}/comments/${item.threadRootId}/_/${item.id}`
  }
  return `/r/${subredditName}/comments/${item.id}`
}

function buildDashboardUrl(postId: string, subredditName: string): string {
  return `https://reddit.com/r/${subredditName}/comments/${postId.replace(/^t3_/, '')}`
}

async function isMod(userId: string | undefined, subredditName: string): Promise<boolean> {
  if (!userId || !subredditName) return false
  const cacheKey = `strata:mod:${userId}`
  const cached = await redis.get(cacheKey)
  if (cached === '1') return true
  if (cached === '0') return false
  try {
    const listing = await reddit.getModerators({ subredditName })
    const mods = typeof (listing as any).all === 'function' ? await (listing as any).all() : await listing
    const ok = (mods as Array<{ id: string }>).some(m => m.id === userId)
    await redis.set(cacheKey, ok ? '1' : '0', { expiration: new Date(Date.now() + 5 * 60_000) })
    return ok
  } catch (err) {
    console.error('[Strata] isMod check failed:', err)
    return false
  }
}

async function ensureDashboardPost(subredditName: string): Promise<string> {
  const stored = await redis.get('strata:dashboard-post-id')
  if (stored) {
    const existing = await reddit.getPostById(stored as `t3_${string}`).catch(() => null)
    if (existing && !existing.removed) return stored
  }
  const post = await reddit.submitCustomPost({
    subredditName,
    title: 'Strata · Moderator Dashboard',
    entry: 'default',
    postData: {},
    styles: {
      backgroundColor: '#FFFFFFFF',
      backgroundColorDark: '#1a1a1bFF',
      height: 'TALL' as any,
    },
  })
  await redis.set('strata:dashboard-post-id', post.id)
  try { await post.distinguish() } catch (err) { console.error('[Strata] distinguish failed:', err) }
  try { await post.lock() } catch (err) { console.error('[Strata] lock failed:', err) }
  return post.id
}

const OPENAI_KEY_REDIS = 'strata:openai-key'

async function getOpenAIKey(): Promise<string | null> {
  try {
    const blob = await redis.get(OPENAI_KEY_REDIS)
    if (!blob) return null
    const secret = await settings.get('strataEncryptionKey')
    if (typeof secret !== 'string' || !secret) return null
    return decrypt(blob, secret)
  } catch (err) {
    console.error('[Strata] Failed to read/decrypt stored key:', err)
    return null
  }
}

async function getEngine(): Promise<StrataEngine> {
  const apiKey = await getOpenAIKey()
  if (!apiKey) throw new Error('OpenAI API key not configured')
  const client = new OpenAI({ apiKey })
  return new StrataEngine(store, client)
}

function relativeAge(createdAt: number): string {
  const ms = Date.now() - createdAt
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function renderDigestMarkdown(
  alerts: Array<{ alert: Alert; connections: AlertConnection[] }>,
  subredditName: string,
  dashboardUrl: string,
): string {
  const n = alerts.length
  const intro = `Strata found **${n} case anchor${n === 1 ? '' : 's'}** with buried cross-thread connections on r/${subredditName}.`
  const blocks = alerts.map(({ alert, connections }, i) => {
    const title = alert.anchorTitle || alert.anchorText.slice(0, 80)
    const threadCount = new Set(connections.map(c => c.itemId)).size
    const strongest = [...connections].sort((a, b) => {
      if (a.confidence === 'high' && b.confidence !== 'high') return -1
      if (b.confidence === 'high' && a.confidence !== 'high') return 1
      return 0
    })[0]
    const summary = strongest?.reasoning?.split(/[.\n]/)[0]?.trim() || 'See dashboard for details.'
    return [
      `### ${i + 1}. ${title}`,
      `- **${connections.length} connection${connections.length === 1 ? '' : 's'}** across ${threadCount} thread${threadCount === 1 ? '' : 's'} · posted ${relativeAge(alert.createdAt)} by u/${alert.anchorAuthor}`,
      `- ${summary}`,
      `- Confidence: ${alert.confidence}`,
    ].join('\n')
  }).join('\n\n')
  return [
    intro,
    '---',
    blocks,
    '---',
    `**Open the dashboard:** [Strata · Moderator Dashboard](${dashboardUrl})`,
    `*Automated by Strata. Configure under r/${subredditName}/about/edit/modules.*`,
  ].join('\n\n')
}

type BackfillRecord = {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  from: string
  to: string
  startedAt: number
  endedAt: number | null
  totalItems: number
  processed: number
  initiatedBy: string
  error?: string
  costUsdEstimated?: number
}

async function getBackfillRecord(id: string): Promise<BackfillRecord | null> {
  const raw = await redis.hGet('strata:backfill:history', id)
  return raw ? JSON.parse(raw) as BackfillRecord : null
}

async function putBackfillRecord(record: BackfillRecord): Promise<void> {
  await redis.hSet('strata:backfill:history', { [record.id]: JSON.stringify(record) })
}

async function updateBackfillRecord(id: string, patch: Partial<BackfillRecord>): Promise<void> {
  const existing = await getBackfillRecord(id)
  if (!existing) return
  await putBackfillRecord({ ...existing, ...patch })
}

async function listBackfillRecords(): Promise<BackfillRecord[]> {
  const all = await redis.hGetAll('strata:backfill:history')
  return Object.values(all)
    .map(v => JSON.parse(v) as BackfillRecord)
    .sort((a, b) => b.startedAt - a.startedAt)
}

async function sendSurfaceDigest(subredditName: string, newAlertIds: string[]): Promise<void> {
  if (newAlertIds.length === 0) return
  const loaded = await Promise.all(newAlertIds.map(async id => {
    const alert = await alertStore.getAlert(id)
    if (!alert || alert.mode !== 'surface') return null
    const connections = await alertStore.getAlertConnections(id)
    return { alert, connections }
  }))
  const present = loaded.filter((x): x is { alert: Alert; connections: AlertConnection[] } => !!x)
  if (present.length === 0) return
  const postId = await ensureDashboardPost(subredditName)
  const dashboardUrl = buildDashboardUrl(postId, subredditName)
  await reddit.modMail.createConversation({
    subredditName,
    subject: `Strata: ${present.length} case anchor${present.length === 1 ? '' : 's'} found`,
    body: renderDigestMarkdown(present, subredditName, dashboardUrl),
    to: null as any,
  })
}

// --- Triggers ---

app.post('/internal/triggers/app-install', async (c) => {
  const input = await c.req.json<any>()
  const subredditName = input.subreddit?.name || context.subredditName
  console.log('[Strata] Installed to r/' + subredditName)
  await redis.set('strata:installed', '1')

  if (subredditName) {
    try {
      const postId = await ensureDashboardPost(subredditName)
      console.log(`[Strata] Dashboard post: ${postId}`)
    } catch (err) {
      console.error('[Strata] Failed to create dashboard post:', err)
    }
  }

  return c.json<TriggerResponse>({ status: 'ok' })
})

app.post('/internal/triggers/post-delete', async (c) => {
  try {
    const input = await c.req.json<any>()
    const postId: string | undefined = input?.postId || input?.post?.id
    if (postId) {
      await store.deleteItems([postId])
      console.log(`[Strata] Purged deleted post ${postId}`)
    }
  } catch (err) {
    console.error('[Strata] post-delete trigger failed:', err)
  }
  return c.json<TriggerResponse>({ status: 'ok' })
})

app.post('/internal/triggers/comment-delete', async (c) => {
  try {
    const input = await c.req.json<any>()
    const commentId: string | undefined = input?.commentId || input?.comment?.id
    if (commentId) {
      await store.deleteItems([commentId])
      console.log(`[Strata] Purged deleted comment ${commentId}`)
    }
  } catch (err) {
    console.error('[Strata] comment-delete trigger failed:', err)
  }
  return c.json<TriggerResponse>({ status: 'ok' })
})

app.post('/internal/triggers/post-submit', async (c) => {
  const input = await c.req.json<any>()
  const post = input.post
  if (!post?.title || !post?.id) return c.json<TriggerResponse>({ status: 'ok' })

  const dashboardPostId = await redis.get('strata:dashboard-post-id')
  if (post.id === dashboardPostId) return c.json<TriggerResponse>({ status: 'ok' })

  const seeded = await redis.get('strata:seed:complete')
  if (!seeded) {
    console.log('[Strata] Skipping post — no seed data loaded yet')
    return c.json<TriggerResponse>({ status: 'ok' })
  }

  try {
    const engine = await getEngine()

    const fullPost = await reddit.getPostById(post.id)
    const title = fullPost.title
    const text = fullPost.body || ''
    const authorName = fullPost.authorName || post.author || 'unknown'
    const authorId = post.authorId || authorName

    const raw: RawItem = {
      id: post.id,
      type: 'post',
      title,
      text,
      authorId,
      authorName,
      createdAt: Date.now(),
      threadRootId: post.id,
      parentId: null,
    }

    console.log(`[Strata] Ingesting post ${post.id} by ${authorName}: "${text.slice(0, 60)}..."`)
    const item = await engine.ingest(raw)
    addToItemCache(item)

    assignItemLive(redis, store, item.id, item.embedding).catch(err => console.error('[Strata] live cluster assign failed:', err))
    bumpIngestCounter()

    const [surfaceResult, flagResults] = await Promise.all([
      engine.surface(item),
      engine.flag(item),
    ])
    const { candidates, entityMatches } = surfaceResult
    console.log(`[Strata] Found ${candidates.length} candidates, ${flagResults.length} flags`)
    console.log(`[Strata] entityMatches: ${entityMatches.size} items with entities`, [...entityMatches.entries()].slice(0, 3).map(([id, ents]) => `${id}: [${ents.join(', ')}]`))

    const classifications = await engine.classifyBatch(item, candidates.map(h => h.item))
    const connections: Array<{ item: Item; relationship: string; weight: number }> = []
    for (const cls of classifications) {
      const hit = candidates.find(c => c.item.id === cls.id)
      if (!hit) continue
      console.log(`[Strata]   ${cls.id} (${hit.weight.toFixed(4)}): ${cls.relationship} — ${cls.reason.slice(0, 60)}`)
      if (cls.relationship !== 'UNRELATED') {
        connections.push({ item: hit.item, relationship: cls.relationship, weight: hit.weight })
      }
    }

    console.log(`[Strata] ${connections.length} related items after classification`)

    if (connections.length > 0 && context.subredditName) {
      const subredditName = context.subredditName
      const related = classifications.filter(c => c.relationship !== 'UNRELATED')

      // Token-overlap bridge for same-type entities — handles phrasings that
      // exact substring misses (e.g. "Mass Ave & Prospect" vs "Mass Ave /
      // Prospect light"). Substring and equality also accepted.
      const tokenize = (s: string) =>
        new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3))
      const entityBridge = (a: Entity, b: Entity): boolean => {
        if (a.type !== b.type) return false
        const al = a.surfaceText.toLowerCase()
        const bl = b.surfaceText.toLowerCase()
        if (al === bl || al.includes(bl) || bl.includes(al)) return true
        const at = tokenize(al), bt = tokenize(bl)
        if (at.size === 0 || bt.size === 0) return false
        let shared = 0
        for (const t of at) if (bt.has(t)) shared++
        if (shared >= 2) return true
        if (shared >= 1 && Math.min(at.size, bt.size) <= 2) return true
        return false
      }
      const inBody = (needle: string, text: string) => text.toLowerCase().includes(needle.toLowerCase())

      // Only consider entities that are actually rendered in their body — an
      // entity extracted from a title can't be highlighted in the body pane.
      const renderedAnchorEntities = item.entities.filter(e => inBody(e.surfaceText, item.text))

      // For each connection, find which rendered anchor entities bridge to a
      // body-present connection entity. The clusterId of a connection-side
      // span is the matched anchor's surface text — guaranteeing cross-pane
      // links land on a real anchor span.
      type Bridge = { anchor: Entity; connEntity: Entity }
      const perConnBridges = new Map<string, Bridge[]>()
      const usedAnchors = new Set<string>()
      for (const cls of related) {
        const hit = candidates.find(c => c.item.id === cls.id)
        if (!hit) continue
        const bridges: Bridge[] = []
        for (const ce of hit.item.entities) {
          if (!inBody(ce.surfaceText, hit.item.text)) continue
          for (const ae of renderedAnchorEntities) {
            if (entityBridge(ae, ce)) {
              bridges.push({ anchor: ae, connEntity: ce })
              usedAnchors.add(`${ae.type}:${ae.surfaceText}`)
              break
            }
          }
        }
        perConnBridges.set(cls.id, bridges)
      }

      const anchorEntities: AlertEntity[] = renderedAnchorEntities
        .filter(e => usedAnchors.has(`${e.type}:${e.surfaceText}`))
        .map(e => ({ text: e.surfaceText, clusterId: `${e.type}:${e.surfaceText}` }))

      const alertConnections: AlertConnection[] = related.map(cls => {
        const hit = candidates.find(c => c.item.id === cls.id)!
        const bridges = perConnBridges.get(cls.id) ?? []
        const entities: AlertEntity[] = []
        const seen = new Set<string>()
        for (const b of bridges) {
          const clusterId = `${b.anchor.type}:${b.anchor.surfaceText}`
          const key = `${clusterId} ${b.connEntity.surfaceText}`
          if (seen.has(key)) continue
          seen.add(key)
          entities.push({ text: b.connEntity.surfaceText, clusterId })
        }
        return {
          itemId: cls.id,
          author: hit.item.authorName,
          type: hit.item.type,
          title: hit.item.title,
          text: hit.item.text,
          permalink: buildPermalink(hit.item, subredditName),
          classification: cls.relationship.toLowerCase() as AlertConnection['classification'],
          confidence: cls.confidence ?? 'review',
          entities,
          reasoning: cls.reason,
          createdAt: hit.item.createdAt,
          sameAuthor: hit.item.authorId === item.authorId,
        }
      })

      const alert: Alert = {
        id: generateAlertId(),
        mode: 'surface',
        status: 'pending',
        confidence: alertConnections.some(c => c.confidence === 'high') ? 'high' : 'review',
        connectionCount: alertConnections.length,
        createdAt: Date.now(),
        anchorId: item.id,
        anchorAuthor: item.authorName,
        anchorType: item.type,
        anchorTitle: item.title,
        anchorText: item.text,
        anchorPermalink: buildPermalink(item, subredditName),
        anchorEntities,
      }

      await alertStore.createAlert(alert, alertConnections)
      console.log(`[Strata] Alert ${alert.id} created — ${alertConnections.length} connections`)

      try {
        await sendSurfaceDigest(subredditName, [alert.id])
      } catch (err) {
        console.error('[Strata] Surface digest modmail failed:', err)
      }
    }

    // Flag alerts
    if (flagResults.length > 0 && context.subredditName) {
      const subredditName = context.subredditName
      for (const flag of flagResults) {
        const route = routeFlag(flag)
        if (route === 'queue') {
          try {
            const target = await reddit.getPostById(item.id as `t3_${string}`)
            await reddit.report(target, { reason: formatReportReason(flag) })
            console.log(`[Strata] Reported post ${item.id} — ${flag.type}`)
          } catch (err) {
            console.error(`[Strata] Failed to report post ${item.id}:`, err)
          }
          continue
        }
        if (route === 'drop') continue

        const flagConnections: AlertConnection[] = flag.connectionItems.map(ci => ({
          itemId: ci.id,
          author: ci.authorName,
          type: ci.type,
          title: ci.title,
          text: ci.text,
          permalink: buildPermalink(ci, subredditName),
          classification: 'confirms' as const,
          confidence: flag.confidence,
          entities: [],
          reasoning: '',
          createdAt: ci.createdAt,
          sameAuthor: ci.authorId === item.authorId,
        }))

        const flagAlert: Alert = {
          id: generateAlertId(),
          mode: 'flag',
          status: 'pending',
          confidence: flag.confidence,
          connectionCount: flagConnections.length,
          createdAt: Date.now(),
          anchorId: item.id,
          anchorAuthor: item.authorName,
          anchorType: item.type,
          anchorTitle: item.title,
          anchorText: item.text,
          anchorPermalink: buildPermalink(item, subredditName),
          anchorEntities: [],
          reasoning: flag.reasoning,
          flagType: flag.type,
        }

        await alertStore.createAlert(flagAlert, flagConnections)
        console.log(`[Strata] Flag alert ${flagAlert.id} — ${flag.type}`)
      }
    }
  } catch (err) {
    console.error('[Strata] Error processing post:', err)
  }

  return c.json<TriggerResponse>({ status: 'ok' })
})

app.post('/internal/triggers/comment-submit', async (c) => {
  const input = await c.req.json<any>()
  const comment = input.comment
  if (!comment?.body || !comment?.id) return c.json<TriggerResponse>({ status: 'ok' })

  const seeded = await redis.get('strata:seed:complete')
  if (!seeded) return c.json<TriggerResponse>({ status: 'ok' })

  try {
    const engine = await getEngine()
    const threadRootId = comment.linkId || comment.id
    let parentTitle: string | undefined
    try {
      const parentPost = await reddit.getPostById(threadRootId as `t3_${string}`)
      parentTitle = parentPost.title
    } catch {}

    const raw: RawItem = {
      id: comment.id,
      type: 'comment',
      title: parentTitle,
      text: comment.body,
      authorId: comment.authorId || comment.author || 'unknown',
      authorName: comment.author || 'unknown',
      createdAt: Date.now(),
      threadRootId,
      parentId: comment.parentId || null,
    }

    const item = await engine.ingest(raw)
    addToItemCache(item)
    console.log(`[Strata] Ingested comment ${comment.id}`)

    assignItemLive(redis, store, item.id, item.embedding).catch(err => console.error('[Strata] live cluster assign failed:', err))
    bumpIngestCounter()

    const flagResults = await engine.flag(item)
    if (flagResults.length > 0 && context.subredditName) {
      const subredditName = context.subredditName
      for (const flag of flagResults) {
        const route = routeFlag(flag)
        if (route === 'queue') {
          try {
            const target = await reddit.getCommentById(item.id as `t1_${string}`)
            await reddit.report(target, { reason: formatReportReason(flag) })
            console.log(`[Strata] Reported comment ${item.id} — ${flag.type}`)
          } catch (err) {
            console.error(`[Strata] Failed to report comment ${item.id}:`, err)
          }
          continue
        }
        if (route === 'drop') continue

        if (flag.type === 'brigade') {
          const lockKey = brigadeLockKey(item.threadRootId)
          const exists = await redis.get(lockKey)
          if (exists) {
            console.log(`[Strata] Brigade lock active for thread ${item.threadRootId}, skipping`)
            continue
          }
          await redis.set(lockKey, '1', { expiration: new Date(Date.now() + BRIGADE_LOCK_TTL_MS) })
        }

        const flagConnections: AlertConnection[] = flag.connectionItems.map(ci => ({
          itemId: ci.id,
          author: ci.authorName,
          type: ci.type,
          title: ci.title,
          text: ci.text,
          permalink: buildPermalink(ci, subredditName),
          classification: 'confirms' as const,
          confidence: flag.confidence,
          entities: [],
          reasoning: '',
          createdAt: ci.createdAt,
          sameAuthor: ci.authorId === item.authorId,
        }))

        const flagAlert: Alert = {
          id: generateAlertId(),
          mode: 'flag',
          status: 'pending',
          confidence: flag.confidence,
          connectionCount: flagConnections.length,
          createdAt: Date.now(),
          anchorId: item.id,
          anchorAuthor: item.authorName,
          anchorType: 'comment',
          anchorTitle: item.title,
          anchorText: item.text,
          anchorPermalink: buildPermalink(item, subredditName),
          anchorEntities: [],
          reasoning: flag.reasoning,
          flagType: flag.type,
        }

        await alertStore.createAlert(flagAlert, flagConnections)
        console.log(`[Strata] Flag alert ${flagAlert.id} (comment) — ${flag.type}`)
      }
    }
  } catch (err) {
    console.error('[Strata] Error processing comment:', err)
  }

  return c.json<TriggerResponse>({ status: 'ok' })
})

// --- Menu Actions ---

app.post('/internal/menu/dashboard', async (c) => {
  const subredditName = context.subredditName
  if (!subredditName) return c.json<UiResponse>({ showToast: 'No subreddit context.' })

  try {
    const before = await redis.get('strata:dashboard-post-id')
    const postId = await ensureDashboardPost(subredditName)
    const created = postId !== before
    return c.json<UiResponse>({
      showToast: created ? 'Dashboard post created.' : 'Dashboard already exists.',
    })
  } catch (err) {
    console.error('[Strata] Dashboard creation error:', err)
    return c.json<UiResponse>({ showToast: `Failed: ${err}` })
  }
})

app.post('/internal/menu/seed-data', async (c) => {
  return c.json<UiResponse>({
    showForm: {
      name: 'seedResults',
      form: {
        title: 'Seed Strata Data',
        acceptLabel: 'Reset & Seed',
        fields: [
          { name: 'confirm', label: 'This will clear all existing data and load ~3,000 items into Redis. Takes about 30 seconds.', type: 'paragraph' as const, defaultValue: 'Click "Reset & Seed" to proceed.' },
        ],
      },
    },
  })
})

app.post('/internal/forms/seed-results', async (c) => {
  try {
    console.log('[Strata] Resetting Redis...')
    const ENTITY_TYPES = ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity']

    // Delete alert detail keys first (need the index to find them)
    const alertEntries = await redis.zRange('strata:alerts', 0, -1).catch(() => [])
    for (const entry of alertEntries) {
      await redis.del(`strata:alert:${entry.member}`)
      await redis.del(`strata:alert:${entry.member}:connections`)
    }

    const keys = [
      'strata:items', 'strata:embeddings', 'strata:idx:time',
      'strata:seed:complete', 'strata:seed:item-count', 'strata:installed',
      'strata:entity-hub-counts', 'strata:alerts', 'strata:cases', 'strata:rules',
      ...ENTITY_TYPES.map(t => `strata:entity-emb:${t}`),
    ]
    for (const key of keys) {
      await redis.del(key)
    }
    console.log('[Strata] Reset complete, fetching seed from GitHub...')
    const resp = await fetch(SEED_URL)
    if (!resp.ok) throw new Error(`Seed fetch failed: ${resp.status}`)
    const compressed = Buffer.from(await resp.arrayBuffer())
    const json = gunzipSync(compressed).toString('utf8')
    const seed = JSON.parse(json) as {
      items: StoredItem[]
      embeddings: Record<string, number[]>
      entityEmbeddings?: Record<string, Record<string, string>>
    }

    console.log(`[Strata] Loaded ${seed.items.length} items, writing to Redis...`)

    const BATCH = 100
    for (let i = 0; i < seed.items.length; i += BATCH) {
      const batch = seed.items.slice(i, i + BATCH)
      const itemFields: Record<string, string> = {}
      const embFields: Record<string, string> = {}

      for (const item of batch) {
        itemFields[item.id] = JSON.stringify(item)
        const emb = seed.embeddings[item.id]
        if (emb) embFields[item.id] = JSON.stringify(emb)
      }

      await redis.hSet('strata:items', itemFields)
      if (Object.keys(embFields).length > 0) {
        await redis.hSet('strata:embeddings', embFields)
      }

      for (const item of batch) {
        await redis.zAdd('strata:idx:time', { member: item.id, score: item.createdAt })
        await redis.zAdd(`strata:idx:author:${item.authorId}`, { member: item.id, score: item.createdAt })
        await redis.zAdd(`strata:idx:thread:${item.threadRootId}`, { member: item.id, score: item.createdAt })
        await redis.zAdd(`strata:idx:decision:${item.decision}`, { member: item.id, score: item.decisionAt ?? item.createdAt })

        for (const e of item.entities) {
          await redis.zAdd(`strata:idx:entity:${e.type}:${e.surfaceText}`, { member: item.id, score: item.createdAt })
        }
      }

      if ((i + BATCH) % 500 === 0 || i + BATCH >= seed.items.length) {
        console.log(`[Strata] Seeded ${Math.min(i + BATCH, seed.items.length)}/${seed.items.length}`)
      }
    }

    // Seed entity embeddings
    if (seed.entityEmbeddings) {
      for (const [type, entries] of Object.entries(seed.entityEmbeddings)) {
        const key = `strata:entity-emb:${type}`
        const fields: Record<string, string> = {}
        for (const [field, emb] of Object.entries(entries)) {
          fields[field] = emb
        }
        if (Object.keys(fields).length > 0) {
          await redis.hSet(key, fields)
        }
      }
      const totalEntEmbs = Object.values(seed.entityEmbeddings).reduce((n, v) => n + Object.keys(v).length, 0)
      console.log(`[Strata] Seeded ${totalEntEmbs} entity embeddings`)
    }

    await redis.set('strata:seed:complete', '1')
    await redis.set('strata:seed:item-count', String(seed.items.length))
    console.log(`[Strata] Seed complete: ${seed.items.length} items`)

    return c.json<UiResponse>({
      showToast: { text: `Seeded ${seed.items.length} items!`, appearance: 'success' },
    })
  } catch (err) {
    console.error('[Strata] Seed error:', err)
    return c.json<UiResponse>({ showToast: `Seed failed: ${err}` })
  }
})

// Mock alerts — drops 2 sample alerts (1 surface + 1 brigade) into Redis
// so UI work doesn't require triggering anything live. Idempotent: each click
// creates a fresh batch with new IDs and current timestamps.
// Rule and pattern flags don't show up here — they route to the Reddit mod queue.
app.post('/internal/menu/mock-alerts', async (c) => {
  if (!context.subredditName) return c.json<UiResponse>({ showToast: 'No subreddit context.' })
  const sub = context.subredditName
  const now = Date.now()
  const stub = (id: string, sub: string) => `https://reddit.com/r/${sub}/comments/${id.replace(/^t[13]_/, '')}`

  const hours = (n: number) => now - n * 60 * 60_000
  const days = (n: number) => now - n * 24 * 60 * 60_000
  const minutes = (n: number) => now - n * 60_000

  // SURFACE: case post with 4 buried witnesses + 1 case-thread comment
  const surfaceConnections: AlertConnection[] = [
    { itemId: 't1_strata_surface1', author: 'ThursdayCommuter', type: 'comment',
      title: 'Cambridge bike commute - daily thread',
      text: 'Almost ate it this morning at the Mass Ave / Prospect light — dark green Subaru wagon came flying through the red heading east. Plate started with a K, that\'s all I caught before he was gone.',
      permalink: stub('t1_strata_surface1', sub),
      classification: 'updates', confidence: 'high',
      entities: [
        { text: 'Mass Ave / Prospect light', clusterId: 'loc:intersection' },
      ],
      reasoning: 'Same vehicle description (dark green Subaru wagon) and same intersection (Mass Ave / Prospect) running the red light. Plate starts with K, consistent with the case post\'s partial plate ending in -K77.',
      createdAt: hours(5), sameAuthor: false },
    { itemId: 't3_strata_surface2', author: 'DashcamDave_617', type: 'comment',
      title: 'Cambridge PD black hole - anyone actually had a detective call back?',
      text: 'Submitted my dashcam clip to case #2026-04891 close to three weeks ago. Detective on the desk said "we\'ll be in touch within 48 hours" and that was the last contact.',
      permalink: stub('t3_strata_surface2', sub),
      classification: 'updates', confidence: 'high',
      entities: [
        { text: 'case #2026-04891', clusterId: 'qty:case' },
      ],
      reasoning: 'Directly references the same Cambridge PD case number and reports submitting dashcam footage — actionable evidence the case post is asking for.',
      createdAt: days(2), sameAuthor: false },
    { itemId: 't1_strata_surface3', author: 'CambridgeSide_Resident', type: 'comment',
      title: 'Cambridgeside garage parking complaints',
      text: 'Whoever\'s parking a dark green Subaru wagon in P3 — your friend clipped my side mirror last Tuesday around 5:30 and just bounced. Partial plate ended in -K77 if anyone has dashcam from P3.',
      permalink: stub('t1_strata_surface3', sub),
      classification: 'updates', confidence: 'high',
      entities: [
        { text: 'Partial plate ended in -K77', clusterId: 'obj:plate' },
        { text: 'Tuesday around 5:30', clusterId: 'qty:time' },
      ],
      reasoning: 'Partial plate -K77 matches the case post exactly. Same vehicle description. Same time of day (Tuesday around 5:30) as the cyclist incident. Possibly the same driver leaving the scene of a second hit.',
      createdAt: days(3), sameAuthor: false },
    { itemId: 't3_strata_surface4', author: 'InmanSq_Walker', type: 'post',
      title: 'Tuesday around 5:30 near Central — what was that crash?',
      text: 'Was walking down to dinner Tuesday evening and heard a real bad bang from up the street, then someone screaming. By the time I got close it had already cleared out — cops weren\'t there yet. Kept walking like a coward.',
      permalink: stub('t3_strata_surface4', sub),
      classification: 'confirms', confidence: 'review',
      entities: [
        { text: 'Tuesday evening', clusterId: 'qty:time' },
      ],
      reasoning: 'Earwitness near Central at the same time as the reported incident. No vehicle or victim details, but the audio narrative (loud bang + screaming) and timing line up.',
      createdAt: days(6), sameAuthor: false },
  ]
  const surfaceAlert: Alert = {
    id: generateAlertId(), mode: 'surface', status: 'pending',
    confidence: 'high', connectionCount: surfaceConnections.length, createdAt: now,
    anchorId: 't3_strata_casepost', anchorAuthor: 'SarahsRoommate2026', anchorType: 'post',
    anchorTitle: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    anchorText: 'Posting on behalf of my roommate Sarah. She was riding home on Mass Ave near the Prospect St intersection in Central around 5:30pm Tuesday when a driver ran the light, hit her, and took off. She\'s at MGH — broken pelvis, broken collarbone, internal bleeding. Stable but it\'s bad.\n\nCambridge PD opened it as case #2026-04891. They have a partial plate ending in -K77 but it isn\'t enough on its own.',
    anchorPermalink: stub('t3_strata_casepost', sub),
    anchorEntities: [
      { text: 'Mass Ave near the Prospect St intersection', clusterId: 'loc:intersection' },
      { text: 'around 5:30pm Tuesday', clusterId: 'qty:time' },
      { text: 'case #2026-04891', clusterId: 'qty:case' },
      { text: 'partial plate ending in -K77', clusterId: 'obj:plate' },
    ],
  }
  await alertStore.createAlert(surfaceAlert, surfaceConnections)

  // FLAG: brigade — brigade2 with 3 other defenders within 4h
  const brigadeConnections: AlertConnection[] = [
    { itemId: 't1_strata_brigade1', author: 'BostonDriver2026_1', type: 'comment',
      title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
      text: 'This is getting out of hand. I know the owner of that car and he\'s a good dude who works two jobs. You people are ready to ruin someone\'s life over a description that could match hundreds of green SUVs.',
      permalink: stub('t1_strata_brigade1', sub),
      classification: 'confirms', confidence: 'review', entities: [], reasoning: '',
      createdAt: minutes(90), sameAuthor: false },
    { itemId: 't1_strata_brigade3', author: 'BostonDriver2026_3', type: 'comment',
      title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
      text: 'I drive past Cambridgeside garage every day and there\'s no damaged Subaru there. That commenter is either lying or confused.',
      permalink: stub('t1_strata_brigade3', sub),
      classification: 'confirms', confidence: 'review', entities: [], reasoning: '',
      createdAt: minutes(105), sameAuthor: false },
    { itemId: 't1_strata_brigade4', author: 'BostonDriver2026_4', type: 'comment',
      title: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
      text: 'Has anyone verified this story is even real? No news articles, no police confirmation, just an anonymous Reddit post.',
      permalink: stub('t1_strata_brigade4', sub),
      classification: 'confirms', confidence: 'review', entities: [], reasoning: '',
      createdAt: minutes(75), sameAuthor: false },
  ]
  const brigadeAlert: Alert = {
    id: generateAlertId(), mode: 'flag', status: 'pending',
    confidence: 'high', connectionCount: brigadeConnections.length, createdAt: now - 2 * 60_000,
    anchorId: 't1_strata_brigade2', anchorAuthor: 'BostonDriver2026_2', anchorType: 'comment',
    anchorTitle: 'My roommate was hit Tuesday on Mass Ave & Prospect — driver fled — case #2026-04891',
    anchorText: 'Classic Reddit mob mentality. A "green Subaru" — do you know how many of those exist in the Boston area? My neighbor has one. Are we going to harass every Subaru owner in Cambridge now?',
    anchorPermalink: stub('t1_strata_brigade2', sub),
    anchorEntities: [],
    reasoning: '4 distinct authors, 4 comments within a 2-hour window, semantic uniformity 0.62, density 1.00 — coordinated defensive messaging.',
    flagType: 'brigade',
  }
  await alertStore.createAlert(brigadeAlert, brigadeConnections)

  return c.json<UiResponse>({ showToast: { text: 'Inserted 2 mock alerts (1 surface + 1 brigade).', appearance: 'success' } })
})

app.post('/internal/menu/surface', async (c) => {
  const request = await c.req.json<MenuItemRequest>()
  const postId = context.postId || request.targetId
  const commentId = context.commentId

  const targetId = commentId || postId
  if (!targetId) {
    return c.json<UiResponse>({ showToast: 'No post or comment context.' })
  }

  try {
    const engine = await getEngine()
    let item = await engine.getItem(targetId)

    if (!item) {
      if (commentId) {
        const comment = await reddit.getCommentById(commentId)
        const raw: RawItem = {
          id: commentId,
          type: 'comment',
          text: comment.body,
          authorId: comment.authorName || 'unknown',
          authorName: comment.authorName || 'unknown',
          createdAt: Date.now(),
          threadRootId: postId || commentId,
          parentId: comment.parentId || null,
        }
        item = await engine.ingest(raw)
      } else if (postId) {
        const post = await reddit.getPostById(postId as `t3_${string}`)
        const text = post.body ? `${post.title}\n\n${post.body}` : post.title
        const raw: RawItem = {
          id: postId,
          type: 'post',
          text,
          authorId: post.authorName || 'unknown',
          authorName: post.authorName || 'unknown',
          createdAt: Date.now(),
          threadRootId: postId,
          parentId: null,
        }
        item = await engine.ingest(raw)
      }
    }

    if (!item) {
      return c.json<UiResponse>({ showToast: 'Could not load item.' })
    }

    const similar = await engine.findSimilar(item.embedding, 10, { excludeIds: new Set([item.id]) })
    const connections: Array<{ item: Item; relationship: string }> = []

    for (const hit of similar.slice(0, 5)) {
      if (hit.weight < 0.50) break
      const rel = await engine.classifyRelationship(item, hit.item)
      if (rel !== 'UNRELATED') {
        connections.push({ item: hit.item, relationship: rel })
      }
    }

    if (connections.length === 0) {
      return c.json<UiResponse>({ showToast: 'No connections found for this item.' })
    }

    return c.json<UiResponse>({
      showForm: {
        name: 'surfaceResults',
        form: {
          title: `Strata: ${connections.length} Connection(s) Found`,
          fields: connections.map((conn, i) => ({
            name: `conn${i}`,
            label: `${conn.relationship} — ${conn.item.authorName} (${new Date(conn.item.createdAt).toLocaleDateString()})`,
            type: 'paragraph' as const,
            defaultValue: conn.item.text.slice(0, 300),
          })),
        },
      },
    })
  } catch (err) {
    console.error('[Strata] Surface error:', err)
    return c.json<UiResponse>({ showToast: `Error: ${err}` })
  }
})

app.post('/internal/forms/surface-results', async (c) => {
  return c.json<UiResponse>({ showToast: 'Done.' })
})

// Mod queue action: "Strata: Similar prior decisions"
// Mirrors the on-demand pattern check for queue items so mods can see precedent
// before acting on a user report. Renders results in a read-only Devvit form.
app.post('/internal/menu/similar-decisions', async (c) => {
  const request = await c.req.json<MenuItemRequest>()
  const postId = context.postId || request.targetId
  const commentId = context.commentId
  const targetId = commentId || postId
  if (!targetId) return c.json<UiResponse>({ showToast: 'No post or comment context.' })

  try {
    const engine = await getEngine()
    let item = await engine.getItem(targetId)

    if (!item) {
      if (commentId) {
        const comment = await reddit.getCommentById(commentId)
        item = await engine.ingest({
          id: commentId, type: 'comment', text: comment.body,
          authorId: comment.authorName || 'unknown', authorName: comment.authorName || 'unknown',
          createdAt: Date.now(), threadRootId: postId || commentId, parentId: comment.parentId || null,
        })
      } else if (postId) {
        const post = await reddit.getPostById(postId as `t3_${string}`)
        item = await engine.ingest({
          id: postId, type: 'post',
          text: post.body ? `${post.title}\n\n${post.body}` : post.title,
          authorId: post.authorName || 'unknown', authorName: post.authorName || 'unknown',
          createdAt: Date.now(), threadRootId: postId, parentId: null,
        })
      }
    }
    if (!item) return c.json<UiResponse>({ showToast: 'Could not load item.' })
    if (item.embedding.length === 0) return c.json<UiResponse>({ showToast: 'Item has no embedding yet.' })

    const hits = await engine.findSimilar(item.embedding, 10, {
      decision: ['removed'],
      excludeIds: new Set([item.id]),
    })
    const strong = hits.filter(h => h.weight >= 0.4)
    if (strong.length === 0) {
      return c.json<UiResponse>({ showToast: 'No similar prior removals found.' })
    }

    let recLine = ''
    try {
      const rules = await store.getRules()
      const result = await engine.recommendDecision(item, strong, rules)
      const verb = result.recommendation === 'remove' ? 'Remove'
        : result.recommendation === 'approve' ? 'Approve' : 'Insufficient signal'
      recLine = `Recommendation: ${verb}${result.ruleId ? ` (${result.ruleId})` : ''}\n\n${result.rationale}`
    } catch (err) {
      console.error('[Strata] similar-decisions recommendDecision failed:', err)
      recLine = `Recommendation unavailable: ${err}`
    }

    return c.json<UiResponse>({
      showForm: {
        name: 'similarDecisionsResults',
        form: {
          title: `Strata: ${strong.length} similar prior removal${strong.length === 1 ? '' : 's'}`,
          fields: [
            { name: 'rec', label: 'Recommendation', type: 'paragraph' as const, defaultValue: recLine },
            ...strong.slice(0, 5).map((h, i) => ({
              name: `precedent${i}`,
              label: `${(h.weight * 100).toFixed(0)}% — u/${h.item.authorName} · ${new Date(h.item.createdAt).toLocaleDateString()}${h.item.decisionReason ? ` · ${h.item.decisionReason}` : ''}`,
              type: 'paragraph' as const,
              defaultValue: (h.item.title ? `${h.item.title}\n\n` : '') + h.item.text.slice(0, 400),
            })),
          ],
        },
      },
    })
  } catch (err) {
    console.error('[Strata] similar-decisions error:', err)
    return c.json<UiResponse>({ showToast: `Error: ${err}` })
  }
})

app.post('/internal/forms/similar-decisions-results', async (c) => {
  return c.json<UiResponse>({ showToast: 'Done.' })
})

// --- Ingest ---


// --- Scheduler: Poll Batch Status ---

// Devvit caps outbound bytes per app per domain. Submit the backfill in chunks
// small enough to fit one egress window; the scheduler advances chunk-by-chunk
// and backs off when the cap is hit, so arbitrarily large backfills complete
// over time instead of failing.
const INGEST_CHUNK_SIZE = 500
const INGEST_POLL_MS = 120_000
const EGRESS_BACKOFF_MAX_MS = 60 * 60_000
const EGRESS_BACKOFF_MIN_MS = 60_000

function parseRetryAfterMs(err: unknown): number | null {
  const text = flattenError(err).toLowerCase()
  const m = text.match(/retry after\s+(?:([0-9.]+)\s*h)?\s*(?:([0-9.]+)\s*m)?\s*(?:([0-9.]+)\s*s)?/)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  const h = parseFloat(m[1] || '0'), min = parseFloat(m[2] || '0'), s = parseFloat(m[3] || '0')
  const ms = (h * 3600 + min * 60 + s) * 1000
  return ms > 0 ? Math.min(EGRESS_BACKOFF_MAX_MS, Math.max(EGRESS_BACKOFF_MIN_MS, ms)) : null
}

function isEgressOrRateError(err: unknown): boolean {
  const text = flattenError(err).toLowerCase()
  return text.includes('http_egress_bytes') || text.includes('rate limit') || text.includes('429') || text.includes('connection error')
}

app.post('/internal/scheduler/ingest-batch', async (c) => {
  try {
    const status = await redis.hGetAll('strata:ingest:status')
    if (!status.phase || status.phase === 'done' || status.phase === 'error' || status.phase === 'cancelled') {
      return c.json({ status: 'ok' })
    }

    const apiKey = await getOpenAIKey()
    if (!apiKey) { console.warn('[Strata] ingest-batch: no API key, skipping'); return c.json({ status: 'ok' }) }
    const openai = new OpenAI({ apiKey })

    // --- Real-time path ---
    if (status.mode === 'realtime' && status.phase === 'realtime-ingest') {
      const order: string[] = JSON.parse((await redis.get('strata:ingest:order')) || '[]')
      const processedSoFar = parseInt(status.processed || '0', 10)
      const totalItems = parseInt(status.totalItems || '0', 10)

      const chunkIds = order.slice(processedSoFar, processedSoFar + RT_ITEMS_PER_TICK)
      if (chunkIds.length === 0) {
        await redis.del('strata:ingest:raw')
        await redis.del('strata:ingest:order')
        await redis.hSet('strata:ingest:status', { phase: 'clustering', processed: String(processedSoFar), lastPolledAt: String(Date.now()) })
        await redis.set('strata:backfill:complete', '1')
        if (status.backfillId) await updateBackfillRecord(status.backfillId, { processed: processedSoFar })
        console.log(`[Strata] Real-time ingest complete: ${processedSoFar} items, starting recluster`)
        try {
          await scheduler.runJob({ name: 'recluster', runAt: new Date(Date.now() + 1000), data: { fromBackfill: true } })
        } catch (err) { console.error('[Strata] Post-backfill recluster schedule failed:', err) }
        return c.json({ status: 'ok' })
      }

      const chunkRaw: RawItem[] = []
      for (const id of chunkIds) {
        const v = await redis.hGet('strata:ingest:raw', id)
        if (v) chunkRaw.push(JSON.parse(v))
      }

      try {
        const result = await ingestChunkRealTime(openai, redis, chunkRaw)
        invalidateItemCache()
        await recordUsage('text-embedding-3-small', { inputTokens: result.usage.embedInputTokens, outputTokens: 0 })
        await recordUsage('gpt-5.4-mini', { inputTokens: result.usage.extractInputTokens, outputTokens: result.usage.extractOutputTokens })
        const newProcessed = processedSoFar + result.stored
        await redis.hSet('strata:ingest:status', { processed: String(newProcessed), lastPolledAt: String(Date.now()) })
        if (status.backfillId) await updateBackfillRecord(status.backfillId, { processed: newProcessed })
        console.log(`[Strata] Real-time tick: ${newProcessed}/${totalItems} items`)
      } catch (err) {
        console.warn(`[Strata] Real-time tick failed (transient), retrying: ${err}`)
      }
      await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + RT_TICK_SPACING_MS), data: {} })
      return c.json({ status: 'ok' })
    }

    // --- Batch path ---
    const phase = status.phase as string
    const chunkIndex = parseInt(status.chunkIndex || '0', 10)
    const chunkCount = parseInt(status.chunkCount || '1', 10)
    const processedSoFar = parseInt(status.processed || '0', 10)
    const order: string[] = JSON.parse((await redis.get('strata:ingest:order')) || '[]')
    const chunkIds = order.slice(chunkIndex * INGEST_CHUNK_SIZE, (chunkIndex + 1) * INGEST_CHUNK_SIZE)

    const loadChunkRaw = async (): Promise<RawItem[]> => {
      const out: RawItem[] = []
      for (const id of chunkIds) {
        const v = await redis.hGet('strata:ingest:raw', id)
        if (v) out.push(JSON.parse(v))
      }
      return out
    }

    // --- Submit the current chunk's embed + extract batches (egress-gated) ---
    if (phase === 'submit') {
      const chunkRaw = await loadChunkRaw()
      const normalizedItems = chunkRaw.map(r => ({ id: r.id, text: normalize(r.title ? `${r.title}\n\n${r.text}` : r.text) }))
      try {
        const embJsonl = buildEmbeddingJsonl(normalizedItems)
        const extractJsonl = buildExtractionJsonl(normalizedItems)
        console.log(`[Strata] Chunk ${chunkIndex + 1}/${chunkCount} JSONL sizes: emb=${(embJsonl.length / 1024).toFixed(1)}KB, extract=${(extractJsonl.length / 1024).toFixed(1)}KB (${normalizedItems.length} items)`)
        const [embBatchId, extractBatchId] = await Promise.all([
          submitBatch(openai, embJsonl, '/v1/embeddings', 'ingest-emb.jsonl'),
          submitBatch(openai, extractJsonl, '/v1/responses', 'ingest-extract.jsonl'),
        ])
        await redis.hSet('strata:ingest:status', {
          phase: 'embedding', embBatchId, extractBatchId,
          embCompleted: '0', embTotal: String(chunkRaw.length),
          extractCompleted: '0', extractTotal: String(chunkRaw.length),
          lastPolledAt: String(Date.now()),
        })
        console.log(`[Strata] Chunk ${chunkIndex + 1}/${chunkCount} submitted (${chunkRaw.length} items)`)
        await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + INGEST_POLL_MS), data: {} })
      } catch (err) {
        if (isEgressOrRateError(err)) {
          const backoff = parseRetryAfterMs(err) ?? EGRESS_BACKOFF_MIN_MS
          await redis.hSet('strata:ingest:status', { waitingUntil: String(Date.now() + backoff), lastError: 'egress' })
          console.warn(`[Strata] Chunk ${chunkIndex + 1}: egress limit, retrying in ${Math.round(backoff / 1000)}s`)
          await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + backoff), data: {} })
        } else {
          throw err
        }
      }
      return c.json({ status: 'ok' })
    }

    if (phase === 'embedding' || phase === 'extracting') {
      const embStatus = await checkBatch(openai, status.embBatchId)
      const extractStatus = await checkBatch(openai, status.extractBatchId)
      console.log(`[Strata] Chunk ${chunkIndex + 1}/${chunkCount} poll: emb=${embStatus.status}(${embStatus.completed}/${embStatus.total}), extract=${extractStatus.status}(${extractStatus.completed}/${extractStatus.total})`)

      await redis.hSet('strata:ingest:status', {
        embCompleted: String(embStatus.completed),
        embTotal: String(embStatus.total || chunkIds.length),
        extractCompleted: String(extractStatus.completed),
        extractTotal: String(extractStatus.total || chunkIds.length),
        lastPolledAt: String(Date.now()),
      })

      if (embStatus.status === 'failed' || extractStatus.status === 'failed') {
        const endedAt = Date.now()
        await redis.hSet('strata:ingest:status', { phase: 'error', error: 'Batch failed', endedAt: String(endedAt) })
        if (status.backfillId) await updateBackfillRecord(status.backfillId, { status: 'error', endedAt, error: 'Batch failed' })
        return c.json({ status: 'ok' })
      }

      if (embStatus.status === 'completed' && extractStatus.status === 'completed') {
        const [embResults, extractResults] = await Promise.all([
          downloadBatchResults(openai, embStatus.outputFileId!),
          downloadBatchResults(openai, extractStatus.outputFileId!),
        ])
        const embeddings = parseEmbeddingResults(embResults)
        const entities = parseExtractionResults(extractResults)
        await redis.set('strata:ingest:embeddings', JSON.stringify([...embeddings.entries()]))
        await redis.set('strata:ingest:entities', JSON.stringify([...entities.entries()]))

        const entityItems: Array<{ id: string; text: string }> = []
        for (const [itemId, ents] of entities) for (const e of ents) entityItems.push({ id: `${itemId}:${e.surfaceText}`, text: e.surfaceText })

        if (entityItems.length > 0) {
          try {
            const entityEmbBatchId = await submitBatch(openai, buildEntityEmbeddingJsonl(entityItems), '/v1/embeddings', 'ingest-entity-emb.jsonl')
            await redis.hSet('strata:ingest:status', { phase: 'entity-embedding', entityEmbBatchId })
          } catch (err) {
            if (isEgressOrRateError(err)) {
              const backoff = parseRetryAfterMs(err) ?? EGRESS_BACKOFF_MIN_MS
              console.warn(`[Strata] Entity-emb submit: egress limit, retrying in ${Math.round(backoff / 1000)}s`)
              await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + backoff), data: {} })
              return c.json({ status: 'ok' })
            }
            throw err
          }
        } else {
          await redis.hSet('strata:ingest:status', { phase: 'storing' })
        }
        await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + INGEST_POLL_MS), data: {} })
        return c.json({ status: 'ok' })
      }

      await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + INGEST_POLL_MS), data: {} })
      return c.json({ status: 'ok' })
    }

    if (phase === 'entity-embedding') {
      const entEmbStatus = await checkBatch(openai, status.entityEmbBatchId)
      console.log(`[Strata] Chunk ${chunkIndex + 1}/${chunkCount} entity-emb: ${entEmbStatus.status}(${entEmbStatus.completed}/${entEmbStatus.total})`)
      await redis.hSet('strata:ingest:status', { entCompleted: String(entEmbStatus.completed), entTotal: String(entEmbStatus.total || 0), lastPolledAt: String(Date.now()) })

      if (entEmbStatus.status === 'failed') {
        const endedAt = Date.now()
        await redis.hSet('strata:ingest:status', { phase: 'error', error: 'Entity embedding batch failed', endedAt: String(endedAt) })
        if (status.backfillId) await updateBackfillRecord(status.backfillId, { status: 'error', endedAt, error: 'Entity embedding batch failed' })
        return c.json({ status: 'ok' })
      }
      if (entEmbStatus.status === 'completed') {
        await redis.hSet('strata:ingest:status', { phase: 'storing' })
      } else {
        await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + INGEST_POLL_MS), data: {} })
        return c.json({ status: 'ok' })
      }
    }

    if (status.phase === 'storing' || phase === 'entity-embedding') {
      console.log(`[Strata] Storing chunk ${chunkIndex + 1}/${chunkCount}...`)
      const chunkRaw = await loadChunkRaw()
      const embeddings = new Map<string, number[]>(JSON.parse((await redis.get('strata:ingest:embeddings')) || '[]'))
      const entities = new Map<string, Entity[]>(JSON.parse((await redis.get('strata:ingest:entities')) || '[]'))

      let entityEmbeddings = new Map<string, number[]>()
      if (status.entityEmbBatchId) {
        const entEmbStatus = await checkBatch(openai, status.entityEmbBatchId)
        if (entEmbStatus.outputFileId) {
          entityEmbeddings = parseEmbeddingResults(await downloadBatchResults(openai, entEmbStatus.outputFileId))
        }
      }

      const stored = await storeResults(store, chunkRaw, embeddings, entities, entityEmbeddings)
      invalidateItemCache()
      const totalStored = processedSoFar + stored

      // Per-chunk temp cleanup (raw + order kept until all chunks done)
      await redis.del('strata:ingest:embeddings')
      await redis.del('strata:ingest:entities')

      const nextChunk = chunkIndex + 1
      if (nextChunk < chunkCount) {
        await redis.hSet('strata:ingest:status', {
          phase: 'submit',
          chunkIndex: String(nextChunk),
          processed: String(totalStored),
          entityEmbBatchId: '',
        })
        if (status.backfillId) await updateBackfillRecord(status.backfillId, { processed: totalStored })
        console.log(`[Strata] Chunk ${chunkIndex + 1} stored (${stored}). ${totalStored}/${status.totalItems} done. Next chunk queued.`)
        await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + 3000), data: {} })
        return c.json({ status: 'ok' })
      }

      // All chunks done.
      await redis.del('strata:ingest:raw')
      await redis.del('strata:ingest:order')
      const endedAt = Date.now()
      await redis.hSet('strata:ingest:status', { phase: 'done', processed: String(totalStored), endedAt: String(endedAt) })
      await redis.set('strata:backfill:complete', '1')
      if (status.backfillId) {
        await updateBackfillRecord(status.backfillId, { status: 'done', endedAt, totalItems: totalStored, processed: totalStored })
      }
      console.log(`[Strata] Ingest complete: ${totalStored} items stored across ${chunkCount} chunk(s)`)

      try {
        const scanId = generateAlertId()
        const scanStartedAt = Date.now()
        await redis.hSet('strata:scan:status', {
          phase: 'building',
          startedAt: String(scanStartedAt),
          scanId,
          anchorsProcessed: '0',
          anchorsTotal: '0',
        })
        await putScanRecord({
          id: scanId, status: 'running', startedAt: scanStartedAt, endedAt: null,
          anchorsTotal: 0, anchorsProcessed: 0, alertsCreated: 0,
          autoTriggered: true, initiatedBy: 'auto-scan',
        })
        await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 1000), data: { step: 'build' } })
        console.log('[Strata] Auto-scan scheduled after backfill')
        try {
          await scheduler.runJob({ name: 'recluster', runAt: new Date(Date.now() + 5000), data: {} })
          console.log('[Strata] Recluster scheduled after backfill')
        } catch (err) {
          console.error('[Strata] Recluster schedule failed:', err)
        }
      } catch (err) {
        console.error('[Strata] Auto-scan schedule failed:', err)
      }
    }
  } catch (err) {
    console.error('[Strata] Ingest poll error:', err)
    const status = await redis.hGetAll('strata:ingest:status')
    const endedAt = Date.now()
    await redis.hSet('strata:ingest:status', { phase: 'error', error: String(err), endedAt: String(endedAt) })
    if (status?.backfillId) {
      await updateBackfillRecord(status.backfillId, { status: 'error', endedAt, error: String(err) })
    }
  }

  return c.json({ status: 'ok' })
})

// --- Scan ---

app.post('/internal/scheduler/scan', async (c) => {
  const input = await c.req.json<any>()
  const step = input.data?.step as string

  try {
    const status = await redis.hGetAll('strata:scan:status')
    if (status?.phase === 'cancelled') {
      await redis.del('strata:scan:pairs')
      await redis.del('strata:scan:new-alert-ids')
      return c.json({ status: 'ok' })
    }

    if (step === 'build') {
      const pairs = await buildScanPairs(store)
      if (pairs.length === 0) {
        const endedAt = Date.now()
        await redis.hSet('strata:scan:status', { phase: 'done', alerts: '0', endedAt: String(endedAt), anchorsTotal: '0', anchorsProcessed: '0' })
        if (status?.scanId) await updateScanRecord(status.scanId, { status: 'done', endedAt, anchorsTotal: 0, anchorsProcessed: 0, alertsCreated: 0 })
        console.log('[Strata] Scan: no candidate pairs found')
        return c.json({ status: 'ok' })
      }

      await redis.set('strata:scan:pairs', JSON.stringify(pairs.map(p => ({
        ...p,
        entitiesByItem: Object.fromEntries(p.entitiesByItem),
      }))))
      await redis.hSet('strata:scan:status', {
        phase: 'classifying',
        anchorsTotal: String(pairs.length),
        anchorsProcessed: '0',
      })
      if (status?.scanId) await updateScanRecord(status.scanId, { anchorsTotal: pairs.length })
      await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 1000), data: { step: 'classify', index: 0 } })
      console.log(`[Strata] Scan: ${pairs.length} anchor groups, classifying...`)
    }

    if (step === 'classify') {
      const index = input.data?.index as number
      const pairsJson = await redis.get('strata:scan:pairs')
      if (!pairsJson) return c.json({ status: 'ok' })
      const rawPairs = JSON.parse(pairsJson) as Array<any>
      const pairs: ScanPair[] = rawPairs.map(p => ({
        ...p,
        entitiesByItem: new Map(Object.entries(p.entitiesByItem ?? {})),
      }))

      const finalizeScan = async () => {
        const idsJson = await redis.get('strata:scan:new-alert-ids') || '[]'
        const ids: string[] = JSON.parse(idsJson)
        await redis.del('strata:scan:pairs')
        await redis.del('strata:scan:new-alert-ids')
        const endedAt = Date.now()
        await redis.hSet('strata:scan:status', {
          phase: 'done',
          alerts: String(ids.length),
          endedAt: String(endedAt),
          anchorsProcessed: String(pairs.length),
        })
        if (status?.scanId) await updateScanRecord(status.scanId, {
          status: 'done', endedAt, anchorsProcessed: pairs.length, alertsCreated: ids.length,
        })
        console.log(`[Strata] Scan complete: ${ids.length} alerts created`)
        if (ids.length > 0 && context.subredditName) {
          try {
            await sendSurfaceDigest(context.subredditName, ids)
          } catch (err) {
            console.error('[Strata] Scan digest modmail failed:', err)
          }
        }
      }

      if (index >= pairs.length) {
        await finalizeScan()
        return c.json({ status: 'ok' })
      }

      // Classify up to 4 anchor groups in parallel per tick (~7s each, fits in 30s)
      const PARALLEL = 4
      const batch = pairs.slice(index, index + PARALLEL)
      const engine = await getEngine()
      const subredditName = context.subredditName || ''

      const results = await Promise.all(
        batch.map(pair => classifyAndCreateAlerts(
          [pair],
          (id) => engine.getItem(id),
          (anchor, candidates) => engine.classifyBatch(anchor, candidates),
          alertStore,
          subredditName,
          buildPermalink,
          generateAlertId,
        ))
      )

      const batchIds = results.flat()
      if (batchIds.length > 0) {
        const existing: string[] = JSON.parse(await redis.get('strata:scan:new-alert-ids') || '[]')
        await redis.set('strata:scan:new-alert-ids', JSON.stringify([...existing, ...batchIds]))
        console.log(`[Strata] Scan: ${batchIds.length} alert(s) from ${batch.length} anchors`)
      }

      const nextIndex = index + PARALLEL
      const idsSoFar: string[] = JSON.parse(await redis.get('strata:scan:new-alert-ids') || '[]')
      await redis.hSet('strata:scan:status', {
        anchorsProcessed: String(Math.min(nextIndex, pairs.length)),
        alerts: String(idsSoFar.length),
      })
      if (status?.scanId) {
        await updateScanRecord(status.scanId, {
          anchorsProcessed: Math.min(nextIndex, pairs.length),
          alertsCreated: idsSoFar.length,
        })
      }

      if (nextIndex < pairs.length) {
        await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 2000), data: { step: 'classify', index: nextIndex } })
      } else {
        await finalizeScan()
      }
    }
  } catch (err) {
    console.error('[Strata] Scan scheduler error:', err)
    const endedAt = Date.now()
    const status = await redis.hGetAll('strata:scan:status')
    await redis.hSet('strata:scan:status', { phase: 'error', error: String(err), endedAt: String(endedAt) })
    if (status?.scanId) await updateScanRecord(status.scanId, { status: 'error', endedAt, error: String(err) })
  }

  return c.json({ status: 'ok' })
})

// --- API ---

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/viewer') return next()
  const ok = await isMod(context.userId, context.subredditName ?? '')
  if (!ok) return c.json({ error: 'Forbidden' }, 403)
  return next()
})

const API_KEY_INVALID_FLAG = 'strata:apikey:invalid'

function isOpenAIAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: number; code?: string; message?: string }
  if (e.status === 401) return true
  if (e.code === 'invalid_api_key') return true
  const msg = (e.message || '').toLowerCase()
  return msg.includes('incorrect api key') || msg.includes('invalid api key') || msg.includes('invalid_api_key')
}

// OpenAI SDK wraps Devvit's gRPC errors as a vague "Connection error." with the
// real detail buried in err.cause.details. Flatten the whole chain to text.
function flattenError(err: unknown): string {
  const parts: string[] = []
  let cur: any = err
  let depth = 0
  while (cur && depth < 5) {
    if (typeof cur === 'string') { parts.push(cur); break }
    if (cur.message) parts.push(String(cur.message))
    if (cur.details) parts.push(String(cur.details))
    cur = cur.cause
    depth++
  }
  return parts.join(' | ')
}

// Returns a human-readable message for known failure modes, or null.
function describeOpenAIError(err: unknown): string | null {
  const text = flattenError(err).toLowerCase()
  if (text.includes('http_egress_bytes') || (text.includes('rate limit') && text.includes('egress'))) {
    const m = text.match(/retry after\s+([0-9hm.\s]+s)/)
    const when = m ? m[1].trim() : 'a while'
    return `Reddit's outbound-data limit was hit (too much sent to OpenAI at once). Try a smaller date range. Retry in ${when}.`
  }
  if (text.includes('rate limit') || text.includes('429') || text.includes('rate_limit_exceeded')) {
    return 'OpenAI rate limit reached. Wait a minute and retry, or use a smaller date range.'
  }
  if (text.includes('insufficient_quota') || text.includes('exceeded your current quota')) {
    return 'Your OpenAI key has no remaining quota. Check billing on the OpenAI dashboard.'
  }
  if (isOpenAIAuthError(err)) return 'Your OpenAI key was rejected. Update it in settings.'
  if (text.includes('connection error') || text.includes('timeout') || text.includes('etimedout')) {
    return 'Connection to OpenAI failed. Retry; if it persists, the request may be too large — use a smaller date range.'
  }
  return null
}

async function noteOpenAIError(err: unknown): Promise<void> {
  if (isOpenAIAuthError(err)) {
    try { await redis.set(API_KEY_INVALID_FLAG, '1') } catch {}
  }
}

async function clearApiKeyInvalid(): Promise<void> {
  try { await redis.del(API_KEY_INVALID_FLAG) } catch {}
}

app.get('/api/stats', async (c) => {
  const itemCount = await store.getItemCount()
  const seeded = await redis.get('strata:seed:complete') || '0'
  const installed = await redis.get('strata:installed') || '0'
  const apiKey = await getOpenAIKey()
  const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0
  const apiKeyInvalid = hasApiKey && (await redis.get(API_KEY_INVALID_FLAG)) === '1'
  return c.json({ itemCount, capacity: 330_000, seeded, installed, hasApiKey, apiKeyInvalid })
})

app.post('/api/apikey/recheck', async (c) => {
  await clearApiKeyInvalid()
  return c.json({ ok: true })
})

app.post('/api/apikey', async (c) => {
  const body = await c.req.json<{ key?: string }>().catch(() => ({} as { key?: string }))
  const key = (body.key ?? '').trim()
  if (!key) return c.json({ error: 'Key required' }, 400)

  const secret = await settings.get('strataEncryptionKey')
  if (typeof secret !== 'string' || !secret) {
    return c.json({ error: 'Server not configured (missing encryption key). Contact the app developer.' }, 500)
  }

  try {
    const probe = new OpenAI({ apiKey: key })
    await probe.models.list()
  } catch (err) {
    if (isOpenAIAuthError(err)) return c.json({ error: 'invalid_api_key' }, 401)
    return c.json({ error: `Validation failed: ${String(err)}` }, 400)
  }

  await redis.set(OPENAI_KEY_REDIS, encrypt(key, secret))
  await clearApiKeyInvalid()
  return c.json({ ok: true })
})

app.delete('/api/apikey', async (c) => {
  await redis.del(OPENAI_KEY_REDIS)
  await clearApiKeyInvalid()
  return c.json({ ok: true })
})

app.get('/api/usage', async (c) => {
  return c.json(await getUsageSummary())
})

app.get('/api/community-context', async (c) => {
  const text = (await redis.get('strata:community-context')) ?? ''
  return c.json({ text })
})

app.post('/api/community-context', async (c) => {
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }))
  const text = ((body as { text?: string }).text ?? '').slice(0, 2000)
  if (text.trim().length === 0) {
    await redis.del('strata:community-context')
  } else {
    await redis.set('strata:community-context', text)
  }
  return c.json({ ok: true })
})

app.post('/api/chat', async (c) => {
  const apiKey = await getOpenAIKey()
  if (!apiKey || typeof apiKey !== 'string') return c.json({ error: 'No API key' }, 500)
  const openai = new OpenAI({ apiKey })

  const community = (await redis.get('strata:community-context')) ?? ''

  const ids = await store.getItemIds()
  const items = (await Promise.all(ids.map(id => store.getItem(id)))).filter((x): x is StoredItem => !!x)
  const itemMap = new Map(items.map(i => [i.id, i]))
  const embMap = await store.getEmbeddings(ids)

  const repo = new ClusterRepo(redis)
  const clusterRows = await repo.listBySize(500)
  const clusterLabelById = new Map<number, string>()
  for (const row of clusterRows) clusterLabelById.set(row.id, row.label)

  const handler = createChatHandler({
    openai,
    subreddit: context.subredditName,
    communityContext: community.trim() || undefined,
    getAllItems: async () => items,
    getItem: async (id) => itemMap.get(id) ?? null,
    getEmbedding: (id) => embMap.get(id) ?? null,
    clusterLabelById,
    listAlerts: opts => alertStore.listAlerts(opts),
    getAlert: id => alertStore.getAlert(id),
    getAlertConnections: id => alertStore.getAlertConnections(id),
  })
  return handler(c)
})

app.get('/api/clusters', async (c) => {
  const repo = new ClusterRepo(redis)
  const rows = await repo.listBySize(500)
  const allItems = await getAllItems()
  const postsByCluster = new Map<number, number>()
  const commentsByCluster = new Map<number, number>()
  const lastActivityByCluster = new Map<number, number>()
  const recent24h = Date.now() - 86_400_000
  const recentByCluster = new Map<number, number>()
  for (const it of allItems) {
    if (it.clusterId === undefined || it.clusterId === -1) continue
    if (it.type === 'post') postsByCluster.set(it.clusterId, (postsByCluster.get(it.clusterId) ?? 0) + 1)
    else commentsByCluster.set(it.clusterId, (commentsByCluster.get(it.clusterId) ?? 0) + 1)
    lastActivityByCluster.set(it.clusterId, Math.max(lastActivityByCluster.get(it.clusterId) ?? 0, it.createdAt))
    if (it.createdAt >= recent24h) recentByCluster.set(it.clusterId, (recentByCluster.get(it.clusterId) ?? 0) + 1)
  }
  const now = Date.now()
  return c.json({ clusters: rows.map(r => {
    const lastActivity = lastActivityByCluster.get(r.id) ?? 0
    const ageHours = lastActivity > 0 ? (now - lastActivity) / 3_600_000 : 999
    const hotScore = r.size / (1 + ageHours)
    return {
      id: `cluster:${r.id}`,
      label: r.label,
      isOrphan: r.size <= 1,
      postCount: postsByCluster.get(r.id) ?? 0,
      commentCount: commentsByCluster.get(r.id) ?? 0,
      recentCount: recentByCluster.get(r.id) ?? 0,
      lastActivity,
      hotScore,
    }
  }) })
})

async function getClusterConfig(): Promise<{ resolution: number; minClusterSize: number }> {
  const raw = await redis.hGetAll('strata:cluster:config')
  const resolution = raw?.resolution ? parseFloat(raw.resolution) : LOUVAIN_RESOLUTION
  const minClusterSize = raw?.minClusterSize ? parseInt(raw.minClusterSize, 10) : MIN_CLUSTER_SIZE
  return {
    resolution: Number.isFinite(resolution) ? Math.max(0.1, Math.min(3.0, resolution)) : LOUVAIN_RESOLUTION,
    minClusterSize: Number.isFinite(minClusterSize) ? Math.max(2, Math.min(100, minClusterSize)) : MIN_CLUSTER_SIZE,
  }
}

async function runReclusterAndRecord(): Promise<{ ok: true; report: Awaited<ReturnType<typeof runRecluster>> } | { ok: false; error: string; auth: boolean }> {
  const apiKey = await getOpenAIKey()
  if (!apiKey || typeof apiKey !== 'string') return { ok: false, error: 'No API key', auth: false }
  const openai = new OpenAI({ apiKey: apiKey as string })
  const config = await getClusterConfig()
  try {
    const report = await runRecluster(store, redis, openai, config)
    await redis.hSet('strata:cluster:status', {
      lastRun: String(Date.now()),
      totalItems: String(report.totalItems),
      clusters: String(report.clusters),
      orphans: String(report.orphans),
      relabeled: String(report.relabeled),
      elapsedMs: String(report.elapsedMs),
    })
    await redis.set('strata:cluster:ingest-counter', '0')
    return { ok: true, report }
  } catch (err) {
    await noteOpenAIError(err)
    return { ok: false, error: String(err), auth: isOpenAIAuthError(err) }
  }
}

app.post('/internal/scheduler/recluster', async (c) => {
  const input = await c.req.json<{ data?: { fromBackfill?: boolean } }>().catch(() => ({ data: undefined }))
  const body = { fromBackfill: input.data?.fromBackfill ?? false }
  const result = await runReclusterAndRecord()
  if (!result.ok) {
    console.error('[Strata] Recluster failed:', result.error)
    if (body.fromBackfill) {
      const endedAt = Date.now()
      const ingestStatus = await redis.hGetAll('strata:ingest:status')
      await redis.hSet('strata:ingest:status', { phase: 'done', endedAt: String(endedAt) })
      if (ingestStatus?.backfillId) await updateBackfillRecord(ingestStatus.backfillId, { status: 'done', endedAt, totalItems: parseInt(ingestStatus.processed || '0'), processed: parseInt(ingestStatus.processed || '0') })
      console.log('[Strata] Backfill complete (recluster failed, continuing)')
    }
    return c.json({ error: result.error })
  }
  await redis.del('strata:graph:layout')
  invalidateItemCache()
  console.log('[Strata] Recluster:', result.report)
  if (body.fromBackfill) {
    const endedAt = Date.now()
    const ingestStatus = await redis.hGetAll('strata:ingest:status')
    await redis.hSet('strata:ingest:status', { phase: 'done', endedAt: String(endedAt) })
    if (ingestStatus?.backfillId) await updateBackfillRecord(ingestStatus.backfillId, { status: 'done', endedAt, totalItems: parseInt(ingestStatus.processed || '0'), processed: parseInt(ingestStatus.processed || '0') })
    console.log('[Strata] Backfill complete (processing + clustering)')
    try {
      const scanId = generateAlertId()
      await redis.hSet('strata:scan:status', { phase: 'building', startedAt: String(Date.now()), scanId, anchorsProcessed: '0', anchorsTotal: '0' })
      await putScanRecord({ id: scanId, status: 'running', startedAt: Date.now(), endedAt: null, anchorsTotal: 0, anchorsProcessed: 0, alertsCreated: 0, autoTriggered: true, initiatedBy: 'auto-scan' })
      await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 1000), data: { step: 'build' } })
    } catch (err) { console.error('[Strata] Background scan schedule failed:', err) }
  }
  return c.json(result.report)
})

app.post('/api/clusters/recluster', async (c) => {
  const result = await runReclusterAndRecord()
  if (!result.ok) {
    if (result.auth) return c.json({ error: 'invalid_api_key' }, 401)
    return c.json({ error: result.error }, 500)
  }
  await redis.del('strata:graph:layout')
  invalidateItemCache()
  return c.json(result.report)
})

app.get('/api/clusters/config', async (c) => {
  const cfg = await getClusterConfig()
  return c.json({ ...cfg, defaults: { resolution: LOUVAIN_RESOLUTION, minClusterSize: MIN_CLUSTER_SIZE } })
})

app.post('/api/clusters/config', async (c) => {
  const body = await c.req.json<{ resolution?: number; minClusterSize?: number }>().catch(() => ({} as { resolution?: number; minClusterSize?: number }))
  const updates: Record<string, string> = {}
  if (typeof body.resolution === 'number' && Number.isFinite(body.resolution)) {
    updates.resolution = String(Math.max(0.1, Math.min(3.0, body.resolution)))
  }
  if (typeof body.minClusterSize === 'number' && Number.isFinite(body.minClusterSize)) {
    updates.minClusterSize = String(Math.max(2, Math.min(100, Math.round(body.minClusterSize))))
  }
  if (Object.keys(updates).length > 0) await redis.hSet('strata:cluster:config', updates)
  return c.json(await getClusterConfig())
})

app.get('/api/clusters/status', async (c) => {
  const status = await redis.hGetAll('strata:cluster:status')
  const counter = await redis.get('strata:cluster:ingest-counter')
  return c.json({
    lastRun: parseInt(status?.lastRun ?? '0', 10) || 0,
    totalItems: parseInt(status?.totalItems ?? '0', 10) || 0,
    clusters: parseInt(status?.clusters ?? '0', 10) || 0,
    orphans: parseInt(status?.orphans ?? '0', 10) || 0,
    relabeled: parseInt(status?.relabeled ?? '0', 10) || 0,
    elapsedMs: parseInt(status?.elapsedMs ?? '0', 10) || 0,
    pendingItems: counter ? parseInt(counter, 10) : 0,
  })
})

app.get('/api/clusters/:id', async (c) => {
  const raw = c.req.param('id').replace(/^cluster:/, '')
  const id = parseInt(raw, 10)
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const repo = new ClusterRepo(redis)
  const resolved = await repo.resolveAlias(id)
  const meta = await repo.getMeta(resolved)
  if (!meta) return c.json({ error: 'Not found' }, 404)
  const allItems = await getAllItems()
  const members = allItems.filter(it => it.clusterId === resolved)
  const posts = members.filter(it => it.type === 'post').sort((a, b) => b.createdAt - a.createdAt)
  const comments = members.filter(it => it.type === 'comment')
  return c.json({
    id: `cluster:${resolved}`,
    label: meta.label,
    postCount: posts.length,
    commentCount: comments.length,
    recentCount: members.filter(it => it.createdAt >= Date.now() - 86_400_000).length,
    lastActivity: members.reduce((m, it) => Math.max(m, it.createdAt), 0),
    posts: posts.slice(0, 200).map(p => ({
      id: p.id,
      type: p.type,
      title: p.title ?? null,
      text: p.text,
      author: p.authorName,
      createdAt: p.createdAt,
      permalink: null,
      commentCount: allItems.filter(it => it.threadRootId === p.id && it.type === 'comment').length,
    })),
  })
})

const RECLUSTER_VOLUME_RATIO = 0.05
const RECLUSTER_VOLUME_MIN = 50

async function bumpIngestCounter(): Promise<void> {
  try {
    const counter = await redis.get('strata:cluster:ingest-counter')
    const current = counter ? parseInt(counter, 10) : 0
    const next = current + 1
    await redis.set('strata:cluster:ingest-counter', String(next))
    const itemCount = await store.getItemCount()
    const threshold = Math.max(RECLUSTER_VOLUME_MIN, Math.floor(itemCount * RECLUSTER_VOLUME_RATIO))
    if (next >= threshold) {
      await redis.set('strata:cluster:ingest-counter', '0')
      await scheduler.runJob({ name: 'recluster', runAt: new Date(Date.now() + 30_000), data: {} })
      console.log(`[Strata] Recluster scheduled (volume threshold ${next}/${threshold})`)
    }
  } catch (err) {
    console.error('[Strata] Ingest counter bump failed:', err)
  }
}

const HUB_MIN_COUNT = 10
const HUB_RATIO = 0.03
const ENTITY_EMBED_SIM_THRESHOLD = 0.78
const STRING_ONLY_ENTITY_TYPES = new Set(['quantity', 'url', 'username', 'phone', 'email'])
import { UMAP } from 'umap-js'

function normalizeCoords(coords: number[][], n: number, clusterIds?: number[]): number[][] {
  // Center
  const d = coords[0]?.length ?? 3
  const center = new Array(d).fill(0)
  for (const p of coords) for (let i = 0; i < d; i++) center[i] += p[i]
  for (let i = 0; i < d; i++) center[i] /= n

  let result = coords.map(p => p.map((v, i) => v - center[i]))

  // If cluster info available, tighten clusters + spread centroids
  if (clusterIds && clusterIds.length === n) {
    const centroids = new Map<number, number[]>()
    const counts = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      const c = clusterIds[i]
      if (c === -1) continue
      if (!centroids.has(c)) { centroids.set(c, new Array(d).fill(0)); counts.set(c, 0) }
      const ct = centroids.get(c)!
      for (let j = 0; j < d; j++) ct[j] += result[i][j]
      counts.set(c, counts.get(c)! + 1)
    }
    for (const [c, ct] of centroids) {
      const cnt = counts.get(c)!
      for (let j = 0; j < d; j++) ct[j] /= cnt
    }

    const INTRA_SHRINK = 0.6
    const INTER_EXPAND = 1.8
    for (let i = 0; i < n; i++) {
      const c = clusterIds[i]
      if (c === -1) continue
      const ct = centroids.get(c)!
      for (let j = 0; j < d; j++) {
        const offset = result[i][j] - ct[j]
        result[i][j] = ct[j] * INTER_EXPAND + offset * INTRA_SHRINK
      }
    }
  }

  // Scale to target radius
  const targetRadius = 12 * Math.pow(n / 200, 1 / 3)
  let std = 0
  for (const p of result) for (const v of p) std += v * v
  std = Math.sqrt(std / (n * d)) || 1
  return result.map(p => p.map(v => (v / (std * 2)) * targetRadius))
}

function computeLayout(embeddings: number[][], n: number, clusterIds?: number[]): number[][] {
  if (n < 3) return embeddings.map(() => [0, 0, 0])
  const nNeighbors = Math.max(10, Math.min(50, Math.floor(Math.sqrt(n))))
  const umap = new UMAP({ nComponents: 3, nNeighbors, minDist: 0.5, spread: 2.0 })
  const coords = umap.fit(embeddings)
  return normalizeCoords(coords, n, clusterIds)
}

// --- In-memory item cache (persists across requests in Devvit's long-lived process) ---

let itemCache: StoredItem[] | null = null
let itemCacheById: Map<string, StoredItem> | null = null
let itemCacheAt = 0
const ITEM_CACHE_TTL_MS = 5 * 60_000

async function getAllItems(): Promise<StoredItem[]> {
  if (itemCache && Date.now() - itemCacheAt < ITEM_CACHE_TTL_MS) return itemCache
  const items: StoredItem[] = []
  let cursor = 0
  do {
    const scan = await redis.hScan('strata:items', cursor, undefined, 500)
    cursor = scan.cursor
    const entries = scan.fieldValues as any
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        try { items.push(JSON.parse(entry.value) as StoredItem) } catch {}
      }
    } else {
      for (const value of Object.values(entries)) {
        try { items.push(JSON.parse(value as string) as StoredItem) } catch {}
      }
    }
  } while (cursor !== 0)
  itemCache = items
  itemCacheById = new Map(items.map(i => [i.id, i]))
  itemCacheAt = Date.now()
  return items
}

function getItemFromCache(id: string): StoredItem | undefined {
  return itemCacheById?.get(id)
}

function invalidateItemCache() {
  itemCache = null
  itemCacheById = null
  itemCacheAt = 0
}

function addToItemCache(item: StoredItem) {
  if (!itemCache) return
  const existing = itemCacheById?.get(item.id)
  if (existing) {
    Object.assign(existing, item)
  } else {
    itemCache.push(item)
    itemCacheById?.set(item.id, item)
  }
}

async function listAllItemsSorted(): Promise<StoredItem[]> {
  const items: StoredItem[] = []
  let cursor: number | string = '+inf'
  while (true) {
    const entries = await redis.zRange('strata:idx:time', '-inf', cursor as any, {
      by: 'score', reverse: true, limit: { offset: 0, count: 500 },
    })
    if (entries.length === 0) break
    for (const e of entries) {
      const raw = await redis.hGet('strata:items', e.member)
      if (raw) items.push(JSON.parse(raw) as StoredItem)
    }
    cursor = entries[entries.length - 1].score - 1
    if (entries.length < 500) break
  }
  return items
}

async function listPostsSorted(limit = 500): Promise<StoredItem[]> {
  const posts: StoredItem[] = []
  let cursor: number | string = '+inf'
  while (posts.length < limit) {
    const entries = await redis.zRange('strata:idx:time', '-inf', cursor as any, {
      by: 'score', reverse: true, limit: { offset: 0, count: 200 },
    })
    if (entries.length === 0) break
    for (const e of entries) {
      if (posts.length >= limit) break
      const raw = await redis.hGet('strata:items', e.member)
      if (!raw) continue
      const item = JSON.parse(raw) as StoredItem
      if (item.type === 'post') posts.push(item)
    }
    cursor = entries[entries.length - 1].score - 1
    if (entries.length < 200) break
  }
  return posts
}

async function loadClusterLabelMap(): Promise<Map<number, string>> {
  const repo = new ClusterRepo(redis)
  const rows = await repo.listBySize(1000)
  const out = new Map<number, string>()
  for (const r of rows) out.set(r.id, r.label)
  return out
}

app.get('/api/items/:id/entity-matches', async (c) => {
  const id = c.req.param('id')
  const sourceItem = await store.getItem(id)
  if (!sourceItem || !sourceItem.entities?.length) return c.json({ matchedIds: [] })

  const totalItems = await store.getItemCount()
  const hubCounts = await store.getEntityHubCounts()
  const itemsPerType = new Map<string, number>()
  for (const [key, count] of hubCounts) {
    const type = key.split(':')[0]
    itemsPerType.set(type, (itemsPerType.get(type) ?? 0) + count)
  }
  const isHub = (type: string, surface: string) => {
    const count = hubCounts.get(`${type}:${surface.toLowerCase()}`) ?? 0
    if (count < HUB_MIN_COUNT) return false
    return count / (itemsPerType.get(type) ?? 1) > HUB_RATIO
  }

  const scores = new Map<string, number>()
  for (const e of sourceItem.entities) {
    if (!e.surfaceText || isHub(e.type, e.surfaceText)) continue
    const matches = await store.getItemIdsByEntity(e.type, e.surfaceText)
    if (matches.length <= 1) continue
    const idf = Math.log(totalItems / matches.length)
    for (const matchedId of matches) {
      if (matchedId === id) continue
      scores.set(matchedId, (scores.get(matchedId) ?? 0) + idf)
    }
  }

  const queriesByType = new Map<string, Array<{ surface: string; emb: number[] }>>()
  for (const e of sourceItem.entities) {
    if (!e.surfaceText || STRING_ONLY_ENTITY_TYPES.has(e.type)) continue
    if (isHub(e.type, e.surfaceText)) continue
    const bucket = await store.getEntityEmbeddingsByType(e.type)
    const found = bucket.find(b => b.itemId === id && b.surfaceText === e.surfaceText)
    if (!found) continue
    if (!queriesByType.has(e.type)) queriesByType.set(e.type, [])
    queriesByType.get(e.type)!.push({ surface: e.surfaceText, emb: dequantize(found.embedding) })
  }

  for (const [type, queries] of queriesByType) {
    const bucket = await store.getEntityEmbeddingsByType(type)
    for (const entry of bucket) {
      if (entry.itemId === id) continue
      if (isHub(type, entry.surfaceText)) continue
      const entryEmb = dequantize(entry.embedding)
      let best = 0
      for (const q of queries) {
        let sim = 0
        for (let i = 0; i < q.emb.length; i++) sim += q.emb[i] * entryEmb[i]
        if (sim > best) best = sim
      }
      if (best < ENTITY_EMBED_SIM_THRESHOLD) continue
      const idf = Math.log(totalItems / Math.max(1, bucket.length))
      const score = (best - ENTITY_EMBED_SIM_THRESHOLD) * 4 * idf
      scores.set(entry.itemId, Math.max(scores.get(entry.itemId) ?? 0, score))
    }
  }

  const postScores = new Map<string, number>()
  for (const [itemId, score] of scores) {
    const it = await store.getItem(itemId)
    if (!it) continue
    const postId = it.type === 'post' ? itemId : it.threadRootId
    if (postId === id) continue
    postScores.set(postId, Math.max(postScores.get(postId) ?? 0, score))
  }

  const sorted = [...postScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  return c.json({ matchedIds: sorted.map(([pid]) => pid) })
})

app.get('/api/threads/:postId', async (c) => {
  const postId = c.req.param('postId')
  const post = await store.getItem(postId)
  if (!post || post.type !== 'post') return c.json({ error: 'Not found' }, 404)
  const items = await listAllItemsSorted()
  const labelById = await loadClusterLabelMap()
  const sub = context.subredditName ?? 'reddit'
  const comments = items
    .filter(i => i.type === 'comment' && i.threadRootId === postId)
    .sort((a, b) => a.createdAt - b.createdAt)
  return c.json({
    post: {
      id: post.id,
      title: post.title ?? null,
      text: post.text,
      author: post.authorName,
      createdAt: post.createdAt,
      entities: (post.entities ?? []).filter(e => e.surfaceText).map(e => ({ text: e.surfaceText, clusterId: e.type })),
      clusterLabel: post.clusterId !== undefined && post.clusterId !== -1 ? (labelById.get(post.clusterId) ?? null) : null,
      replyCount: comments.length,
      permalink: `/r/${sub}/comments/${post.id.replace(/^t3_/, '')}/`,
    },
    comments: comments.map(cm => ({
      id: cm.id,
      kind: 'comment' as const,
      text: cm.text,
      author: cm.authorName,
      createdAt: cm.createdAt,
      created_at: cm.createdAt,
      thread_title: post.title ?? null,
      cluster_label: cm.clusterId !== undefined && cm.clusterId !== -1 ? (labelById.get(cm.clusterId) ?? null) : null,
      entities: (cm.entities ?? []).filter(e => e.surfaceText).map(e => ({ text: e.surfaceText, clusterId: e.type })),
    })),
  })
})

app.get('/api/graph', async (c) => {
  const items = await getAllItems()
  const labelById = await loadClusterLabelMap()
  const { alerts } = await alertStore.listAlerts({ limit: 1000 })
  const alertIncludeIds = new Set<string>()
  const threadTitleFromAlerts = new Map<string, string>()
  for (const a of alerts) {
    alertIncludeIds.add(a.anchorId)
    const conns = await alertStore.getAlertConnections(a.id)
    for (const conn of conns) {
      alertIncludeIds.add(conn.itemId)
      if (conn.type === 'comment' && conn.title) threadTitleFromAlerts.set(conn.itemId, conn.title)
    }
  }
  const titleById = new Map<string, string | null>()
  for (const i of items) if (i.type === 'post') titleById.set(i.id, i.title ?? null)
  const replyCount = new Map<string, number>()
  for (const i of items) if (i.parentId) replyCount.set(i.parentId, (replyCount.get(i.parentId) ?? 0) + 1)
  const maxReplies = Math.max(1, ...replyCount.values())

  const filteredItems = items.filter(i => i.type === 'post' || alertIncludeIds.has(i.id))

  let layoutMap = new Map<string, number[]>()
  const cachedLayout = await redis.get('strata:graph:layout')
  if (cachedLayout) {
    try {
      const parsed = JSON.parse(cachedLayout) as Array<[string, number[]]>
      layoutMap = new Map(parsed)
    } catch {}
  }

  const needsLayout = filteredItems.some(i => !layoutMap.has(i.id))
  if (needsLayout || layoutMap.size === 0) {
    const layoutIds = filteredItems.map(i => i.id)
    const embMap = await store.getEmbeddings(layoutIds)
    const validIds = layoutIds.filter(id => embMap.has(id))
    const validEmbs = validIds.map(id => embMap.get(id)!)
    const validClusterIds = validIds.map(id => {
      const item = filteredItems.find(i => i.id === id)
      return item?.clusterId ?? -1
    })
    console.log(`[Strata] /api/graph: computing UMAP for ${validEmbs.length} items...`)
    if (validEmbs.length > 2) {
      const t = Date.now()
      const positions = computeLayout(validEmbs, validEmbs.length, validClusterIds)
      console.log(`[Strata] /api/graph: UMAP done in ${Date.now() - t}ms`)
      for (let i = 0; i < validIds.length; i++) layoutMap.set(validIds[i], positions[i])
      await redis.set('strata:graph:layout', JSON.stringify([...layoutMap.entries()]))
    }
  }

  const nodes = filteredItems.map(i => {
    const pos = layoutMap.get(i.id) ?? [0, 0, 0]
    return {
      id: i.id,
      qualname: i.id,
      symbol_name: i.title ?? i.text.slice(0, 60),
      title: i.title ?? null,
      text: i.text,
      author: i.authorName,
      created_at: i.createdAt,
      reply_count: replyCount.get(i.id) ?? 0,
      kind: i.type,
      cluster_label: i.clusterId !== undefined && i.clusterId !== -1 ? (labelById.get(i.clusterId) ?? null) : null,
      hub_score: (replyCount.get(i.id) ?? 0) / maxReplies,
      thread_root_id: i.threadRootId,
      thread_title: i.type === 'comment' ? (titleById.get(i.threadRootId) ?? threadTitleFromAlerts.get(i.id) ?? null) : null,
      parent_id: i.parentId,
      x2d: pos[0], y2d: pos[1],
      x3d: pos[0], y3d: pos[1], z3d: pos[2],
    }
  })

  const clusterRepo = new ClusterRepo(redis)
  const clusterRows = await clusterRepo.listBySize(1000)
  return c.json({
    nodes,
    edges: [],
    meta: {
      postCount: items.filter(i => i.type === 'post').length,
      commentCount: items.filter(i => i.type === 'comment').length,
      clusterCount: clusterRows.length,
      clusterSizeByLabel: Object.fromEntries(clusterRows.map(r => [r.label, r.size])),
    },
  })
})

app.post('/api/graph/extra-nodes', async (c) => {
  const body = await c.req.json<{ ids: string[] }>().catch(() => ({ ids: [] }))
  if (!Array.isArray(body.ids) || body.ids.length === 0) return c.json({ nodes: [] })
  const items = (await Promise.all(body.ids.map(id => store.getItem(id)))).filter((x): x is StoredItem => !!x)
  if (items.length === 0) return c.json({ nodes: [] })
  const embMap = await store.getEmbeddings(items.map(i => i.id))
  const labelById = await loadClusterLabelMap()
  const allIds = await store.getItemIds()
  const allItems = await Promise.all(allIds.map(id => store.getItem(id)))
  const replyCount = new Map<string, number>()
  for (const i of allItems) if (i?.parentId) replyCount.set(i.parentId, (replyCount.get(i.parentId) ?? 0) + 1)
  const maxReplies = Math.max(1, ...replyCount.values())
  const titleById = new Map<string, string | null>()
  for (const i of allItems) if (i && i.type === 'post') titleById.set(i.id, i.title ?? null)

  let layoutMap = new Map<string, number[]>()
  const cachedLayout = await redis.get('strata:graph:layout')
  if (cachedLayout) {
    try { layoutMap = new Map(JSON.parse(cachedLayout) as Array<[string, number[]]>) } catch {}
  }

  const nodes = items.map(i => {
    const pos = layoutMap.get(i.id) ?? [0, 0, 0]
    return {
      id: i.id,
      qualname: i.id,
      symbol_name: i.title ?? i.text.slice(0, 60),
      title: i.title ?? null,
      text: i.text,
      author: i.authorName,
      created_at: i.createdAt,
      reply_count: replyCount.get(i.id) ?? 0,
      kind: i.type,
      cluster_label: i.clusterId !== undefined && i.clusterId !== -1 ? (labelById.get(i.clusterId) ?? null) : null,
      hub_score: (replyCount.get(i.id) ?? 0) / maxReplies,
      thread_root_id: i.threadRootId,
      thread_title: i.type === 'comment' ? (titleById.get(i.threadRootId) ?? null) : null,
      parent_id: i.parentId,
      x2d: pos[0], y2d: pos[1],
      x3d: pos[0], y3d: pos[1], z3d: pos[2],
    }
  })
  return c.json({ nodes })
})

app.post('/api/search', async (c) => {
  const apiKey = await getOpenAIKey()
  if (!apiKey || typeof apiKey !== 'string') return c.json({ error: 'No API key' }, 503)
  type SearchBody = { query: string; top_k?: number; time_window?: string }
  const body = await c.req.json<SearchBody>().catch(() => ({ query: '' } as SearchBody))
  if (!body.query) return c.json({ error: 'query required' }, 400)
  const topK = Math.max(1, Math.min(body.top_k ?? 8, 20))
  const cutoff =
    body.time_window === 'today' ? Date.now() - 86_400_000 :
    body.time_window === '7d' ? Date.now() - 7 * 86_400_000 :
    body.time_window === '30d' ? Date.now() - 30 * 86_400_000 : null
  try {
    const client = new OpenAI({ apiKey })
    const res = await client.embeddings.create({ input: body.query, model: 'text-embedding-3-small', dimensions: 256 })
    await recordUsage('text-embedding-3-small', { inputTokens: res.usage.total_tokens, outputTokens: 0 })
    const queryVec = res.data[0].embedding

    const items = await listAllItemsSorted()
    const ids = items.map(i => i.id)
    const embMap = await store.getEmbeddings(ids)
    const labelById = await loadClusterLabelMap()

    const scored: Array<{ item: StoredItem; score: number }> = []
    for (const it of items) {
      if (cutoff !== null && it.createdAt < cutoff) continue
      const emb = embMap.get(it.id)
      if (!emb) continue
      let s = 0
      for (let i = 0; i < emb.length; i++) s += queryVec[i] * emb[i]
      scored.push({ item: it, score: s })
    }
    scored.sort((a, b) => b.score - a.score)
    const hits = scored.slice(0, topK).map(({ item, score }) => ({
      id: item.id,
      kind: item.type,
      title: item.title ?? null,
      snippet: (item.text ?? '').slice(0, 200),
      cluster_label: item.clusterId !== undefined && item.clusterId !== -1 ? (labelById.get(item.clusterId) ?? null) : null,
      created_at: item.createdAt,
      score: Number(score.toFixed(4)),
    }))
    await clearApiKeyInvalid()
    return c.json({ hits })
  } catch (err) {
    await noteOpenAIError(err)
    if (isOpenAIAuthError(err)) return c.json({ error: 'invalid_api_key' }, 401)
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/api/ingest/status', async (c) => {
  const status = await redis.hGetAll('strata:ingest:status')
  if (!status || !status.phase) return c.json({ phase: 'idle' })
  const num = (k: string) => parseInt(status[k] || '0', 10)
  return c.json({
    phase: status.phase,
    totalItems: num('totalItems'),
    processed: num('processed'),
    startedAt: num('startedAt'),
    endedAt: status.endedAt ? num('endedAt') : null,
    error: status.error || null,
    embCompleted: num('embCompleted'),
    embTotal: num('embTotal'),
    extractCompleted: num('extractCompleted'),
    extractTotal: num('extractTotal'),
    entCompleted: num('entCompleted'),
    entTotal: num('entTotal'),
    lastPolledAt: status.lastPolledAt ? num('lastPolledAt') : null,
    chunkIndex: num('chunkIndex'),
    chunkCount: num('chunkCount'),
    waitingUntil: status.waitingUntil ? num('waitingUntil') : null,
    backfillId: status.backfillId || null,
    mode: status.mode || 'batch',
  })
})

app.get('/api/viewer', async (c) => {
  const ok = await isMod(context.userId, context.subredditName ?? '')
  return c.json({ isMod: ok, subredditName: context.subredditName ?? null })
})

// --- Backfill ---

let seedRawCache: RawItem[] | null = null

function getSeedRawItems(): RawItem[] {
  if (seedRawCache) return seedRawCache
  seedRawCache = seedRawItems as RawItem[]
  return seedRawCache
}

app.post('/api/backfill/preview', async (c) => {
  if (!context.subredditName) return c.json({ error: 'No subreddit context' }, 400)
  const { from, to, demo } = await c.req.json<{ from: string; to: string; demo?: boolean }>()
  if (!from || !to) return c.json({ error: 'from and to are required' }, 400)

  const start = new Date(from).getTime()
  const end = new Date(to).getTime() + 24 * 60 * 60 * 1000
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return c.json({ error: 'Invalid date range' }, 400)
  }

  const rawItems: RawItem[] = []
  try {
    if (demo) {
      const seedItems = getSeedRawItems()
      for (const it of seedItems) {
        if (it.createdAt < start || it.createdAt > end) continue
        rawItems.push(it)
      }
    } else {
      const posts = reddit.getNewPosts({ subredditName: context.subredditName, limit: 5000, pageSize: 100 })
      for await (const post of posts) {
        if (post.createdAt.getTime() < start) break
        if (post.createdAt.getTime() > end) continue
        rawItems.push({
          id: post.id, type: 'post', title: post.title, text: post.body || '',
          authorId: post.authorId || post.authorName || 'unknown',
          authorName: post.authorName || 'unknown',
          createdAt: post.createdAt.getTime(),
          threadRootId: post.id, parentId: null,
        })
        try {
          const comments = reddit.getComments({ postId: post.id, limit: 200, sort: 'new' as any })
          for await (const comment of comments) {
            if (comment.createdAt.getTime() < start || comment.createdAt.getTime() > end) continue
            rawItems.push({
              id: comment.id, type: 'comment', title: post.title, text: comment.body,
              authorId: comment.authorId || comment.authorName || 'unknown',
              authorName: comment.authorName || 'unknown',
              createdAt: comment.createdAt.getTime(),
              threadRootId: post.id, parentId: comment.parentId || null,
            })
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error('[Strata] Preview fetch error:', err)
    return c.json({ error: `Fetch failed: ${err}` }, 500)
  }

  const currentCount = await store.getItemCount()
  const currentBytes = estimateCurrentBytes(currentCount)
  const estimate = estimateBackfill(rawItems.length, currentBytes)
  const rtEstimate = estimateBackfillRealtime(rawItems.length, currentBytes)
  const willExceedItemCap = currentCount + rawItems.length > ITEM_CAPACITY

  const token = generateAlertId()
  const TTL_MS = 10 * 60 * 1000
  await redis.set(`strata:backfill:preview:${token}`, JSON.stringify({ from, to, items: rawItems }), {
    expiration: new Date(Date.now() + TTL_MS),
  })

  return c.json({
    token,
    ...estimate,
    realtimeEstimate: { estimatedMinutes: rtEstimate.estimatedMinutes, estimatedCostUsd: rtEstimate.estimatedCostUsd },
    willExceed: estimate.willExceed || willExceedItemCap,
    currentItemCount: currentCount,
    itemCapacity: ITEM_CAPACITY,
    from,
    to,
  })
})

app.post('/api/backfill/confirm', async (c) => {
  if (!context.subredditName) return c.json({ error: 'No subreddit context' }, 400)
  const { token, mode = 'batch' } = await c.req.json<{ token: string; mode?: 'realtime' | 'batch' }>()
  if (!token) return c.json({ error: 'token required' }, 400)

  const current = await redis.hGetAll('strata:ingest:status')
  if (current?.phase && current.phase !== 'done' && current.phase !== 'error' && current.phase !== 'cancelled') {
    return c.json({ error: 'A backfill is already running' }, 409)
  }

  const cachedJson = await redis.get(`strata:backfill:preview:${token}`)
  if (!cachedJson) return c.json({ error: 'Preview expired — generate a new estimate' }, 410)
  const cached = JSON.parse(cachedJson) as { from: string; to: string; items: RawItem[] }
  const rawItems = cached.items

  if (rawItems.length === 0) return c.json({ error: 'No items in the selected range' }, 400)

  const currentCount = await store.getItemCount()
  if (currentCount + rawItems.length > ITEM_CAPACITY) {
    return c.json({ error: `Would exceed item capacity (${ITEM_CAPACITY})` }, 400)
  }

  try {
    // Store all raw items + an ordered id list so the scheduler can slice it
    // into egress-sized chunks. No OpenAI upload happens here — the scheduler
    // submits one chunk at a time and backs off when Devvit's egress cap is hit.
    await redis.hSet('strata:ingest:raw', Object.fromEntries(
      rawItems.map(item => [item.id, JSON.stringify(item)])
    ))
    await redis.set('strata:ingest:order', JSON.stringify(rawItems.map(i => i.id)))

    const backfillId = generateAlertId()
    const estimate = mode === 'realtime'
      ? estimateBackfillRealtime(rawItems.length, estimateCurrentBytes(currentCount))
      : estimateBackfill(rawItems.length, estimateCurrentBytes(currentCount))
    const initiatedBy = context.userId || 'unknown'
    const chunkCount = Math.ceil(rawItems.length / INGEST_CHUNK_SIZE)

    await redis.hSet('strata:ingest:status', {
      phase: mode === 'realtime' ? 'realtime-ingest' : 'submit',
      mode,
      totalItems: String(rawItems.length),
      processed: '0',
      chunkIndex: '0',
      chunkCount: String(chunkCount),
      startedAt: String(Date.now()),
      backfillId,
    })

    await putBackfillRecord({
      id: backfillId,
      status: 'running',
      from: cached.from,
      to: cached.to,
      startedAt: Date.now(),
      endedAt: null,
      totalItems: rawItems.length,
      processed: 0,
      initiatedBy,
      costUsdEstimated: estimate.estimatedCostUsd,
    })

    await redis.del(`strata:backfill:preview:${token}`)
    await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + 2000), data: {} })

    console.log(`[Strata] Backfill ${backfillId} queued: ${rawItems.length} items in ${chunkCount} chunk(s)`)
    return c.json({ id: backfillId, totalItems: rawItems.length })
  } catch (err) {
    console.error('[Strata] Confirm error:', err)
    await noteOpenAIError(err)
    const friendly = describeOpenAIError(err)
    return c.json({ error: friendly ?? `Failed to start backfill: ${err}` }, friendly && isOpenAIAuthError(err) ? 401 : 500)
  }
})

app.post('/api/backfill/cancel', async (c) => {
  const { id } = await c.req.json<{ id: string }>()
  if (!id) return c.json({ error: 'id required' }, 400)

  const status = await redis.hGetAll('strata:ingest:status')
  const isActive = status?.phase && status.phase !== 'done' && status.phase !== 'error' && status.phase !== 'cancelled'
  if (!isActive || status.backfillId !== id) {
    return c.json({ error: 'No matching active backfill' }, 404)
  }

  // Best-effort: cancel in-flight OpenAI batches. Don't fail the request if
  // these don't go through — the scheduler bail-out is what stops the work.
  try {
    const apiKey = await getOpenAIKey()
    if (apiKey) {
      const openai = new OpenAI({ apiKey })
      const ids = [status.embBatchId, status.extractBatchId, status.entityEmbBatchId].filter(Boolean) as string[]
      await Promise.allSettled(ids.map(bid => openai.batches.cancel(bid)))
    }
  } catch (err) {
    console.error('[Strata] Batch cancel error:', err)
  }

  await redis.hSet('strata:ingest:status', { phase: 'cancelled', endedAt: String(Date.now()) })
  await updateBackfillRecord(id, { status: 'cancelled', endedAt: Date.now() })

  await redis.del('strata:ingest:raw')
  await redis.del('strata:ingest:embeddings')
  await redis.del('strata:ingest:entities')

  console.log(`[Strata] Backfill ${id} cancelled`)
  return c.json({ ok: true })
})

app.get('/api/backfill/history', async (c) => {
  const records = await listBackfillRecords()
  const currentCount = await store.getItemCount()
  const currentBytes = estimateCurrentBytes(currentCount)
  return c.json({
    records,
    currentItemCount: currentCount,
    currentBytes,
    itemCapacity: ITEM_CAPACITY,
  })
})

// --- Rules ---

app.get('/api/rules', async (c) => {
  const rules = await store.getRules()
  return c.json({
    rules: rules.map(r => ({
      id: r.id, shortName: r.shortName, description: r.description, priority: r.priority,
    })),
  })
})

app.post('/api/rules/reload', async (c) => {
  if (!context.subredditName) return c.json({ error: 'No subreddit context' }, 400)
  try {
    const engine = await getEngine()
    const subredditRules = await reddit.getRules(context.subredditName)
    if (!subredditRules || subredditRules.length === 0) {
      return c.json({ count: 0, message: 'No rules found for this subreddit' })
    }
    const ruleInputs = subredditRules.map((rule: any, i: number) => ({
      id: `rule-${i + 1}`,
      shortName: rule.shortName || rule.violationReason || `Rule ${i + 1}`,
      description: rule.description || rule.shortName || '',
      priority: i + 1,
    }))
    await engine.loadRules(ruleInputs)
    return c.json({ count: ruleInputs.length })
  } catch (err) {
    console.error('[Strata] Rules reload error:', err)
    return c.json({ error: String(err) }, 500)
  }
})

// --- Danger zone ---

app.post('/api/items/delete-all', async (c) => {
  const ids = await store.getItemIds()
  if (ids.length > 0) await store.deleteItems(ids)
  const ENTITY_TYPES = ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity']
  for (const t of ENTITY_TYPES) await redis.del(`strata:entity-emb:${t}`)
  await redis.del('strata:entity-hub-counts')
  await redis.del('strata:cases')
  await redis.del('strata:backfill:complete')
  console.log(`[Strata] Deleted ${ids.length} items`)
  return c.json({ deleted: ids.length })
})

app.post('/api/alerts/reset', async (c) => {
  await alertStore.resetAll()
  console.log('[Strata] All alerts reset')
  return c.json({ ok: true })
})

async function resetStrataData(): Promise<number> {
  const count = await store.getItemCount()
  const ENTITY_TYPES = ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity']
  const keys = [
    'strata:items', 'strata:embeddings', 'strata:idx:time',
    'strata:entity-hub-counts', 'strata:cases', 'strata:rules',
    'strata:backfill:complete', 'strata:backfill:history',
    'strata:scan:history', 'strata:scan:status', 'strata:scan:pairs', 'strata:scan:new-alert-ids',
    'strata:ingest:status', 'strata:ingest:raw', 'strata:ingest:order',
    'strata:ingest:embeddings', 'strata:ingest:entities',
    'strata:seed:complete', 'strata:community-context',
    'strata:cluster:ids-by-size', 'strata:cluster:centroids',
    'strata:cluster:alias', 'strata:cluster:counter',
    'strata:cluster:config', 'strata:cluster:status', 'strata:cluster:ingest-counter',
    'strata:graph:layout',
    ...ENTITY_TYPES.map(t => `strata:entity-emb:${t}`),
    ...ENTITY_TYPES.map(t => `strata:idx:entity-surfaces:${t}`),
  ]
  for (const key of keys) await redis.del(key)
  await alertStore.resetAll()
  invalidateItemCache()
  console.log(`[Strata] Reset complete: ${count} items removed (API key preserved)`)
  return count
}

app.post('/api/strata/reset', async (c) => {
  const deleted = await resetStrataData()
  return c.json({ ok: true, deleted })
})

app.post('/internal/menu/reset', async (c) => {
  try {
    const deleted = await resetStrataData()
    return c.json<UiResponse>({ showToast: { text: `Strata reset — ${deleted} items wiped. API key kept.`, appearance: 'success' } })
  } catch (err) {
    console.error('[Strata] Menu reset failed:', err)
    return c.json<UiResponse>({ showToast: { text: `Reset failed: ${String(err)}`, appearance: 'neutral' } })
  }
})

// --- Scan ---

type ScanRecord = {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt: number | null
  anchorsTotal: number
  anchorsProcessed: number
  alertsCreated: number
  autoTriggered: boolean
  initiatedBy: string
  error?: string
}

async function getScanRecord(id: string): Promise<ScanRecord | null> {
  const raw = await redis.hGet('strata:scan:history', id)
  return raw ? JSON.parse(raw) as ScanRecord : null
}

async function putScanRecord(record: ScanRecord): Promise<void> {
  await redis.hSet('strata:scan:history', { [record.id]: JSON.stringify(record) })
}

async function updateScanRecord(id: string, patch: Partial<ScanRecord>): Promise<void> {
  const existing = await getScanRecord(id)
  if (!existing) return
  await putScanRecord({ ...existing, ...patch })
}

async function listScanRecords(): Promise<ScanRecord[]> {
  const all = await redis.hGetAll('strata:scan:history')
  return Object.values(all)
    .map(v => JSON.parse(v) as ScanRecord)
    .sort((a, b) => b.startedAt - a.startedAt)
}

app.post('/api/scan/start', async (c) => {
  const itemCount = await store.getItemCount()
  if (itemCount === 0) return c.json({ error: 'No items to scan' }, 400)

  const current = await redis.hGetAll('strata:scan:status')
  if (current?.phase === 'building' || current?.phase === 'classifying') {
    return c.json({ error: 'A scan is already running' }, 409)
  }

  const id = generateAlertId()
  const startedAt = Date.now()
  await redis.hSet('strata:scan:status', {
    phase: 'building',
    startedAt: String(startedAt),
    scanId: id,
    anchorsProcessed: '0',
    anchorsTotal: '0',
  })
  await putScanRecord({
    id, status: 'running', startedAt, endedAt: null,
    anchorsTotal: 0, anchorsProcessed: 0, alertsCreated: 0,
    autoTriggered: false, initiatedBy: context.userId || 'unknown',
  })
  await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 1000), data: { step: 'build' } })
  return c.json({ id })
})

app.post('/api/scan/cancel', async (c) => {
  const status = await redis.hGetAll('strata:scan:status')
  const isActive = status?.phase === 'building' || status?.phase === 'classifying'
  if (!isActive) return c.json({ error: 'No active scan' }, 404)

  const id = status.scanId
  const endedAt = Date.now()
  await redis.hSet('strata:scan:status', { phase: 'cancelled', endedAt: String(endedAt) })
  await redis.del('strata:scan:pairs')
  await redis.del('strata:scan:new-alert-ids')
  if (id) await updateScanRecord(id, { status: 'cancelled', endedAt })
  return c.json({ ok: true })
})

app.get('/api/scan/status', async (c) => {
  const status = await redis.hGetAll('strata:scan:status')
  if (!status || !status.phase) return c.json({ phase: 'idle' })
  return c.json({
    phase: status.phase,
    scanId: status.scanId ?? null,
    startedAt: parseInt(status.startedAt || '0', 10),
    endedAt: status.endedAt ? parseInt(status.endedAt, 10) : null,
    anchorsProcessed: parseInt(status.anchorsProcessed || '0', 10),
    anchorsTotal: parseInt(status.anchorsTotal || '0', 10),
    alertsCreated: parseInt(status.alerts || '0', 10),
    error: status.error || null,
  })
})

app.get('/api/scan/history', async (c) => {
  const records = await listScanRecords()
  return c.json({ records })
})

app.get('/api/alerts', async (c) => {
  const status = c.req.query('status') as AlertStatus | undefined
  const limit = parseInt(c.req.query('limit') || '20', 10)
  const cursor = c.req.query('cursor') ? parseInt(c.req.query('cursor')!, 10) : undefined
  const { alerts, nextCursor } = await alertStore.listAlerts({ status, limit, cursor })
  return c.json({ alerts, nextCursor })
})

app.get('/api/alerts/:id', async (c) => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  const connections = await alertStore.getAlertConnections(id)
  connections.sort((a, b) => {
    if (a.confidence === 'high' && b.confidence !== 'high') return -1
    if (b.confidence === 'high' && a.confidence !== 'high') return 1
    return 0
  })
  const anchorItem = await store.getItem(alert.anchorId)
  const hydrated = await Promise.all(connections.map(async conn => {
    const it = await store.getItem(conn.itemId)
    return { ...conn, decision: it?.decision ?? 'pending' }
  }))
  return c.json({
    ...alert,
    connections: hydrated,
    anchorDecision: anchorItem?.decision ?? 'pending',
  })
})

app.post('/api/alerts/:id/action', async (c) => {
  const id = c.req.param('id')
  const { action } = await c.req.json<{ action: 'resolved' | 'dismissed' }>()
  if (action !== 'resolved' && action !== 'dismissed') {
    return c.json({ error: 'Invalid action' }, 400)
  }
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  await alertStore.updateAlertStatus(id, action)
  return c.json({ ok: true })
})

// --- Mod actions (brigade triage) ---

async function writeDecision(itemId: string, decision: 'removed' | 'approved', by: string): Promise<boolean> {
  const item = await store.getItem(itemId)
  if (!item) return false
  if (item.decision === decision) return true
  const now = Date.now()
  await store.moveDecision(itemId, item.decision, decision, now)
  await store.setItem({
    ...item,
    decision,
    decisionAt: now,
    decisionBy: by,
    decisionReason: 'Strata brigade action',
  })
  return true
}

app.post('/api/items/:id/remove', async (c) => {
  const id = c.req.param('id')
  try {
    await reddit.remove(id as `t1_${string}` | `t3_${string}`, false)
  } catch (err) {
    console.error('[Strata] remove failed:', err)
    return c.json({ error: String(err) }, 500)
  }
  await writeDecision(id, 'removed', context.userId || 'mod')
  return c.json({ ok: true })
})

app.post('/api/items/:id/approve', async (c) => {
  const id = c.req.param('id')
  try {
    await reddit.approve(id as `t1_${string}` | `t3_${string}`)
  } catch (err) {
    console.error('[Strata] approve failed:', err)
    return c.json({ error: String(err) }, 500)
  }
  await writeDecision(id, 'approved', context.userId || 'mod')
  return c.json({ ok: true })
})

app.post('/api/alerts/:id/bulk-remove', async (c) => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  const connections = await alertStore.getAlertConnections(id)
  const candidateIds = [alert.anchorId, ...connections.map(conn => conn.itemId)]
  const by = context.userId || 'mod'
  let removed = 0
  for (const cid of candidateIds) {
    const item = await store.getItem(cid)
    if (item && item.decision !== 'pending') continue
    try {
      await reddit.remove(cid as `t1_${string}` | `t3_${string}`, false)
      await writeDecision(cid, 'removed', by)
      removed++
    } catch (err) {
      console.error('[Strata] bulk-remove failed for', cid, err)
    }
  }
  await alertStore.updateAlertStatus(id, 'resolved')
  return c.json({ ok: true, removed })
})

app.post('/api/alerts/:id/bulk-lock', async (c) => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  const anchorItem = await store.getItem(alert.anchorId)
  if (!anchorItem) return c.json({ error: 'Anchor item not found' }, 404)
  const threadRootId = anchorItem.threadRootId
  try {
    const post = await reddit.getPostById(threadRootId as `t3_${string}`)
    await post.lock()
  } catch (err) {
    console.error('[Strata] lock failed:', err)
    return c.json({ error: String(err) }, 500)
  }
  await alertStore.updateAlertStatus(id, 'resolved')
  return c.json({ ok: true, threadRootId })
})

// --- Compose + publish (surface alerts) ---

const COMPOSE_SYSTEM_PROMPT = `You are the moderator team of r/<SUB> drafting a consolidated community update. Strata has surfaced a case post on the subreddit plus related items (witness reports, additional sightings, timeline notes). Your job is to synthesize these into one mod-voice post the team can publish.

# Voice
You are writing as the mod team. Refer to the original poster and other community members in the third person ("OP", "a community member", "several of you"). Never write in the case poster's first person — do not say "my roommate", "I saw", or otherwise impersonate anyone. Tone: calm, factual, empathetic, plain language. No emojis, no sensationalism, no legal speculation.

# Sourcing
Every concrete claim must come from the supplied items. Do not invent details, names, plate numbers, vehicle descriptions, injuries, or timestamps. When you reference a community report, cite it inline with a markdown link to its permalink: \`[short descriptive label](permalink)\`. Use the OP's post link when referring to the original case. Withhold private specifics (medical detail, named individuals not already named publicly by OP) unless they are load-bearing for the call to action.

# Structure
- Title: short, factual, mod-note style. Lead with "Mod note:" or "Update:" and identify the situation in 8-14 words. No clickbait, no dashes-as-suspense.
- Body sections (use short bold labels or plain paragraphs — pick what fits):
  1. One-paragraph framing: what this post is and why it exists, linking the original case post.
  2. "What we know" — the established facts, in plain language.
  3. "Community reports" — a short bulleted list of matched items, each as a linked label with a one-line summary. Skip if there's only one connection; fold it into prose instead.
  4. "How to help" — specific, actionable next steps (who to contact, what to submit). Skip if there's nothing actionable.
  5. One-line thank-you, signed "— Mod team".

# Output
- title: 40-80 characters.
- body: Reddit-flavored markdown. Paragraphs separated by blank lines. Use \`**bold**\`, bullet lists, and inline links. Do not use headings (\`#\`) — they render poorly in feeds. Keep total length tight: 4-8 short paragraphs, optionally with one bullet list.

# Refinement
If a refinement instruction is supplied, treat the previous draft as the baseline and apply the instruction surgically. Do not regenerate from scratch unless the instruction explicitly asks for that.`

const COMPOSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'body'],
  additionalProperties: false,
} as const

function buildComposeUserPrompt(alert: Alert, connections: AlertConnection[], opts: { refinementPrompt?: string; currentDraft?: { title: string; body: string }; communityContext?: string }): string {
  const permalink = (p?: string) => (p ? `https://reddit.com${p}` : '(no permalink)')
  const lines: string[] = []
  if (opts.communityContext) {
    lines.push('## Community context')
    lines.push(opts.communityContext)
    lines.push('')
  }
  lines.push('## Case anchor (original post)')
  if (alert.anchorTitle) lines.push(`Title: ${alert.anchorTitle}`)
  lines.push(`Author: u/${alert.anchorAuthor}`)
  lines.push(`Posted: ${new Date(alert.createdAt).toISOString()}`)
  lines.push(`Permalink: ${permalink(alert.anchorPermalink)}`)
  lines.push(`Text:\n${alert.anchorText}`)
  lines.push('')
  lines.push('## Related items found by Strata')
  for (let i = 0; i < connections.length; i++) {
    const c = connections[i]
    lines.push(`### #${i + 1} — ${c.classification.toUpperCase()} (${c.confidence})`)
    if (c.title) lines.push(`Thread: ${c.title}`)
    lines.push(`Author: u/${c.author}`)
    lines.push(`Posted: ${new Date(c.createdAt).toISOString()}`)
    lines.push(`Permalink: ${permalink(c.permalink)}`)
    lines.push(`Text:\n${c.text}`)
    if (c.reasoning) lines.push(`Why connected: ${c.reasoning}`)
    lines.push('')
  }
  if (opts.currentDraft) {
    lines.push('## Previous draft')
    lines.push(`Title: ${opts.currentDraft.title}`)
    lines.push(`Body:\n${opts.currentDraft.body}`)
    lines.push('')
  }
  if (opts.refinementPrompt) {
    lines.push('## Refinement instruction')
    lines.push(opts.refinementPrompt)
  } else {
    lines.push('Draft the community update post now.')
  }
  return lines.join('\n')
}

app.post('/api/alerts/:id/compose', async (c) => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  const connections = await alertStore.getAlertConnections(id)
  const body = await c.req.json<{ refinementPrompt?: string; currentDraft?: { title: string; body: string } }>().catch(() => ({}))

  const apiKey = await getOpenAIKey()
  if (!apiKey) return c.json({ error: 'OpenAI API key not configured' }, 500)
  const client = new OpenAI({ apiKey: apiKey as string })

  const sub = context.subredditName ?? 'this subreddit'
  const systemPrompt = COMPOSE_SYSTEM_PROMPT.replace('<SUB>', sub)
  const communityContext = ((await redis.get('strata:community-context')) ?? '').trim() || undefined
  const userPrompt = buildComposeUserPrompt(alert, connections, { ...body, communityContext })

  try {
    const response = await client.responses.create({
      model: 'gpt-5.4-mini',
      reasoning: { effort: 'low' },
      input: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      text: { format: { type: 'json_schema', name: 'community_update', schema: COMPOSE_SCHEMA as Record<string, unknown>, strict: true } },
    })
    const parsed = JSON.parse(response.output_text) as { title: string; body: string }
    await alertStore.updateAlertDraft(id, {
      draftPostTitle: parsed.title,
      draftPostBody: parsed.body,
      draftedAt: Date.now(),
      draftedBy: context.userId || 'mod',
    })
    await recordUsage('gpt-5.4-mini', {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    })
    await clearApiKeyInvalid()
    return c.json(parsed)
  } catch (err) {
    console.error('[Strata] compose failed:', err)
    await noteOpenAIError(err)
    if (isOpenAIAuthError(err)) return c.json({ error: 'invalid_api_key' }, 401)
    return c.json({ error: describeOpenAIError(err) ?? String(err) }, 500)
  }
})

app.post('/api/alerts/:id/publish', async (c) => {
  const id = c.req.param('id')
  const alert = await alertStore.getAlert(id)
  if (!alert) return c.json({ error: 'Not found' }, 404)
  if (alert.publishedPostId) return c.json({ error: 'Alert already published' }, 409)
  if (!context.subredditName) return c.json({ error: 'No subreddit context' }, 400)

  const payload = await c.req.json<{ title: string; body: string }>().catch(() => ({} as { title?: string; body?: string }))
  if (!payload.title?.trim() || !payload.body?.trim()) {
    return c.json({ error: 'Title and body are required' }, 400)
  }

  try {
    const post = await reddit.submitPost({
      subredditName: context.subredditName,
      title: payload.title.trim(),
      text: payload.body,
    })
    const permalink = `/r/${context.subredditName}/comments/${post.id.replace(/^t3_/, '')}`
    const by = context.userId || 'mod'
    const at = Date.now()
    await alertStore.updateAlertPublished(id, {
      publishedPostId: post.id,
      publishedPostTitle: payload.title.trim(),
      publishedPostBody: payload.body,
      publishedPostPermalink: permalink,
      publishedAt: at,
      publishedBy: by,
    })
    await alertStore.updateAlertStatus(id, 'resolved')
    return c.json({ ok: true, postId: post.id, permalink, publishedAt: at, publishedBy: by })
  } catch (err) {
    console.error('[Strata] publish failed:', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/api/items', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const cursor = c.req.query('cursor') ? parseInt(c.req.query('cursor')!, 10) : null
  const type = c.req.query('type') as 'post' | 'comment' | undefined
  const search = c.req.query('search') || ''

  const maxScore = cursor !== null ? cursor - 1 : '+inf'
  const items: any[] = []
  let scanCursor = cursor !== null ? cursor - 1 : '+inf'
  let rounds = 0
  const MAX_ROUNDS = 10

  while (items.length < limit && rounds < MAX_ROUNDS) {
    rounds++
    const entries = await redis.zRange('strata:idx:time', '-inf', scanCursor as any, {
      by: 'score',
      reverse: true,
      limit: { offset: 0, count: 200 },
    })
    if (entries.length === 0) break

    for (const entry of entries) {
      if (items.length >= limit) break
      const raw = await redis.hGet('strata:items', entry.member)
      if (!raw) continue
      const item = JSON.parse(raw) as StoredItem
      if (type && item.type !== type) continue
      if (search && !item.text.toLowerCase().includes(search.toLowerCase()) && !item.authorName.toLowerCase().includes(search.toLowerCase())) continue
      items.push({
        id: item.id,
        type: item.type,
        title: item.title,
        text: item.text.slice(0, 200),
        authorName: item.authorName,
        createdAt: item.createdAt,
        entityCount: item.entities.length,
      })
    }

    scanCursor = entries[entries.length - 1].score - 1
    if (entries.length < 200) break
  }

  const nextCursor = items.length > 0 ? items[items.length - 1].createdAt : null
  const total = await redis.zCard('strata:idx:time')
  return c.json({ items, nextCursor, total })
})

// --- Debug ---

app.get('/api/debug', async (c) => {
  const timeCount = await redis.zCard('strata:idx:time')
  const timeFirst5 = await redis.zRange('strata:idx:time', 0, 4)
  const timeLast5 = await redis.zRange('strata:idx:time', '-inf', '+inf', { by: 'score', reverse: true, limit: { offset: 0, count: 5 } })

  const itemsHashSample = await redis.hGet('strata:items', timeFirst5[0]?.member ?? '')
  const embHashSample = await redis.hGet('strata:embeddings', timeFirst5[0]?.member ?? '')

  const clusterRepo = new ClusterRepo(redis)
  const clusterRows = await clusterRepo.listBySize(10)
  const clusterStatus = await redis.hGetAll('strata:cluster:status')

  const layoutCached = !!(await redis.get('strata:graph:layout'))
  const ingestStatus = await redis.hGetAll('strata:ingest:status')

  const decisionPending = await redis.zCard('strata:idx:decision:pending')

  const sampleItem = itemsHashSample ? JSON.parse(itemsHashSample) : null

  return c.json({
    idx_time_count: timeCount,
    idx_time_first5: timeFirst5.map(e => ({ id: e.member, score: e.score, date: new Date(e.score).toISOString() })),
    idx_time_last5: timeLast5.map(e => ({ id: e.member, score: e.score, date: new Date(e.score).toISOString() })),
    items_hash_has_sample: !!itemsHashSample,
    emb_hash_has_sample: !!embHashSample,
    sample_item_clusterId: sampleItem?.clusterId,
    sample_item_type: sampleItem?.type,
    sample_item_createdAt: sampleItem ? new Date(sampleItem.createdAt).toISOString() : null,
    decision_pending_count: decisionPending,
    cluster_status: clusterStatus,
    cluster_rows_top10: clusterRows.map(r => ({ id: r.id, label: r.label, size: r.size })),
    graph_layout_cached: layoutCached,
    ingest_status: ingestStatus,
  })
})

// --- Server ---

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
})
