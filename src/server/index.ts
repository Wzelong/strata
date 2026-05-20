import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createServer, getServerPort, redis, reddit, context, scheduler, settings } from '@devvit/web/server'
import type { MenuItemRequest, UiResponse, TriggerResponse } from '@devvit/web/shared'
import OpenAI from 'openai'
import { StrataEngine, normalize } from '../engine/index.js'
import { RedisKVStore, type RedisClient } from '../engine/storage/redis.js'
import { RedisAlertStore } from '../engine/storage/redis-alert-store.js'
import type { AlertStore } from '../engine/storage/alert-store.js'
import type { RawItem, Item, Hit, StoredItem, Entity, Alert, AlertConnection, AlertStatus } from '../engine/types.js'
import {
  buildEmbeddingJsonl, buildExtractionJsonl, buildEntityEmbeddingJsonl,
  submitBatch, checkBatch, downloadBatchResults,
  parseEmbeddingResults, parseExtractionResults, storeResults,
} from '../engine/batch-ingest.js'
import { buildScanPairs, classifyAndCreateAlerts, type ScanPair } from '../engine/scan.js'
import { SEED_DATA_B64 } from './seed-data.js'
import { gunzipSync } from 'node:zlib'

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

async function getEngine(): Promise<StrataEngine> {
  const apiKey = await settings.get('openaiApiKey')
  if (!apiKey) throw new Error('OpenAI API key not configured')
  const client = new OpenAI({ apiKey: apiKey as string })
  return new StrataEngine(store, client)
}

function formatConnections(hits: Array<{ item: Item; relationship: string; weight: number }>): string {
  if (hits.length === 0) return 'No connections found.'
  return hits.map((h, i) => {
    const snippet = h.item.text.replace(/\n/g, ' ').slice(0, 150)
    const date = new Date(h.item.createdAt).toLocaleDateString()
    return `**${i + 1}. ${h.relationship}** (similarity: ${h.weight.toFixed(3)}) — u/${h.item.authorName} (${date})\n> ${snippet}...`
  }).join('\n\n')
}

// --- Triggers ---

app.post('/internal/triggers/app-install', async (c) => {
  const input = await c.req.json<any>()
  console.log('[Strata] Installed to r/' + input.subreddit?.name)
  await redis.set('strata:installed', '1')
  return c.json<TriggerResponse>({ status: 'ok' })
})

