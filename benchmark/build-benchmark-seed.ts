// Build benchmark-seed.json from raw Reddit JSONL + planted signal items.
//
// Produces the ~10K-item corpus that stability-10x.ts expects.
// Requires: OPENAI_API_KEY, dataset/r_boston_posts.jsonl, dataset/r_boston_comments.jsonl
//
// Run:  tsx --env-file=.env benchmark/build-benchmark-seed.ts
//
// Env:
//   SEED_MIN_TOTAL  target item count (default 10000)
//   POST_BUDGET     initial post budget per stratified sample pass (default 600)
//   OUTPUT          output path (default benchmark/benchmark-seed.json)

import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { BACKFILL_ITEMS, REMOVED_ITEMS } from '../dataset/signal-items.js'
import { LABELED_CASE_ITEMS } from '../dataset/labeled-cases.js'
import type { RawItem, StoredItem, Entity, CostTracker } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const POSTS_FILE = resolve(process.cwd(), 'dataset/r_boston_posts.jsonl')
const COMMENTS_FILE = resolve(process.cwd(), 'dataset/r_boston_comments.jsonl')
const OUTPUT = resolve(process.cwd(), process.env.OUTPUT ?? 'benchmark/benchmark-seed.json')
const POST_BUDGET = parseInt(process.env.POST_BUDGET ?? '600', 10)
const MIN_TOTAL_ITEMS = parseInt(process.env.SEED_MIN_TOTAL ?? '10000', 10)
const WINDOW_DAYS = 30
const DAY_MS = 86_400_000

function recencyBoost(daysAgo: number): number {
  if (daysAgo < 1) return 1.6
  if (daysAgo < 3) return 1.3
  if (daysAgo < 7) return 1.0
  return 0.55
}

function stratifiedSample(rawItems: RawItem[], postBudget: number): RawItem[] {
  if (rawItems.length === 0) return []
  let maxTs = 0
  for (const i of rawItems) if (i.createdAt > maxTs) maxTs = i.createdAt
  const minTs = maxTs - WINDOW_DAYS * DAY_MS

  const dayPosts = new Map<number, RawItem[]>()
  for (const i of rawItems) {
    if (i.type !== 'post' || i.createdAt < minTs) continue
    const d = Math.floor((maxTs - i.createdAt) / DAY_MS)
    const list = dayPosts.get(d)
    if (list) list.push(i); else dayPosts.set(d, [i])
  }

  let totalWeight = 0
  for (const [d, list] of dayPosts) totalWeight += list.length * recencyBoost(d)

  const keptPosts: RawItem[] = []
  for (const [d, list] of dayPosts) {
    const target = Math.round((list.length * recencyBoost(d) / totalWeight) * postBudget)
    const n = Math.min(list.length, Math.max(1, target))
    const shuffled = [...list].sort(() => Math.random() - 0.5)
    keptPosts.push(...shuffled.slice(0, n))
  }

  const keptPostIds = new Set(keptPosts.map(p => p.id))
  const keptComments = rawItems.filter(i => i.type === 'comment' && keptPostIds.has(i.threadRootId))
  return [...keptPosts, ...keptComments]
}

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

type RawRedditItem = {
  id: string
  author: string
  author_fullname?: string
  body?: string
  selftext?: string
  title?: string
  created_utc: number
  link_id?: string
  parent_id?: string
  name: string
}

async function loadJsonl(path: string): Promise<RawRedditItem[]> {
  const items: RawRedditItem[] = []
  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try { items.push(JSON.parse(line)) } catch {}
  }
  return items
}

