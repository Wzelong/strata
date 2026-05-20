import { readFileSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore } from '../src/engine/index.js'
import type { RawItem, StoredItem, Entity, CostTracker } from '../src/engine/types.js'
import { BACKFILL_ITEMS, LIVE_ITEMS, REMOVED_ITEMS } from './signal-items.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const __dirname = dirname(fileURLToPath(import.meta.url))
const POSTS_FILE = resolve(__dirname, 'r_boston_posts.jsonl')
const COMMENTS_FILE = resolve(__dirname, 'r_boston_comments.jsonl')
const SEED_OUTPUT = resolve(__dirname, 'seed.json')
const LIVE_OUTPUT = resolve(__dirname, 'live-items.json')

const MAX_ITEMS = parseInt(process.env.SEED_LIMIT ?? '3000', 10)

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

function getText(item: RawRedditItem): string {
  if (item.selftext !== undefined && item.selftext !== '') {
    return item.title ? `${item.title}\n\n${item.selftext}` : item.selftext
  }
  return item.body ?? ''
}

function toRawItem(r: RawRedditItem): RawItem | null {
  const isPost = (r.name ?? '').startsWith('t3_')
  const text = getText(r)
  if (!text || text === '[removed]' || text === '[deleted]') return null
  if (text.length < 20) return null

  return {
    id: r.name ?? (isPost ? `t3_${r.id}` : `t1_${r.id}`),
    type: isPost ? 'post' : 'comment',
    text,
    authorId: r.author_fullname ?? r.author,
    authorName: r.author,
    createdAt: r.created_utc * 1000,
    threadRootId: r.link_id ?? r.name,
    parentId: isPost ? null : (r.parent_id ?? null),
  }
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cost = new SimpleCost()
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  console.log('=== Build Seed (fresh extraction) ===\n')

  // Step 1: Load raw reddit data
  console.log('Loading raw posts...')
  const rawPosts = await loadJsonl(POSTS_FILE)
  console.log(`  ${rawPosts.length} posts`)
  console.log('Loading raw comments...')
  const rawComments = await loadJsonl(COMMENTS_FILE)
  console.log(`  ${rawComments.length} comments`)

  // Step 2: Convert to RawItems, take up to MAX_ITEMS
  const allRaw: RawItem[] = []
  for (const r of rawPosts) {
    const item = toRawItem(r)
    if (item) allRaw.push(item)
  }
  for (const r of rawComments) {
    const item = toRawItem(r)
    if (item) allRaw.push(item)
  }

  // Sort by time, take newest MAX_ITEMS
  allRaw.sort((a, b) => b.createdAt - a.createdAt)
  const selected = allRaw.slice(0, MAX_ITEMS)
  console.log(`\n  ${allRaw.length} valid items total, selected ${selected.length}`)

  // Step 3: Ingest through the engine (embeds + extracts entities)
  console.log(`\nIngesting ${selected.length} r/boston items (embed + extract)...`)
  console.log('  This will take a while for entity extraction...\n')

  const BATCH = 50
  for (let i = 0; i < selected.length; i += BATCH) {
    const batch = selected.slice(i, i + BATCH)
    await engine.ingestBatch(batch)
    const done = Math.min(i + BATCH, selected.length)
    if (done % 200 === 0 || done === selected.length) {
      console.log(`  ${done}/${selected.length} — cost: $${cost.total.toFixed(4)}`)
    }
  }

  // Step 4: Ingest backfill signal items
  console.log(`\nIngesting ${BACKFILL_ITEMS.length} signal items...`)
  for (const raw of BACKFILL_ITEMS) {
    const item = await engine.ingest(raw)
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }

  // Step 5: Mark FLAG-3 as removed
  console.log('\nMarking FLAG-3 items as removed...')
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

  // Step 6: Write seed.json
  console.log('\nAssembling seed.json...')
  const allIds = await store.getItemIds()
  const seedItems: StoredItem[] = []
  const seedEmbeddings: Record<string, number[]> = {}

  for (const id of allIds) {
    const item = await store.getItem(id)
    const emb = await store.getEmbedding(id)
    if (item && emb) {
      seedItems.push(item)
      seedEmbeddings[id] = emb
    }
  }

  const seed = { items: seedItems, embeddings: seedEmbeddings }
  writeFileSync(SEED_OUTPUT, JSON.stringify(seed))
  const sizeMB = (Buffer.byteLength(JSON.stringify(seed)) / 1024 / 1024).toFixed(1)
  console.log(`  ${SEED_OUTPUT} (${sizeMB}MB, ${seedItems.length} items)`)

  // Step 7: Process live items
  console.log(`\nProcessing ${LIVE_ITEMS.length} live items...`)
  const liveResults: Array<{ id: string; textNormalized: string; embedding: number[]; entities: Entity[] }> = []

  for (const raw of LIVE_ITEMS) {
    const item = await engine.ingest(raw)
    liveResults.push({ id: item.id, textNormalized: item.textNormalized, embedding: item.embedding, entities: item.entities })
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }

  writeFileSync(LIVE_OUTPUT, JSON.stringify({ items: liveResults }, null, 2))
  console.log(`  ${LIVE_OUTPUT}`)

  console.log(`\n=== Done ===`)
  console.log(`  Seed: ${seedItems.length} items`)
  console.log(`  Live: ${liveResults.length} items`)
  console.log(`  Cost: $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
