import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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
const CACHE_FILE = resolve(__dirname, '..', 'tests', 'real-data', 'cache', 'boston_98290c99d8d108e9.json')
const POSTS_FILE = resolve(__dirname, 'r_boston_posts.jsonl')
const COMMENTS_FILE = resolve(__dirname, 'r_boston_comments.jsonl')
const SEED_OUTPUT = resolve(__dirname, 'seed.json')
const LIVE_OUTPUT = resolve(__dirname, 'live-items.json')

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

type CachedItem = { id: string; textNormalized: string; entities: Entity[]; embedding: number[] }
type RawRedditItem = { id: string; author: string; author_fullname?: string; body?: string; selftext?: string; title?: string; created_utc: number; link_id?: string; parent_id?: string; name: string }

async function loadNdjsonl(path: string): Promise<RawRedditItem[]> {
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

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cost = new SimpleCost()
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  console.log('=== Build Seed ===\n')

  // Step 1: Load the boston cache
  console.log('Loading boston cache...')
  const cache: { version: string; items: CachedItem[] } = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  console.log(`  ${cache.items.length} cached items loaded`)

  // Step 2: Load raw JSONL for metadata
  console.log('Loading raw posts...')
  const rawPosts = await loadNdjsonl(POSTS_FILE)
  console.log(`  ${rawPosts.length} posts`)
  console.log('Loading raw comments...')
  const rawComments = await loadNdjsonl(COMMENTS_FILE)
  console.log(`  ${rawComments.length} comments`)

  const rawById = new Map<string, RawRedditItem>()
  for (const r of rawPosts) rawById.set(r.name ?? `t3_${r.id}`, r)
  for (const r of rawComments) rawById.set(r.name ?? `t1_${r.id}`, r)
  console.log(`  ${rawById.size} items indexed by ID`)

  // Step 3: Join cache + raw → StoredItem and load into store
  console.log('\nBuilding StoredItems from cache + raw...')
  let joined = 0
  let missed = 0

  for (const cached of cache.items) {
    const raw = rawById.get(cached.id)
    if (!raw) { missed++; continue }

    const isPost = cached.id.startsWith('t3_')
    const text = getText(raw)
    if (!text || text === '[removed]' || text === '[deleted]') { missed++; continue }

    const stored: StoredItem = {
      id: cached.id,
      type: isPost ? 'post' : 'comment',
      text,
      textNormalized: cached.textNormalized,
      authorId: raw.author_fullname ?? raw.author,
      authorName: raw.author,
      createdAt: raw.created_utc * 1000,
      threadRootId: raw.link_id ?? raw.name,
      parentId: isPost ? null : (raw.parent_id ?? null),
      entities: cached.entities,
      decision: 'pending',
      decisionAt: null,
      decisionBy: null,
      decisionReason: null,
    }

    await store.setItem(stored)
    await store.setEmbedding(cached.id, cached.embedding)
    await store.addToEntityIndex(cached.entities, cached.id, stored.createdAt)
    await store.addCanonicals(cached.entities)
    joined++
  }

  console.log(`  Joined: ${joined}, Missed (no raw match): ${missed}`)

  // Step 4: Ingest BACKFILL signal items through the engine (uses existing registry)
  console.log(`\nIngesting ${BACKFILL_ITEMS.length} backfill signal items...`)
  const backfillResults: Array<{ id: string; embedding: number[]; entities: Entity[] }> = []

  for (const raw of BACKFILL_ITEMS) {
    const item = await engine.ingest(raw)
    backfillResults.push({ id: item.id, embedding: item.embedding, entities: item.entities })
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }
  console.log(`  Cost: $${cost.total.toFixed(4)}`)

  // Step 5: Set FLAG-3 items to 'removed'
  console.log('\nMarking FLAG-3 items as removed...')
  for (const [id, meta] of Object.entries(REMOVED_ITEMS)) {
    const item = await store.getItem(id)
    if (!item) { console.log(`  WARNING: ${id} not found`); continue }
    const updated: StoredItem = { ...item, decision: meta.decision, decisionAt: item.createdAt + 3600000, decisionBy: meta.decisionBy, decisionReason: meta.decisionReason }
    await store.setItem(updated)
    await store.moveDecision(id, 'pending', 'removed', updated.decisionAt!)
    console.log(`  ${id} → removed`)
  }

  // Step 6: Assemble seed payload
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

  const canonicals = await store.getCanonicals()
  const canonicalsObj: Record<string, string[]> = {}
  for (const [type, list] of canonicals) {
    canonicalsObj[type] = list
  }

  const seed = { items: seedItems, embeddings: seedEmbeddings, canonicals: canonicalsObj }
  writeFileSync(SEED_OUTPUT, JSON.stringify(seed))
  const sizeMB = (Buffer.byteLength(JSON.stringify(seed)) / 1024 / 1024).toFixed(1)
  console.log(`  Written: ${SEED_OUTPUT} (${sizeMB}MB, ${seedItems.length} items)`)

  // Step 7: Process LIVE items (pre-compute for demo reliability)
  console.log(`\nProcessing ${LIVE_ITEMS.length} live items...`)
  const liveResults: Array<{ id: string; textNormalized: string; embedding: number[]; entities: Entity[] }> = []

  for (const raw of LIVE_ITEMS) {
    const item = await engine.ingest(raw)
    liveResults.push({ id: item.id, textNormalized: item.textNormalized, embedding: item.embedding, entities: item.entities })
    console.log(`  ${item.id}: ${item.entities.length} entities`)
  }

  writeFileSync(LIVE_OUTPUT, JSON.stringify({ items: liveResults }, null, 2))
  console.log(`  Written: ${LIVE_OUTPUT}`)

  // Summary
  console.log(`\n=== Done ===`)
  console.log(`Total items in seed: ${seedItems.length}`)
  console.log(`Live items pre-computed: ${liveResults.length}`)
  console.log(`Total cost: $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
