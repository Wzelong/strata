import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createServer, getServerPort, redis, reddit, context, settings } from '@devvit/web/server'
import type { MenuItemRequest, UiResponse, TriggerResponse } from '@devvit/web/shared'
import OpenAI from 'openai'
import { StrataEngine } from '../engine/index.js'
import { RedisKVStore, type RedisClient } from '../engine/storage/redis.js'
import type { RawItem, Item, Hit } from '../engine/types.js'

const app = new Hono()

const redisClient: RedisClient = {
  hSet: (key, fieldValues) => redis.hSet(key, fieldValues),
  hGet: (key, field) => redis.hGet(key, field),
  hGetAll: (key) => redis.hGetAll(key),
  zAdd: (key, ...members) => redis.zAdd(key, ...members),
  zRange: (key, start, stop, options) => redis.zRange(key, start, stop, options),
  zRem: (key, members) => redis.zRem(key, members),
}

const store = new RedisKVStore(redisClient)

async function getEngine(): Promise<StrataEngine> {
  const apiKey = await settings.get('openaiApiKey')
  if (!apiKey) throw new Error('OpenAI API key not configured')
  const client = new OpenAI({ apiKey: apiKey as string })
  return new StrataEngine(store, client)
}

function formatConnections(hits: Array<{ item: Item; relationship: string }>): string {
  if (hits.length === 0) return 'No connections found.'
  return hits.map((h, i) => {
    const snippet = h.item.text.replace(/\n/g, ' ').slice(0, 150)
    const date = new Date(h.item.createdAt).toLocaleDateString()
    return `**${i + 1}. ${h.relationship}** — ${h.item.authorName} (${date})\n> ${snippet}...`
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
    const text = post.body ? `${post.title}\n\n${post.body}` : post.title
    const raw: RawItem = {
      id: post.id,
      type: 'post',
      text,
      authorId: post.authorId || post.author || 'unknown',
      authorName: post.author || 'unknown',
      createdAt: Date.now(),
      threadRootId: post.id,
      parentId: null,
    }

    console.log(`[Strata] Ingesting post ${post.id}: "${text.slice(0, 60)}..."`)
    const item = await engine.ingest(raw)

    const similar = await engine.findSimilar(item.embedding, 10, { excludeIds: new Set([item.id]) })
    console.log(`[Strata] Found ${similar.length} similar items`)

    const connections: Array<{ item: Item; relationship: string }> = []
    for (const hit of similar.slice(0, 5)) {
      if (hit.weight < 0.55) break
      const rel = await engine.classifyRelationship(item, hit.item)
      if (rel !== 'UNRELATED') {
        connections.push({ item: hit.item, relationship: rel })
      }
    }

    console.log(`[Strata] ${connections.length} related items after classification`)

    if (connections.length > 0 && context.subredditName) {
      const body = `Strata found **${connections.length} buried connection(s)** related to a new post:\n\n**"${post.title}"** by u/${post.author}\n\n---\n\n${formatConnections(connections)}\n\n---\n\n*These items were posted in unrelated threads but share key details with this post.*`

      await reddit.modMail.createConversation({
        subredditName: context.subredditName,
        subject: `[Strata] ${connections.length} connections found: "${post.title.slice(0, 50)}"`,
        body,
        to: null as any,
      })
      console.log(`[Strata] Modmail sent — ${connections.length} connections`)
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
  const existing = await redis.get('strata:seed:complete')
  if (existing) {
    const count = await redis.get('strata:seed:item-count')
    return c.json<UiResponse>({
      showToast: { text: `Already seeded: ${count} items`, appearance: 'success' },
    })
  }

  return c.json<UiResponse>({
    showForm: {
      name: 'seedResults',
      form: {
        title: 'Seed Strata Data',
        acceptLabel: 'Start Seeding',
        fields: [
          { name: 'confirm', label: 'This will fetch and load ~3,000 items into Redis (~16MB). Takes about 30 seconds.', type: 'paragraph' as const, defaultValue: 'Click "Start Seeding" to proceed.' },
        ],
      },
    },
  })
})

app.post('/internal/forms/seed-results', async (c) => {
  const existing = await redis.get('strata:seed:complete')
  if (existing) {
    return c.json<UiResponse>({ showToast: 'Already seeded.' })
  }

  try {
    console.log('[Strata] Fetching seed.json from GitHub...')
    const url = 'https://raw.githubusercontent.com/Wzelong/strata/main/dataset/seed.json'
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`)

    const seed = await resp.json() as {
      items: StoredItem[]
      embeddings: Record<string, number[]>
      canonicals: Record<string, string[]>
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
          await redis.zAdd(`strata:idx:entity:${e.type}:${e.canonical}`, { member: item.id, score: item.createdAt })
        }
      }

      if ((i + BATCH) % 500 === 0 || i + BATCH >= seed.items.length) {
        console.log(`[Strata] Seeded ${Math.min(i + BATCH, seed.items.length)}/${seed.items.length}`)
      }
    }

    const canonFields: Record<string, string> = {}
    for (const [type, list] of Object.entries(seed.canonicals)) {
      canonFields[type] = JSON.stringify(list)
    }
    if (Object.keys(canonFields).length > 0) {
      await redis.hSet('strata:canonicals', canonFields)
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


// --- API ---

app.get('/api/stats', async (c) => {
  const itemCount = await redis.get('strata:seed:item-count') || '0'
  const seeded = await redis.get('strata:seed:complete') || '0'
  const installed = await redis.get('strata:installed') || '0'
  return c.json({ itemCount, seeded, installed })
})

// --- Server ---

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
})
