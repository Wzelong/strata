import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore, cosine, computeHubScores, isGlobal } from '../src/engine/index.js'
import type { RawItem, Item, CostTracker, Entity } from '../src/engine/types.js'
import { embedBatch } from '../src/engine/embed.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const SAMPLE_SIZE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] ?? '3000')
const SKIP_CONFIRM = process.argv.includes('--yes')
const TOP_CLUSTERS = 30

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, '..', 'dataset')
const CACHE_DIR = resolve(__dirname, 'real-data', 'cache')

class SimpleCost implements CostTracker {
  total = 0
  private budget: number
  constructor(budget: number) { this.budget = budget }
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
    if (this.total > this.budget) throw new Error(`Budget exceeded: $${this.total.toFixed(4)} > $${this.budget}`)
  }
  report(): string { return `$${this.total.toFixed(4)}` }
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
  removed_by_category?: string | null
}

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

function toRawItem(item: RawRedditItem): RawItem | null {
  const text = getText(item)
  if (text.length < 30 || text.length > 3000) return null
  if (text === '[removed]' || text === '[deleted]') return null
  if (item.author === 'AutoModerator' || item.author === '[deleted]') return null

  const isPost = item.name?.startsWith('t3_')
  return {
    id: item.name ?? (isPost ? `t3_${item.id}` : `t1_${item.id}`),
    type: isPost ? 'post' : 'comment',
    text,
    authorId: item.author_fullname ?? item.author,
    authorName: item.author,
    createdAt: item.created_utc * 1000,
    threadRootId: item.link_id ?? item.name,
    parentId: isPost ? null : (item.parent_id ?? null),
  }
}

function sampleDeterministic<T>(items: T[], n: number, seed: number = 42): T[] {
  if (items.length <= n) return items
  let s = seed | 0
  const rng = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n)
}

async function confirm(msg: string): Promise<boolean> {
  if (SKIP_CONFIRM) { console.log(msg + ' [auto-confirmed]'); return true }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(msg + ' (y/n): ', answer => { rl.close(); resolve(answer.toLowerCase().startsWith('y')) })
  })
}

