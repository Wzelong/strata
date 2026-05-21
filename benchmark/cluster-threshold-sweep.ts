import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cosine } from '../src/engine/embed.js'
import { ALL_SIGNAL_IDS, SURFACE_IDS } from '../dataset/signal-items.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-seed.json'), 'utf8'))
const liveData = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-live-items.json'), 'utf8'))

const items: Array<{ id: string; embedding: number[] }> = []
for (const [id, emb] of Object.entries(seed.embeddings)) {
  items.push({ id, embedding: emb as number[] })
}
for (const item of liveData.items) {
  if (!seed.embeddings[item.id]) {
    items.push({ id: item.id, embedding: item.embedding })
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s
}

// Build LSH once (high recall settings)
const NUM_TABLES = 25
const BITS_PER_TABLE = 8
const DIM = 256

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

// Precompute all candidate pairs with their cosine similarity
const pairSims: Array<[number, number, number]> = []
const seen = new Set<string>()
for (let t = 0; t < NUM_TABLES; t++) {
  for (const bucket of tables[t].values()) {
    if (bucket.length < 2 || bucket.length > 100) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j]
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        if (seen.has(key)) continue
        seen.add(key)
        const sim = cosine(items[a].embedding, items[b].embedding)
        if (sim >= 0.50) pairSims.push([a, b, sim])
      }
    }
  }
}

console.log(`Precomputed ${pairSims.length} candidate pairs\n`)
console.log('Threshold | Clusters | Largest | Signal cluster size | Signal items found | Noise in signal cluster')
console.log('----------|----------|---------|--------------------|--------------------|------------------------')

for (const THRESHOLD of [0.50, 0.55, 0.60, 0.62, 0.64, 0.65, 0.66, 0.68, 0.70, 0.72, 0.75]) {
  const parent = Array.from({ length: items.length }, (_, i) => i)
  function find(x: number): number { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
  function union(a: number, b: number) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

  for (const [a, b, sim] of pairSims) {
    if (sim >= THRESHOLD) union(a, b)
  }

  const clusterMap = new Map<number, number[]>()
  for (let i = 0; i < items.length; i++) {
    const root = find(i)
    if (!clusterMap.has(root)) clusterMap.set(root, [])
    clusterMap.get(root)!.push(i)
  }

  const clusters = [...clusterMap.values()]
    .filter(c => c.length >= 2)
    .sort((a, b) => b.length - a.length)

  const largest = clusters[0]?.length ?? 0

  // Find cluster containing case post
  const caseIdx = items.findIndex(i => i.id === 't3_strata_casepost')
  const caseRoot = find(caseIdx)
  const signalCluster = items.map((item, i) => ({ id: item.id, i })).filter(x => find(x.i) === caseRoot)

  const signalInCluster = signalCluster.filter(x => ALL_SIGNAL_IDS.has(x.id))
  const noiseInCluster = signalCluster.length - signalInCluster.length
  const clusterSize = signalCluster.length

  console.log(
    `${THRESHOLD.toFixed(2).padStart(9)} | ${String(clusters.length).padStart(8)} | ${String(largest).padStart(7)} | ${String(clusterSize).padStart(18)} | ${String(signalInCluster.length).padStart(18)} | ${noiseInCluster}`
  )
}