app.post('/internal/triggers/post-submit', async (c) => {
  const input = await c.req.json<any>()
  const post = input.post
  if (!post?.title || !post?.id) return c.json<TriggerResponse>({ status: 'ok' })

  const seeded = await redis.get('strata:seed:complete')
  if (!seeded) {
    console.log('[Strata] Skipping post — no seed data loaded yet')
    return c.json<TriggerResponse>({ status: 'ok' })
  }

  try {
    const engine = await getEngine()

    const fullPost = await reddit.getPostById(post.id)
    const text = fullPost.body ? `${fullPost.title}\n\n${fullPost.body}` : fullPost.title
    const authorName = fullPost.authorName || post.author || 'unknown'
    const authorId = post.authorId || authorName

    const raw: RawItem = {
      id: post.id,
      type: 'post',
      text,
      authorId,
      authorName,
      createdAt: Date.now(),
      threadRootId: post.id,
      parentId: null,
    }

    console.log(`[Strata] Ingesting post ${post.id} by ${authorName}: "${text.slice(0, 60)}..."`)
    const item = await engine.ingest(raw)

    const { candidates, entityMatches } = await engine.surface(item)
    console.log(`[Strata] Found ${candidates.length} candidates after hybrid retrieval`)

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
      const alertConnections: AlertConnection[] = related.map(cls => {
        const hit = candidates.find(c => c.item.id === cls.id)!
        return {
          itemId: cls.id,
          author: hit.item.authorName,
          text: hit.item.text,
          permalink: buildPermalink(hit.item, subredditName),
          classification: cls.relationship.toLowerCase() as AlertConnection['classification'],
          confidence: cls.confidence ?? 'review',
          entities: entityMatches.get(cls.id) ?? [],
          reasoning: cls.reason,
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
        anchorText: item.text,
        anchorPermalink: buildPermalink(item, subredditName),
      }

      await alertStore.createAlert(alert, alertConnections)
      console.log(`[Strata] Alert ${alert.id} created — ${alertConnections.length} connections`)

      const body = `Strata found **${connections.length} buried connection(s)** related to a new post:\n\n**"${post.title}"** by u/${post.author}\n\n---\n\n${formatConnections(connections)}\n\n---\n\n*These items were posted in unrelated threads but share key details with this post.*`

      await reddit.modMail.createConversation({
        subredditName,
        subject: `[Strata] ${connections.length} connections found: "${post.title.slice(0, 50)}"`,
        body,
        to: null as any,
      })
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
    const raw: RawItem = {
      id: comment.id,
      type: 'comment',
      text: comment.body,
      authorId: comment.authorId || comment.author || 'unknown',
      authorName: comment.author || 'unknown',
      createdAt: Date.now(),
      threadRootId: comment.linkId || comment.id,
      parentId: comment.parentId || null,
    }

    await engine.ingest(raw)
    console.log(`[Strata] Ingested comment ${comment.id}`)
  } catch (err) {
    console.error('[Strata] Error processing comment:', err)
  }

  return c.json<TriggerResponse>({ status: 'ok' })
})

// --- Menu Actions ---

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
    console.log('[Strata] Reset complete, decompressing bundled seed data...')
    const compressed = Buffer.from(SEED_DATA_B64, 'base64')
    const json = gunzipSync(compressed).toString('utf8')
    const seed = JSON.parse(json) as {
      items: StoredItem[]
      embeddings: Record<string, number[]>
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
        const post = await reddit.getPostById(postId)
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

// --- Ingest ---

app.post('/internal/menu/ingest', async (c) => {
  return c.json<UiResponse>({
    showForm: {
      name: 'ingestDates',
      form: {
        title: 'Strata: Ingest Subreddit',
        acceptLabel: 'Get Estimate',
        fields: [
          { name: 'startDate', label: 'Start date (YYYY-MM-DD)', type: 'string' as const, defaultValue: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) },
          { name: 'endDate', label: 'End date (YYYY-MM-DD)', type: 'string' as const, defaultValue: new Date().toISOString().slice(0, 10) },
        ],
      },
    },
  })
})

// Step 1: Collect dates → count items → show estimate as toast → show confirm form
app.post('/internal/forms/ingest-dates', async (c) => {
  const { startDate, endDate } = await c.req.json<{ startDate: string; endDate: string }>()
  if (!context.subredditName) return c.json<UiResponse>({ showToast: 'No subreddit context.' })

  try {
    const start = new Date(startDate).getTime()
    const end = new Date(endDate).getTime() + 24 * 60 * 60 * 1000

    let itemCount = 0
    try {
      const posts = reddit.getNewPosts({ subredditName: context.subredditName, limit: 5000, pageSize: 100 })
      for await (const post of posts) {
        if (post.createdAt.getTime() < start) break
        if (post.createdAt.getTime() > end) continue
        itemCount += 1 + (post.numberOfComments ?? 0)
      }
    } catch {}

    if (itemCount === 0) itemCount = 10

    const currentCount = await store.getItemCount()
    const estCost = (itemCount * 0.00011).toFixed(2)
    const estMinutes = Math.max(3, Math.ceil(itemCount / 500))

    return c.json<UiResponse>({
      showForm: {
        name: 'ingestConfirm',
        form: {
          title: `Ingest ~${itemCount} items (${startDate} to ${endDate})`,
          description: `~$${estCost} cost · ~${estMinutes} min · Storage: ${currentCount.toLocaleString()} → ${(currentCount + itemCount).toLocaleString()} / 330K`,
          acceptLabel: 'Start Ingest',
          fields: [
            { name: 'startDate', label: 'start', type: 'string' as const, defaultValue: startDate, disabled: true },
            { name: 'endDate', label: 'end', type: 'string' as const, defaultValue: endDate, disabled: true },
          ],
        },
      },
    })
  } catch (err) {
    console.error('[Strata] Ingest estimate error:', err)
    return c.json<UiResponse>({ showToast: `Something went wrong: ${err}` })
  }
})

// Step 2: Mod confirmed → fetch items → submit batch jobs
app.post('/internal/forms/ingest-confirm', async (c) => {
  const { startDate, endDate } = await c.req.json<{ startDate: string; endDate: string; summary?: string }>()
  if (!context.subredditName) return c.json<UiResponse>({ showToast: 'No subreddit context.' })

  try {
    const start = new Date(startDate).getTime()
    const end = new Date(endDate).getTime() + 24 * 60 * 60 * 1000
    const rawItems: RawItem[] = []

    // Fetch from Reddit
    try {
      const posts = reddit.getNewPosts({ subredditName: context.subredditName, limit: 5000, pageSize: 100 })
      for await (const post of posts) {
        if (post.createdAt.getTime() < start) break
        if (post.createdAt.getTime() > end) continue

        const text = post.body ? `${post.title}\n\n${post.body}` : post.title
        rawItems.push({
          id: post.id, type: 'post', text,
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
              id: comment.id, type: 'comment', text: comment.body,
              authorId: comment.authorId || comment.authorName || 'unknown',
              authorName: comment.authorName || 'unknown',
              createdAt: comment.createdAt.getTime(),
              threadRootId: post.id, parentId: comment.parentId || null,
            })
          }
        } catch {}
      }
    } catch {}

    // Fallback: demo items
    if (rawItems.length === 0) {
      const demoData: RawItem[] = [
        { id: 'demo-1', type: 'post', text: 'Honestly stay off Mass Ave near Central if you can. Last Tuesday around 6pm some asshole in a dark green Subaru Outback blew through the crosswalk at Prospect while I was mid-crossing. Had to jump back onto the curb. Cracked taillight and one of those "26.2" marathon stickers on the back window. Reported it to Cambridge PD non-emergency but they said without a plate there\'s nothing they can do.', authorId: 'u1', authorName: 'ThursdayCommuter', createdAt: start + 7 * 86400000, threadRootId: 'demo-1', parentId: null },
        { id: 'demo-2', type: 'comment', text: 'Three weeks and counting since I submitted dashcam footage to Cambridge PD for case #2026-04891. They told me a detective would follow up within 48 hours. Never heard back. Called twice, got "we\'ll pass along the message" both times. I have clear HD footage of the car they\'re looking for but apparently nobody cares.', authorId: 'u2', authorName: 'DashcamDave_617', createdAt: start + 14 * 86400000, threadRootId: 'thread-pd', parentId: 'thread-pd' },
        { id: 'demo-3', type: 'comment', text: 'Not exactly a rant but something that\'s been bugging me — someone on P3 of the Cambridgeside garage has a dark green Subaru Outback that suddenly has gnarly front bumper damage and a cracked passenger headlight. Showed up maybe 2 weeks ago. They park in the same spot every weekday morning. Part of me wonders if they hit something.', authorId: 'u3', authorName: 'CambridgeSide_Resident', createdAt: start + 19 * 86400000, threadRootId: 'thread-parking', parentId: 'thread-parking' },
        { id: 'demo-4', type: 'post', text: 'Was walking down Prospect toward Central around 6pm and heard a loud crash followed by tires screeching. By the time I got to Mass Ave there was a bicycle on the ground with the front wheel bent in half but no car. A couple people were looking around confused. Ambulance showed up maybe 8 minutes later.', authorId: 'u4', authorName: 'InmanSq_Walker', createdAt: start + 7 * 86400000, threadRootId: 'demo-4', parentId: null },
        { id: 'demo-5', type: 'post', text: 'Best pizza in Davis Square? Just moved here from NYC and looking for decent slices. Budget is like $4-5 a slice max.', authorId: 'u5', authorName: 'PizzaFan', createdAt: start + 10 * 86400000, threadRootId: 'demo-5', parentId: null },
        { id: 'demo-6', type: 'comment', text: 'The bike lanes on Mass Ave are a joke. They just painted lines and called it done. No physical barrier means cars swerve in constantly. Someone is going to get killed.', authorId: 'u6', authorName: 'BikerBoston', createdAt: start + 12 * 86400000, threadRootId: 'thread-transit', parentId: 'thread-transit' },
        { id: 'demo-7', type: 'post', text: 'Is it just me or has rent in Cambridge gone completely insane? $3200 for a 1BR in Porter Square with no laundry or parking.', authorId: 'u7', authorName: 'RentRanter', createdAt: start + 5 * 86400000, threadRootId: 'demo-7', parentId: null },
        { id: 'demo-8', type: 'comment', text: 'I live right above the Cambridgeside garage, can vouch for Night Shift Brewing. My roommate and I usually hit it on Tuesdays after his shift ends around 7. He drives so I can drink. We park on P3, never had issues finding a spot in the evening.', authorId: 'u8', authorName: 'TKfromCambridge', createdAt: start + 20 * 86400000, threadRootId: 'thread-bars', parentId: 'thread-bars' },
        { id: 'demo-9', type: 'post', text: 'Cash-only auto body recommendations? Need discreet bumper and headlight repair on a dark green Subaru. Front driver side. My buddy doesn\'t want to go through insurance. Needs it done fast, like this week.', authorId: 'u9', authorName: 'QuickFixNeeded', createdAt: start + 16 * 86400000, threadRootId: 'demo-9', parentId: null },
        { id: 'demo-10', type: 'comment', text: 'Just moved to Somerville, what are the best running routes? I usually do 5-10K in the morning before work. Prefer paved paths.', authorId: 'u10', authorName: 'RunnerGuy', createdAt: start + 3 * 86400000, threadRootId: 'thread-running', parentId: 'thread-running' },
      ]
      rawItems.push(...demoData.filter(d => d.createdAt >= start && d.createdAt <= end))
    }

    const currentCount = await store.getItemCount()
    const capacity = 330_000
    if (currentCount + rawItems.length > capacity) {
      return c.json<UiResponse>({
        showToast: `Too many items: ${rawItems.length} would exceed capacity (${currentCount}/${capacity}).`,
      })
    }

    // Store raw items in Redis for the batch processor
    await redis.hSet('strata:ingest:raw', Object.fromEntries(
      rawItems.map(item => [item.id, JSON.stringify(item)])
    ))

    // Build and submit OpenAI batches
    const apiKey = await settings.get('openaiApiKey') as string
    const openai = new OpenAI({ apiKey })

    const normalizedItems = rawItems.map(r => ({ id: r.id, text: normalize(r.text) }))

    // Submit embedding batch + extraction batch in parallel
    const [embBatchId, extractBatchId] = await Promise.all([
      submitBatch(openai, buildEmbeddingJsonl(normalizedItems), '/v1/embeddings', 'ingest-emb.jsonl'),
      submitBatch(openai, buildExtractionJsonl(normalizedItems), '/v1/responses', 'ingest-extract.jsonl'),
    ])

    console.log(`[Strata] Batches submitted for ${rawItems.length} items`)

    await redis.hSet('strata:ingest:status', {
      phase: 'embedding',
      totalItems: String(rawItems.length),
      processed: '0',
      embBatchId,
      extractBatchId,
      startedAt: String(Date.now()),
    })

    await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + 120_000), data: {} })

    const estMinutes = Math.max(3, Math.ceil(rawItems.length / 500))
    return c.json<UiResponse>({
      showToast: `Processing ${rawItems.length} items (~${estMinutes} min)`,
    })
  } catch (err) {
    console.error('[Strata] Ingest error:', err)
    return c.json<UiResponse>({ showToast: `Error: ${err}` })
  }
})