function toRawItem(r: RawRedditItem, postTitles: Map<string, string>): RawItem | null {
  const isPost = (r.name ?? '').startsWith('t3_')
  const id = r.name ?? (isPost ? `t3_${r.id}` : `t1_${r.id}`)

  if (isPost) {
    const text = r.selftext ?? ''
    if ((!r.title && !text) || text === '[removed]' || text === '[deleted]') return null
    if ((r.title ?? '').length + text.length < 20) return null
    return {
      id, type: 'post', title: r.title, text,
      authorId: r.author_fullname ?? r.author, authorName: r.author,
      createdAt: r.created_utc * 1000, threadRootId: id, parentId: null,
    }
  } else {
    const text = r.body ?? ''
    if (!text || text === '[removed]' || text === '[deleted]') return null
    if (text.length < 20) return null
    const threadRootId = r.link_id ?? id
    const parentTitle = postTitles.get(threadRootId)
    return {
      id, type: 'comment', title: parentTitle, text,
      authorId: r.author_fullname ?? r.author, authorName: r.author,
      createdAt: r.created_utc * 1000, threadRootId, parentId: r.parent_id ?? null,
    }
  }
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cost = new SimpleCost()
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  console.log('=== Build Benchmark Seed (~10K items) ===\n')

  console.log('Loading raw posts...')
  const rawPosts = await loadJsonl(POSTS_FILE)
  console.log(`  ${rawPosts.length} posts`)
  console.log('Loading raw comments...')
  const rawComments = await loadJsonl(COMMENTS_FILE)
  console.log(`  ${rawComments.length} comments`)

  const postTitles = new Map<string, string>()
  for (const r of rawPosts) {
    const id = r.name ?? `t3_${r.id}`
    if (r.title) postTitles.set(id, r.title)
  }

  const allRaw: RawItem[] = []
  for (const r of rawPosts) { const item = toRawItem(r, postTitles); if (item) allRaw.push(item) }
  for (const r of rawComments) { const item = toRawItem(r, postTitles); if (item) allRaw.push(item) }

  let selected = stratifiedSample(allRaw, POST_BUDGET)
  let budget = POST_BUDGET
  while (selected.length < MIN_TOTAL_ITEMS && budget < POST_BUDGET * 5) {
    budget += 50
    selected = stratifiedSample(allRaw, budget)
  }
  selected.sort((a, b) => b.createdAt - a.createdAt)
  const postCount = selected.filter(i => i.type === 'post').length
  console.log(`\n  ${allRaw.length} valid items, sampled ${selected.length} (${postCount} posts) over ${WINDOW_DAYS}d`)

  console.log(`\nIngesting ${selected.length} items (embed + extract)...\n`)
  const BATCH = 50
  for (let i = 0; i < selected.length; i += BATCH) {
    const batch = selected.slice(i, i + BATCH)
    for (const raw of batch) await engine.ingest(raw)
    const done = Math.min(i + BATCH, selected.length)
    if (done % 200 === 0 || done === selected.length) {
      console.log(`  ${done}/${selected.length} — $${cost.total.toFixed(4)}`)
    }
  }

  console.log(`\nIngesting ${BACKFILL_ITEMS.length} signal items...`)
  for (const raw of BACKFILL_ITEMS) {
    const item = await engine.ingest(raw)
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }

  console.log(`\nIngesting ${LABELED_CASE_ITEMS.length} labeled-case thread items...`)
  for (const raw of LABELED_CASE_ITEMS) {
    const item = await engine.ingest(raw)
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }

  console.log('\nMarking removed items...')
  for (const [id, meta] of Object.entries(REMOVED_ITEMS)) {
    const item = await store.getItem(id)
    if (!item) { console.log(`  WARNING: ${id} not found`); continue }
    const updated: StoredItem = {
      ...item,
      decision: meta.decision,
      decisionAt: item.createdAt + 3600000,
      decisionBy: meta.decisionBy,
      decisionReason: meta.decisionReason,
    }
    await store.setItem(updated)
    await store.moveDecision(id, 'pending', 'removed', updated.decisionAt!)
    console.log(`  ${id} → removed`)
  }

  console.log('\nAssembling benchmark-seed.json...')
  const allIds = await store.getItemIds()
  const seedItems: StoredItem[] = []
  const seedEmbeddings: Record<string, number[]> = {}
  for (const id of allIds) {
    const item = await store.getItem(id)
    const emb = await store.getEmbedding(id)
    if (item && emb) { seedItems.push(item); seedEmbeddings[id] = emb }
  }

  const ENTITY_TYPES = ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity']
  const seedEntityEmbeddings: Record<string, Record<string, string>> = {}
  for (const type of ENTITY_TYPES) {
    const entries = await store.getEntityEmbeddingsByType(type)
    if (entries.length > 0) {
      seedEntityEmbeddings[type] = {}
      for (const e of entries) seedEntityEmbeddings[type][`${e.itemId}:${e.surfaceText}`] = e.embedding
    }
  }

  const seed = { items: seedItems, embeddings: seedEmbeddings, entityEmbeddings: seedEntityEmbeddings }
  writeFileSync(OUTPUT, JSON.stringify(seed))
  const sizeMB = (Buffer.byteLength(JSON.stringify(seed)) / 1024 / 1024).toFixed(1)

  console.log(`\n=== Done ===`)
  console.log(`  Output: ${OUTPUT} (${sizeMB}MB)`)
  console.log(`  Items:  ${seedItems.length}`)
  console.log(`  Entity embeddings: ${Object.values(seedEntityEmbeddings).reduce((n, v) => n + Object.keys(v).length, 0)}`)
  console.log(`  Cost:   $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