async function main() {
  console.log(`\n=== Blind Discovery: r/boston ===`)
  console.log(`Sample: ${SAMPLE_SIZE} items`)
  console.log(`Goal: Find naturally-occurring cross-thread entity clusters\n`)

  // Load data
  const postsFile = resolve(DATA_DIR, 'r_boston_posts.jsonl')
  const commentsFile = resolve(DATA_DIR, 'r_boston_comments.jsonl')
  if (!existsSync(postsFile)) throw new Error(`Missing: ${postsFile}`)
  if (!existsSync(commentsFile)) throw new Error(`Missing: ${commentsFile}`)

  console.log('Loading posts...')
  const rawPosts = await loadNdjsonl(postsFile)
  console.log(`  ${rawPosts.length} raw posts`)
  console.log('Loading comments...')
  const rawComments = await loadNdjsonl(commentsFile)
  console.log(`  ${rawComments.length} raw comments`)

  const allItems: RawItem[] = []
  for (const r of rawPosts) { const item = toRawItem(r); if (item) allItems.push(item) }
  for (const r of rawComments) { const item = toRawItem(r); if (item) allItems.push(item) }
  console.log(`  ${allItems.length} valid items after filtering`)

  const sampled = sampleDeterministic(allItems, SAMPLE_SIZE)
  console.log(`  ${sampled.length} items sampled\n`)

  // Cache
  const cacheId = createHash('sha256').update(sampled.map(i => i.id).sort().join(',')).digest('hex').slice(0, 16)
  const cacheFile = resolve(CACHE_DIR, `boston_${cacheId}.json`)

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cost = new SimpleCost(8.00)
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  let cacheHit = false
  if (existsSync(cacheFile)) {
    try {
      console.log('Loading from cache...')
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      for (const c of cached.items) {
        const raw = sampled.find(i => i.id === c.id)
        if (!raw) continue
        await store.setItem({
          id: raw.id, type: raw.type, text: raw.text,
          textNormalized: c.textNormalized,
          authorId: raw.authorId, authorName: raw.authorName,
          createdAt: raw.createdAt, threadRootId: raw.threadRootId,
          parentId: raw.parentId, entities: c.entities,
          decision: 'pending', decisionAt: null, decisionBy: null, decisionReason: null,
        })
        await store.setEmbedding(raw.id, c.embedding)
        await store.addToEntityIndex(c.entities, raw.id, raw.createdAt)
        await store.addCanonicals(c.entities)
      }
      cacheHit = true
      console.log(`  Loaded ${cached.items.length} items from cache.\n`)
    } catch { console.log('  Cache corrupt, will re-ingest.') }
  }

  if (!cacheHit) {
    const estCost = (sampled.length * 30 / 1_000_000) * 0.02 + (sampled.length * 2 * 200 / 1_000_000) * 0.40 + (sampled.length * 2 * 150 / 1_000_000) * 1.60
    console.log(`Estimated ingestion cost: ~$${estCost.toFixed(2)}`)
    const ok = await confirm(`Proceed? (${sampled.length} items, ~$${estCost.toFixed(2)})`)
    if (!ok) { console.log('Aborted.'); process.exit(0) }

    console.log('\nIngesting...')
    const startTime = Date.now()
    const SAVE_EVERY = 500

    for (let chunk = 0; chunk < sampled.length; chunk += SAVE_EVERY) {
      const batch = sampled.slice(chunk, chunk + SAVE_EVERY)
      await engine.ingestBatch(batch)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  ${Math.min(chunk + SAVE_EVERY, sampled.length)}/${sampled.length} (${elapsed}s, ${cost.report()})`)

      const cacheData: Array<{ id: string; textNormalized: string; entities: Entity[]; embedding: number[] }> = []
      for (const item of sampled.slice(0, chunk + SAVE_EVERY)) {
        const stored = await store.getItem(item.id)
        const emb = await store.getEmbedding(item.id)
        if (stored && emb) cacheData.push({ id: item.id, textNormalized: stored.textNormalized, entities: stored.entities, embedding: emb })
      }
      writeFileSync(cacheFile, JSON.stringify({ version: cacheId, items: cacheData }))
    }
    console.log(`  Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Cost: ${cost.report()}\n`)
  }

  // ============================================================
  // PHASE 1: Entity Cluster Discovery (existing approach — hub-filtered)
  // ============================================================
  console.log('=== Phase 1: Entity Cluster Discovery ===\n')

  const hubScores = await computeHubScores(store)
  const entityIndex = new Map<string, Set<string>>()
  const allItemIds = await store.getItemIds()

  for (const id of allItemIds) {
    const item = await store.getItem(id)
    if (!item) continue
    for (const e of item.entities) {
      if (!isGlobal(e, hubScores)) continue
      const key = `${e.type}:${e.canonical}`
      if (!entityIndex.has(key)) entityIndex.set(key, new Set())
      entityIndex.get(key)!.add(id)
    }
  }

  // Hub report
  const hubs = [...hubScores.entries()].filter(([_, score]) => score > 0.15).sort((a, b) => b[1] - a[1])
  console.log(`Hubs filtered (score > 0.15): ${hubs.length}`)
  for (const [key, score] of hubs.slice(0, 10)) {
    console.log(`  ${key}: ${score.toFixed(3)}`)
  }

  // Clusters: 3+ items, 2+ authors, across 2+ threads
  type Cluster = { key: string; type: string; canonical: string; itemIds: string[]; authorCount: number; threadCount: number }
  const clusters: Cluster[] = []

  for (const [key, ids] of entityIndex) {
    if (ids.size < 3) continue
    const authors = new Set<string>()
    const threads = new Set<string>()
    for (const id of ids) {
      const item = await store.getItem(id)
      if (item) { authors.add(item.authorId); threads.add(item.threadRootId) }
    }
    if (authors.size < 2) continue
    if (threads.size < 2) continue
    const [type, ...canonicalParts] = key.split(':')
    clusters.push({ key, type, canonical: canonicalParts.join(':'), itemIds: [...ids], authorCount: authors.size, threadCount: threads.size })
  }

  clusters.sort((a, b) => b.threadCount - a.threadCount || b.itemIds.length - a.itemIds.length)
  console.log(`\nCross-thread clusters (3+ items, 2+ authors, 2+ threads): ${clusters.length}`)
  console.log(`\nTop ${TOP_CLUSTERS} most interesting clusters:\n`)

  for (const c of clusters.slice(0, TOP_CLUSTERS)) {
    console.log(`  ${c.type}:${c.canonical} — ${c.itemIds.length} items, ${c.authorCount} authors, ${c.threadCount} threads`)
  }

  // ============================================================
  // PHASE 2: Deep-dive top 5 clusters — show the actual connections
  // ============================================================
  console.log(`\n\n=== Phase 2: Deep Dive — Top 5 Clusters ===\n`)

  for (const cluster of clusters.slice(0, 5)) {
    console.log(`\n${'─'.repeat(70)}`)
    console.log(`CLUSTER: ${cluster.type}:${cluster.canonical}`)
    console.log(`Items: ${cluster.itemIds.length} | Authors: ${cluster.authorCount} | Threads: ${cluster.threadCount}`)
    console.log(`${'─'.repeat(70)}`)

    for (const itemId of cluster.itemIds.slice(0, 6)) {
      const item = await store.getItem(itemId)
      if (!item) continue
      const snippet = item.text.replace(/\n/g, ' ').slice(0, 150)
      console.log(`\n  [${item.type}] ${item.authorName} (thread: ${item.threadRootId})`)
      console.log(`  "${snippet}..."`)
    }
  }

  // ============================================================
  // PHASE 3: Entity-Embedding cross-match (NEW PIPELINE)
  // Find items that share SIMILAR (not identical) entities across threads
  // ============================================================
  console.log(`\n\n=== Phase 3: Entity-Embedding Cross-Match ===`)
  console.log(`(Finding items with similar but not identical entities across threads)\n`)

  // Collect all entities with their item context
  type EntityRecord = { type: string; surfaceText: string; canonical: string; itemId: string; threadId: string; authorId: string }
  const allEntities: EntityRecord[] = []

  for (const id of allItemIds) {
    const item = await store.getItem(id)
    if (!item) continue
    for (const e of item.entities) {
      if (!isGlobal(e, hubScores)) continue
      allEntities.push({ type: e.type, surfaceText: e.surfaceText, canonical: e.canonical, itemId: id, threadId: item.threadRootId, authorId: item.authorId })
    }
  }

  console.log(`Total global entities: ${allEntities.length}`)

  // Group by type
  const byType = new Map<string, EntityRecord[]>()
  for (const e of allEntities) {
    if (!byType.has(e.type)) byType.set(e.type, [])
    byType.get(e.type)!.push(e)
  }

  console.log('Entity counts by type:')
  for (const [type, records] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${type}: ${records.length}`)
  }

  // For types with manageable size, embed and find near-matches across threads
  const INTERESTING_TYPES = ['phone', 'url', 'email', 'username', 'person', 'organization', 'product']
  const EMBED_LIMIT = 500
  const SIMILARITY_THRESHOLD = 0.85

  type NearMatch = { entity1: EntityRecord; entity2: EntityRecord; score: number }
  const crossThreadMatches: NearMatch[] = []

  // Embed all types in one batch for efficiency
  const typeEmbedJobs: Array<{ type: string; records: EntityRecord[]; uniqueTexts: string[] }> = []
  for (const type of INTERESTING_TYPES) {
    const records = byType.get(type)
    if (!records || records.length < 2) continue
    const subset = records.slice(0, EMBED_LIMIT)
    const uniqueTexts = [...new Set(subset.map(r => r.surfaceText))]
    if (uniqueTexts.length < 2) continue
    typeEmbedJobs.push({ type, records: subset, uniqueTexts })
  }

  const allTextsToEmbed = typeEmbedJobs.flatMap(j => j.uniqueTexts)
  console.log(`  Embedding ${allTextsToEmbed.length} unique entities across ${typeEmbedJobs.length} types in one batch...`)
  const allEntityEmbs = await embedBatch(client, allTextsToEmbed, cost)

  let offset = 0
  for (const job of typeEmbedJobs) {
    const textToEmb = new Map<string, number[]>()
    for (let i = 0; i < job.uniqueTexts.length; i++) {
      textToEmb.set(job.uniqueTexts[i], allEntityEmbs[offset + i])
    }
    offset += job.uniqueTexts.length

    for (let i = 0; i < job.records.length; i++) {
      for (let j = i + 1; j < job.records.length; j++) {
        if (job.records[i].threadId === job.records[j].threadId) continue
        if (job.records[i].canonical === job.records[j].canonical) continue
        if (job.records[i].surfaceText === job.records[j].surfaceText) continue

        const emb1 = textToEmb.get(job.records[i].surfaceText)!
        const emb2 = textToEmb.get(job.records[j].surfaceText)!
        const score = cosine(emb1, emb2)

        if (score >= SIMILARITY_THRESHOLD) {
          crossThreadMatches.push({ entity1: job.records[i], entity2: job.records[j], score })
        }
      }
    }

    console.log(`    ${job.type}: ${job.uniqueTexts.length} unique texts, ${crossThreadMatches.length} matches so far`)
  }

  crossThreadMatches.sort((a, b) => b.score - a.score)

  console.log(`\n\nCross-thread near-matches (similar but not identical, score ≥ ${SIMILARITY_THRESHOLD}):`)
  console.log(`Found: ${crossThreadMatches.length}\n`)

  const shown = new Set<string>()
  let count = 0
  for (const m of crossThreadMatches) {
    const pairKey = [m.entity1.itemId, m.entity2.itemId].sort().join('|')
    if (shown.has(pairKey)) continue
    shown.add(pairKey)
    if (count >= 20) break
    count++

    const item1 = await store.getItem(m.entity1.itemId)
    const item2 = await store.getItem(m.entity2.itemId)
    const snippet1 = item1?.text.replace(/\n/g, ' ').slice(0, 100) ?? ''
    const snippet2 = item2?.text.replace(/\n/g, ' ').slice(0, 100) ?? ''

    console.log(`  ${m.score.toFixed(4)} | ${m.entity1.type}`)
    console.log(`    "${m.entity1.surfaceText}" [${m.entity1.itemId}] — "${snippet1}..."`)
    console.log(`    "${m.entity2.surfaceText}" [${m.entity2.itemId}] — "${snippet2}..."`)
    console.log()
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log(`\n=== Summary ===`)
  console.log(`Items processed: ${sampled.length}`)
  console.log(`Hubs filtered: ${hubs.length}`)
  console.log(`Exact-canonical clusters (cross-thread): ${clusters.length}`)
  console.log(`Entity-embedding near-matches (cross-thread): ${crossThreadMatches.length}`)
  console.log(`Total cost: ${cost.report()}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