// --- Scheduler: Poll Batch Status ---

app.post('/internal/scheduler/ingest-batch', async (c) => {
  try {
    const status = await redis.hGetAll('strata:ingest:status')
    if (!status.phase || status.phase === 'done' || status.phase === 'error') return c.json({ status: 'ok' })

    const apiKey = await settings.get('openaiApiKey') as string
    const openai = new OpenAI({ apiKey })

    const phase = status.phase as string

    if (phase === 'embedding' || phase === 'extracting') {
      // Check both batches
      const embStatus = await checkBatch(openai, status.embBatchId)
      const extractStatus = await checkBatch(openai, status.extractBatchId)

      console.log(`[Strata] Poll: emb=${embStatus.status}(${embStatus.completed}/${embStatus.total}), extract=${extractStatus.status}(${extractStatus.completed}/${extractStatus.total})`)

      if (embStatus.status === 'failed' || extractStatus.status === 'failed') {
        await redis.hSet('strata:ingest:status', { phase: 'error', error: 'Batch failed' })
        return c.json({ status: 'ok' })
      }

      if (embStatus.status === 'completed' && extractStatus.status === 'completed') {
        // Both done — download results, build entity embeddings, submit final batch
        console.log('[Strata] Both batches complete. Downloading results...')

        const [embResults, extractResults] = await Promise.all([
          downloadBatchResults(openai, embStatus.outputFileId!),
          downloadBatchResults(openai, extractStatus.outputFileId!),
        ])

        const embeddings = parseEmbeddingResults(embResults)
        const entities = parseExtractionResults(extractResults)

        // Store embeddings + extraction results in Redis for final phase
        await redis.set('strata:ingest:embeddings', JSON.stringify([...embeddings.entries()]))
        await redis.set('strata:ingest:entities', JSON.stringify([...entities.entries()]))

        // Build entity embedding batch
        const entityItems: Array<{ id: string; text: string }> = []
        for (const [itemId, ents] of entities) {
          for (const e of ents) {
            entityItems.push({ id: `${itemId}:${e.surfaceText}`, text: e.surfaceText })
          }
        }

        if (entityItems.length > 0) {
          const entityEmbBatchId = await submitBatch(openai, buildEntityEmbeddingJsonl(entityItems), '/v1/embeddings', 'ingest-entity-emb.jsonl')
          await redis.hSet('strata:ingest:status', { phase: 'entity-embedding', entityEmbBatchId })
          console.log(`[Strata] Entity embedding batch submitted: ${entityEmbBatchId} (${entityItems.length} entities)`)
        } else {
          await redis.hSet('strata:ingest:status', { phase: 'storing' })
        }

        // Schedule next poll
        await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + 120_000), data: {} })
        return c.json({ status: 'ok' })
      }

      // Still processing — poll again in 2 min
      await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + 120_000), data: {} })
      return c.json({ status: 'ok' })
    }

    if (phase === 'entity-embedding') {
      const entEmbStatus = await checkBatch(openai, status.entityEmbBatchId)
      console.log(`[Strata] Poll entity-emb: ${entEmbStatus.status}(${entEmbStatus.completed}/${entEmbStatus.total})`)

      if (entEmbStatus.status === 'failed') {
        await redis.hSet('strata:ingest:status', { phase: 'error', error: 'Entity embedding batch failed' })
        return c.json({ status: 'ok' })
      }

      if (entEmbStatus.status === 'completed') {
        await redis.hSet('strata:ingest:status', { phase: 'storing' })
        // Fall through to storing phase
      } else {
        await scheduler.runJob({ name: 'ingest-batch', runAt: new Date(Date.now() + 120_000), data: {} })
        return c.json({ status: 'ok' })
      }
    }

    if (status.phase === 'storing' || phase === 'entity-embedding') {
      console.log('[Strata] Storing results to Redis...')

      // Load cached results
      const rawItemsJson = await redis.hGetAll('strata:ingest:raw')
      const rawItems: RawItem[] = Object.values(rawItemsJson).map(v => JSON.parse(v))

      const embJson = await redis.get('strata:ingest:embeddings')
      const embeddings = new Map<string, number[]>(JSON.parse(embJson || '[]'))

      const entJson = await redis.get('strata:ingest:entities')
      const entities = new Map<string, Entity[]>(JSON.parse(entJson || '[]'))

      // Download entity embeddings if available
      let entityEmbeddings = new Map<string, number[]>()
      if (status.entityEmbBatchId) {
        const entEmbStatus = await checkBatch(openai, status.entityEmbBatchId)
        if (entEmbStatus.outputFileId) {
          const entEmbResults = await downloadBatchResults(openai, entEmbStatus.outputFileId)
          entityEmbeddings = parseEmbeddingResults(entEmbResults)
        }
      }

      const stored = await storeResults(store, rawItems, embeddings, entities, entityEmbeddings)

      // Cleanup temp keys
      await redis.del('strata:ingest:raw')
      await redis.del('strata:ingest:embeddings')
      await redis.del('strata:ingest:entities')

      await redis.hSet('strata:ingest:status', {
        phase: 'done',
        processed: String(stored),
        endedAt: String(Date.now()),
      })
      console.log(`[Strata] Ingest complete: ${stored} items stored`)
    }
  } catch (err) {
    console.error('[Strata] Ingest poll error:', err)
    await redis.hSet('strata:ingest:status', { phase: 'error', error: String(err) })
  }

  return c.json({ status: 'ok' })
})

