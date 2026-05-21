import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cosine } from '../src/engine/embed.js'
import { ALL_SIGNAL_IDS } from '../dataset/signal-items.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-seed.json'), 'utf8'))
const liveData = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-live-items.json'), 'utf8'))

// Load all text embeddings
const items: Array<{ id: string; embedding: number[] }> = []
for (const [id, emb] of Object.entries(seed.embeddings)) {
  items.push({ id, embedding: emb as number[] })
}
for (const item of liveData.items) {
  if (!seed.embeddings[item.id]) {
    items.push({ id: item.id, embedding: item.embedding })
  }
}
console.log('Total items:', items.length)

// LSH + Union-Find on full text embeddings
const NUM_TABLES = 20
const BITS_PER_TABLE = 10
const DIM = 256
const THRESHOLD = 0.60

function dot(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s
}

const planes: number[][] = []
for (let i = 0; i < NUM_TABLES * BITS_PER_TABLE; i++) {
  planes.push(Array.from({ length: DIM }, () => Math.random() * 2 - 1))
}

console.log('Hashing...')
const t0 = performance.now()
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
console.log('Hashing done:', Math.round(performance.now() - t0), 'ms')

console.log('Finding candidate pairs...')
const candidatePairs = new Set<string>()
for (let t = 0; t < NUM_TABLES; t++) {
  for (const bucket of tables[t].values()) {
    if (bucket.length < 2 || bucket.length > 100) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const key = bucket[i] < bucket[j] ? `${bucket[i]}|${bucket[j]}` : `${bucket[j]}|${bucket[i]}`
        candidatePairs.add(key)
      }
    }
  }
}
console.log('Candidate pairs:', candidatePairs.size)

console.log('Verifying and clustering...')
const parent = Array.from({ length: items.length }, (_, i) => i)
function find(x: number): number { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
function union(a: number, b: number) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

let edges = 0
for (const key of candidatePairs) {
  const [ai, bi] = key.split('|').map(Number)
  const sim = cosine(items[ai].embedding, items[bi].embedding)
  if (sim >= THRESHOLD) { union(ai, bi); edges++ }
}

const elapsed = performance.now() - t0
console.log(`Done: ${edges} edges, ${Math.round(elapsed)}ms`)
console.log(`Brute force: ${Math.round(items.length * (items.length - 1) / 2)} comparisons`)
console.log(`Speedup: ${(items.length * (items.length - 1) / 2 / candidatePairs.size).toFixed(1)}x`)

// Collect clusters
const clusterMap = new Map<number, number[]>()
for (let i = 0; i < items.length; i++) {
  const root = find(i)
  if (!clusterMap.has(root)) clusterMap.set(root, [])
  clusterMap.get(root)!.push(i)
}

const multiClusters = [...clusterMap.values()]
  .map(indices => ({
    ids: indices.map(i => items[i].id),
    size: indices.length,
  }))
  .filter(c => c.size >= 2)
  .sort((a, b) => b.size - a.size)

console.log(`\nClusters with 2+ items: ${multiClusters.length}`)
console.log(`Largest 10:`)
for (const c of multiClusters.slice(0, 10)) {
  const signalCount = c.ids.filter(id => ALL_SIGNAL_IDS.has(id)).length
  console.log(`  [${c.size} items]${signalCount > 0 ? ` *** ${signalCount} SIGNAL ***` : ''}`)
}

// Find which cluster has our signal items
const signalCluster = multiClusters.find(c => c.ids.some(id => id.includes('strata_casepost') || id.includes('strata_surface')))
if (signalCluster) {
  console.log(`\n=== Signal cluster: ${signalCluster.size} items ===`)
  const signalIds = signalCluster.ids.filter(id => ALL_SIGNAL_IDS.has(id))
  console.log('Signal items in cluster:', signalIds)
  console.log('Noise items in cluster:', signalCluster.size - signalIds.length)

  // Show text similarity between signal items
  const idToEmb = new Map(items.map(i => [i.id, i.embedding]))
  const caseEmb = idToEmb.get('t3_strata_casepost')
  if (caseEmb) {
    console.log('\nCase post similarity to other cluster members:')
    for (const id of signalCluster.ids.slice(0, 15)) {
      const emb = idToEmb.get(id)
      if (emb && id !== 't3_strata_casepost') {
        const sim = cosine(caseEmb, emb)
        const isSignal = ALL_SIGNAL_IDS.has(id) ? ' [SIGNAL]' : ''
        console.log(`  ${sim.toFixed(3)} ${id}${isSignal}`)
      }
    }
  }
} else {
  console.log('\nSignal items NOT found in any cluster')
  // Check where they individually are
  for (const item of items) {
    if (item.id.includes('strata_casepost')) {
      const root = find(items.indexOf(item))
      const clusterSize = items.filter((_, i) => find(i) === root).length
      console.log(`Case post cluster: ${clusterSize} items`)
    }
  }
}
