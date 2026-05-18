import { readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore, cosine, isGlobal, computeHubScores } from '../src/engine/index.js'
import type { RawItem, Item, CostTracker } from '../src/engine/types.js'

const SUBREDDIT = process.argv.find(a => a.startsWith('--subreddit='))?.split('=')[1] ?? 'scams'
const SAMPLE_SIZE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] ?? '3000')
const SKIP_CONFIRM = process.argv.includes('--yes')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, 'real-data')
const CACHE_DIR = resolve(__dirname, 'real-data', 'cache')

class SimpleCostTracker implements CostTracker {
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
    try { items.push(JSON.parse(line)) } catch { /* skip malformed */ }
  }
  return items
}

function getText(item: RawRedditItem): string {
  if (item.selftext !== undefined) {
    return item.title ? `${item.title}\n\n${item.selftext}` : item.selftext
  }
  return item.body ?? ''
}

function toRawItem(item: RawRedditItem): RawItem | null {
  const text = getText(item)
  if (text.length < 20 || text.length > 3000) return null
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
  if (SKIP_CONFIRM) { console.log(msg + ' [auto-confirmed with --yes]'); return true }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(msg + ' (y/n): ', answer => {
      rl.close()
      resolve(answer.toLowerCase().startsWith('y'))
    })
  })
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

  console.log(`\n=== Strata Real-Data Validation ===`)
  console.log(`Subreddit: r/${SUBREDDIT}`)
  console.log(`Sample size: ${SAMPLE_SIZE}\n`)

  // --- Load data ---
  const postsFile = resolve(DATA_DIR, `r_${SUBREDDIT}_posts.jsonl`)
  const commentsFile = resolve(DATA_DIR, `r_${SUBREDDIT}_comments.jsonl`)

  if (!existsSync(postsFile)) throw new Error(`Missing: ${postsFile}`)
  if (!existsSync(commentsFile)) throw new Error(`Missing: ${commentsFile}`)

  console.log('Loading posts...')
  const rawPosts = await loadNdjsonl(postsFile)
  console.log(`  ${rawPosts.length} raw posts`)

  console.log('Loading comments...')
  const rawComments = await loadNdjsonl(commentsFile)
  console.log(`  ${rawComments.length} raw comments`)

  // --- Convert + filter ---
  const allItems: RawItem[] = []
  for (const r of rawPosts) { const item = toRawItem(r); if (item) allItems.push(item) }
  for (const r of rawComments) { const item = toRawItem(r); if (item) allItems.push(item) }
  console.log(`  ${allItems.length} valid items after filtering`)

  const sampled = sampleDeterministic(allItems, SAMPLE_SIZE)
  console.log(`  ${sampled.length} items sampled for processing`)

  // --- Cache check ---
  const cacheId = createHash('sha256').update(sampled.map(i => i.id).sort().join(',')).digest('hex').slice(0, 16)
  const cacheFile = resolve(CACHE_DIR, `${SUBREDDIT}_${cacheId}.json`)

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const cost = new SimpleCostTracker(10.00)
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  let cacheHit = false
  if (existsSync(cacheFile)) {
    try {
      console.log('\nLoading from cache...')
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
      console.log(`  Loaded ${cached.items.length} items from cache.`)
    } catch { console.log('  Cache corrupt, will re-ingest.') }
  }

  if (!cacheHit) {
    const estEmbedCost = (sampled.length * 30 / 1_000_000) * 0.02
    const estExtractCost = (sampled.length * 2 * 200 / 1_000_000) * 0.40 + (sampled.length * 2 * 150 / 1_000_000) * 1.60
    const estTotal = estEmbedCost + estExtractCost

    console.log(`\n--- COST ESTIMATE ---`)
    console.log(`Embedding: ${sampled.length} items → ~$${estEmbedCost.toFixed(3)}`)
    console.log(`Entity extraction: ${sampled.length} × 2 passes → ~$${estExtractCost.toFixed(3)}`)
    console.log(`Total ingestion: ~$${estTotal.toFixed(3)}`)
    console.log(`Classification (later): ~10-20 pairs → ~$0.02`)
    console.log(`Grand total estimate: ~$${(estTotal + 0.02).toFixed(3)}`)
    console.log(`--------------------`)

    const ok = await confirm(`\nProceed with ingestion? (${sampled.length} items, ~$${estTotal.toFixed(2)})`)
    if (!ok) { console.log('Aborted.'); process.exit(0) }

    console.log('\nIngesting (two-pass entity extraction, concurrency=100)...')
    const startTime = Date.now()

    const SAVE_EVERY = 500
    let processed = 0

    for (let chunk = 0; chunk < sampled.length; chunk += SAVE_EVERY) {
      const batch = sampled.slice(chunk, chunk + SAVE_EVERY)
      await engine.ingestBatch(batch)
      processed += batch.length
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  ${processed}/${sampled.length} ingested (${elapsed}s, ${cost.report()})`)

      // Progressive cache save
      const cacheData: Array<{ id: string; textNormalized: string; entities: any[]; embedding: number[] }> = []
      for (const item of sampled.slice(0, processed)) {
        const stored = await store.getItem(item.id)
        const emb = await store.getEmbedding(item.id)
        if (stored && emb) {
          cacheData.push({ id: item.id, textNormalized: stored.textNormalized, entities: stored.entities, embedding: emb })
        }
      }
      writeFileSync(cacheFile, JSON.stringify({ version: cacheId, items: cacheData }))
    }

    console.log(`  Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Cost: ${cost.report()}`)
    console.log(`  Cache written: ${cacheFile}`)
  }

  // ===========================================
  // Stage A: Pure Discovery
  // ===========================================
  console.log('\n=== Stage A: Pure Discovery ===')

  // Compute hub scores to filter out overly-common entities
  const hubScores = await computeHubScores(store)

  // Find entity clusters: entities shared by 3+ items from 2+ authors (excluding hubs)
  const entityIndex = new Map<string, Set<string>>() // key → item IDs
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

  // Filter to clusters with 3+ items from 2+ authors
  type Cluster = { key: string; type: string; canonical: string; itemIds: string[]; authorCount: number }
  const clusters: Cluster[] = []

  for (const [key, ids] of entityIndex) {
    if (ids.size < 3) continue
    const authors = new Set<string>()
    for (const id of ids) {
      const item = await store.getItem(id)
      if (item) authors.add(item.authorId)
    }
    if (authors.size < 2) continue
    const [type, ...canonicalParts] = key.split(':')
    clusters.push({ key, type, canonical: canonicalParts.join(':'), itemIds: [...ids], authorCount: authors.size })
  }

  clusters.sort((a, b) => b.itemIds.length - a.itemIds.length)
  const topClusters = clusters.slice(0, 20)

  console.log(`  Total entity keys: ${entityIndex.size}`)
  console.log(`  Clusters (3+ items, 2+ authors): ${clusters.length}`)
  console.log(`  Top 20 clusters:`)
  for (const c of topClusters.slice(0, 10)) {
    console.log(`    ${c.type}:${c.canonical} — ${c.itemIds.length} items, ${c.authorCount} authors`)
  }

  // Retrieval test: for each top cluster, pick first item as "case", run twoStageRetrieve
  console.log(`\n  Running retrieval from top ${Math.min(topClusters.length, 20)} clusters...`)
  let totalRecall = 0
  let testedClusters = 0
  const retrievalResults: Array<{ cluster: string; clusterSize: number; recall: number; top5: string[] }> = []

  for (const cluster of topClusters) {
    const caseItem = await engine.getItem(cluster.itemIds[0])
    if (!caseItem) continue

    const hits = await engine.findConnections(caseItem, 5)
    const hitIds = new Set(hits.map(h => h.item.id))
    const expectedIds = cluster.itemIds.filter(id => id !== caseItem.id)
    const found = expectedIds.filter(id => hitIds.has(id)).length
    const recall = expectedIds.length > 0 ? found / Math.min(expectedIds.length, 5) : 0

    totalRecall += recall
    testedClusters++
    retrievalResults.push({
      cluster: `${cluster.type}:${cluster.canonical}`,
      clusterSize: cluster.itemIds.length,
      recall,
      top5: hits.map(h => h.item.id),
    })
  }

  const avgRecall = testedClusters > 0 ? totalRecall / testedClusters : 0
  console.log(`\n  Retrieval recall (avg across ${testedClusters} clusters): ${(avgRecall * 100).toFixed(1)}%`)

  // Classification on top 5 clusters × top 2 pairs each
  const classifyPairs = Math.min(topClusters.length, 5) * 2
  const estClassifyCost = (classifyPairs * 2 * 500 / 1_000_000) * 0.40 + (classifyPairs * 2 * 100 / 1_000_000) * 1.60
  console.log(`\n  Classification: ${classifyPairs} pairs, est. ~$${estClassifyCost.toFixed(3)}`)

  const okClassify = await confirm(`  Run classification? (${classifyPairs} pairs, ~$${estClassifyCost.toFixed(3)})`)

  const classificationResults: Array<{ caseId: string; hitId: string; relationship: string }> = []
  if (okClassify) {
    for (const cluster of topClusters.slice(0, 5)) {
      const caseItem = await engine.getItem(cluster.itemIds[0])
      if (!caseItem) continue
      const hits = await engine.findConnections(caseItem, 2)
      for (const hit of hits) {
        const rel = await engine.classifyRelationship(caseItem, hit.item)
        classificationResults.push({ caseId: caseItem.id, hitId: hit.item.id, relationship: rel })
      }
    }

    const relCounts: Record<string, number> = {}
    for (const r of classificationResults) {
      relCounts[r.relationship] = (relCounts[r.relationship] ?? 0) + 1
    }
    console.log(`\n  Classification distribution:`)
    for (const [rel, count] of Object.entries(relCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${rel}: ${count}`)
    }
  }

  // ===========================================
  // Stage B: Inject-and-Detect
  // ===========================================
  console.log('\n=== Stage B: Inject-and-Detect ===')

  const injectClusters = topClusters.filter(c => c.itemIds.length >= 4).slice(0, 5)
  if (injectClusters.length < 3) {
    console.log('  Not enough large clusters for inject-and-detect. Skipping.')
  } else {
    console.log(`  Injecting 5 synthetic cases referencing real entities...`)

    const syntheticCases: RawItem[] = injectClusters.map((cluster, i) => ({
      id: `t3_synthetic_${i}`,
      type: 'post' as const,
      text: `Has anyone else encountered ${cluster.canonical.replace(/_/g, ' ')}? I just ran into this and it seems really suspicious. Looking for more info from others who may have dealt with the same thing.`,
      authorId: `synthetic_author_${i}`,
      authorName: `TestUser${i}`,
      createdAt: Date.now(),
      threadRootId: `t3_synthetic_${i}`,
      parentId: null,
    }))

    for (const raw of syntheticCases) {
      await engine.ingest(raw)
    }

    let injectRecallSum = 0
    let injectTested = 0

    for (let i = 0; i < syntheticCases.length; i++) {
      const caseItem = await engine.getItem(syntheticCases[i].id)
      if (!caseItem) continue
      const cluster = injectClusters[i]
      const expectedIds = cluster.itemIds

      const hits = await engine.findConnections(caseItem, 5)
      const hitIds = new Set(hits.map(h => h.item.id))
      const found = expectedIds.filter(id => hitIds.has(id)).length
      const recall = found / Math.min(expectedIds.length, 5)

      injectRecallSum += recall
      injectTested++
      console.log(`    Case ${i}: ${cluster.type}:${cluster.canonical} → recall ${(recall * 100).toFixed(0)}% (${found}/${Math.min(expectedIds.length, 5)})`)
    }

    const avgInjectRecall = injectTested > 0 ? injectRecallSum / injectTested : 0
    console.log(`\n  Inject-and-detect recall@5: ${(avgInjectRecall * 100).toFixed(1)}% (target ≥70%)`)
    console.log(`  ${avgInjectRecall >= 0.7 ? 'PASS' : 'FAIL'}`)
  }

  // ===========================================
  // Summary
  // ===========================================
  console.log(`\n=== Summary ===`)
  console.log(`Subreddit: r/${SUBREDDIT}`)
  console.log(`Items processed: ${sampled.length}`)
  console.log(`Entity clusters found: ${clusters.length}`)
  console.log(`Stage A retrieval recall: ${(avgRecall * 100).toFixed(1)}%`)
  if (classificationResults.length > 0) {
    const related = classificationResults.filter(r => r.relationship !== 'UNRELATED').length
    console.log(`Stage A classification: ${related}/${classificationResults.length} pairs classified as related`)
  }
  console.log(`Total cost: ${cost.report()}`)
  console.log('')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