// --- Scan ---

app.post('/internal/menu/scan', async (c) => {
  try {
    const itemCount = await store.getItemCount()
    if (itemCount === 0) {
      return c.json<UiResponse>({ showToast: 'No items in store. Ingest data first.' })
    }

    await redis.hSet('strata:scan:status', { phase: 'building', startedAt: String(Date.now()) })
    await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 1000), data: { step: 'build' } })

    return c.json<UiResponse>({ showToast: `Scanning ${itemCount} items for connections...` })
  } catch (err) {
    console.error('[Strata] Scan error:', err)
    return c.json<UiResponse>({ showToast: `Scan error: ${err}` })
  }
})

app.post('/internal/scheduler/scan', async (c) => {
  const input = await c.req.json<any>()
  const step = input.data?.step as string

  try {
    if (step === 'build') {
      const pairs = await buildScanPairs(store)
      if (pairs.length === 0) {
        await redis.hSet('strata:scan:status', { phase: 'done', alerts: '0' })
        console.log('[Strata] Scan: no candidate pairs found')
        return c.json({ status: 'ok' })
      }

      await redis.set('strata:scan:pairs', JSON.stringify(pairs))
      await redis.hSet('strata:scan:status', { phase: 'classifying' })
      await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 1000), data: { step: 'classify', index: 0 } })
      console.log(`[Strata] Scan: ${pairs.length} anchor groups, classifying...`)
    }

    if (step === 'classify') {
      const index = input.data?.index as number
      const pairsJson = await redis.get('strata:scan:pairs')
      if (!pairsJson) return c.json({ status: 'ok' })
      const pairs: ScanPair[] = JSON.parse(pairsJson)

      if (index >= pairs.length) {
        await redis.del('strata:scan:pairs')
        const alertCount = await redis.get('strata:scan:alert-count') || '0'
        await redis.hSet('strata:scan:status', { phase: 'done', alerts: alertCount })
        await redis.del('strata:scan:alert-count')
        console.log(`[Strata] Scan complete: ${alertCount} alerts created`)
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

      const totalCreated = results.reduce((s, n) => s + n, 0)
      if (totalCreated > 0) {
        const count = parseInt(await redis.get('strata:scan:alert-count') || '0', 10)
        await redis.set('strata:scan:alert-count', String(count + totalCreated))
        console.log(`[Strata] Scan: ${totalCreated} alert(s) from ${batch.length} anchors`)
      }

      const nextIndex = index + PARALLEL
      if (nextIndex < pairs.length) {
        await scheduler.runJob({ name: 'scan', runAt: new Date(Date.now() + 2000), data: { step: 'classify', index: nextIndex } })
      } else {
        const alertCount = await redis.get('strata:scan:alert-count') || '0'
        await redis.del('strata:scan:pairs')
        await redis.del('strata:scan:alert-count')
        await redis.hSet('strata:scan:status', { phase: 'done', alerts: alertCount })
        console.log(`[Strata] Scan complete: ${alertCount} alerts created`)
      }
    }
  } catch (err) {
    console.error('[Strata] Scan scheduler error:', err)
    await redis.hSet('strata:scan:status', { phase: 'error', error: String(err) })
  }

  return c.json({ status: 'ok' })
})

// --- API ---

app.get('/api/stats', async (c) => {
  const itemCount = await store.getItemCount()
  const seeded = await redis.get('strata:seed:complete') || '0'
  const installed = await redis.get('strata:installed') || '0'
  return c.json({ itemCount, capacity: 330_000, seeded, installed })
})

app.get('/api/ingest/status', async (c) => {
  const status = await redis.hGetAll('strata:ingest:status')
  if (!status || !status.phase) return c.json({ phase: 'idle' })
  return c.json({
    phase: status.phase,
    totalItems: parseInt(status.totalItems || '0', 10),
    processed: parseInt(status.processed || '0', 10),
    startedAt: parseInt(status.startedAt || '0', 10),
    endedAt: status.endedAt ? parseInt(status.endedAt, 10) : null,
    error: status.error || null,
  })
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
  return c.json({ ...alert, connections })
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

// --- Server ---

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
})
