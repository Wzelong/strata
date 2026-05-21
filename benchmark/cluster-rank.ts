import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cosine, dequantize } from '../src/engine/embed.js'
import { stringSimilarity } from '../src/engine/search.js'
import { ALL_SIGNAL_IDS } from '../dataset/signal-items.js'
import type { StoredItem } from '../src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-seed.json'), 'utf8'))
const liveData = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-live-items.json'), 'utf8'))

// Load items + embeddings
type ItemData = { id: string; embedding: number[]; threadRootId: string; authorId: string; entities: Array<{ type: string; surfaceText: string }> }
const items: ItemData[] = []
const itemMap = new Map<string, StoredItem>()

for (const item of seed.items) {
  itemMap.set(item.id, item)
  const emb = seed.embeddings[item.id]
  if (emb) items.push({ id: item.id, embedding: emb, threadRootId: item.threadRootId, authorId: item.authorId, entities: item.entities })
}
for (const raw of liveData.items) {
  if (itemMap.has(raw.id)) continue
  items.push({ id: raw.id, embedding: raw.embedding, threadRootId: raw.id, authorId: raw.id, entities: raw.entities })
}

const itemIdx = new Map(items.map((item, i) => [item.id, i]))

// LSH + union-find at 0.65
const NUM_TABLES = 25
const BITS_PER_TABLE = 8
const DIM = 256
const THRESHOLD = 0.65

function dot(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s
}

const planes: number[][] = []
for (let i = 0; i < NUM_TABLES * BITS_PER_TABLE; i++) {
  planes.push(Array.from({ length: DIM }, () => Math.random() * 2 - 1))
}

const tables: Map<number, number[]>[] = Array.from({ length: NUM_TABLES }, () => new Map())
for (let i = 0; i < items.length; i++) {
  for (let t = 0; t < NUM_TABLES; t++) {
    let hash = 0
    for (let b = 0; b < BITS_PER_TABLE; b++) {
      hash = (hash << 1) | (dot(items[i].embedding, planes[t * BITS_PER_TABLE + b]) > 0 ? 1 : 0)
    }
    const bucket = tables[t].get(hash)
    if (bucket) bucket.push(i)
    else tables[t].set(hash, [i])
  }
}

const seen = new Set<string>()
const parent = Array.from({ length: items.length }, (_, i) => i)
function find(x: number): number { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
function union(a: number, b: number) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

for (let t = 0; t < NUM_TABLES; t++) {
  for (const bucket of tables[t].values()) {
    if (bucket.length < 2 || bucket.length > 100) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j]
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        if (seen.has(key)) continue
        seen.add(key)
        if (cosine(items[a].embedding, items[b].embedding) >= THRESHOLD) union(a, b)
      }
    }
  }
}

const clusterMap = new Map<number, number[]>()
for (let i = 0; i < items.length; i++) {
  const root = find(i)
  if (!clusterMap.has(root)) clusterMap.set(root, [])
  clusterMap.get(root)!.push(i)
}

const clusters = [...clusterMap.values()]
  .filter(c => c.length >= 2 && c.length <= 50)
  .map(indices => indices.map(i => items[i]))

console.log(`Clusters (2-50 items): ${clusters.length}`)

// Rank each cluster
type RankedCluster = {
  items: ItemData[]
  crossThreadRatio: number
  authorDiversity: number
  avgTightness: number
  sharedEntityScore: number
  score: number
  hasSignal: boolean
}

const ranked: RankedCluster[] = []

for (const cluster of clusters) {
  const threads = new Set(cluster.map(i => i.threadRootId))
  const authors = new Set(cluster.map(i => i.authorId))
  const crossThreadRatio = threads.size / cluster.length

  const authorDiversity = authors.size / cluster.length

  // Avg pairwise text similarity (tightness)
  let simSum = 0, pairCount = 0
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      simSum += cosine(cluster[i].embedding, cluster[j].embedding)
      pairCount++
    }
  }
  const avgTightness = pairCount > 0 ? simSum / pairCount : 0

  // Shared entity score: for each pair, count entities that string-match (>= 0.85)
  let entityScore = 0
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      for (const eA of cluster[i].entities) {
        for (const eB of cluster[j].entities) {
          if (eA.type !== eB.type) continue
          if (stringSimilarity(eA.surfaceText, eB.surfaceText) >= 0.85) {
            entityScore += 1
          }
        }
      }
    }
  }

  const score = crossThreadRatio * avgTightness * (1 + entityScore)
  const hasSignal = cluster.some(i => ALL_SIGNAL_IDS.has(i.id))

  ranked.push({ items: cluster, crossThreadRatio, authorDiversity, avgTightness, sharedEntityScore: entityScore, score, hasSignal })
}

ranked.sort((a, b) => b.score - a.score)

console.log(`\nTop 25 clusters by score (crossThread × tightness × (1 + entityOverlap)):`)
console.log('')
for (let i = 0; i < Math.min(25, ranked.length); i++) {
  const r = ranked[i]
  const signalIds = r.items.filter(item => ALL_SIGNAL_IDS.has(item.id)).map(item => item.id)
  console.log(`#${i + 1} [${r.items.length} items] score=${r.score.toFixed(3)} cross=${r.crossThreadRatio.toFixed(2)} tight=${r.avgTightness.toFixed(3)} entities=${r.sharedEntityScore}${r.hasSignal ? ' *** SIGNAL: ' + signalIds.join(', ') + ' ***' : ''}`)
}

// Where does signal rank?
const signalRank = ranked.findIndex(r => r.hasSignal)
console.log(`\nSignal cluster rank: #${signalRank + 1} of ${ranked.length}`)
