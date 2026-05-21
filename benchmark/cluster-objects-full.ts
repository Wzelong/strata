import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cosine, dequantize } from '../src/engine/embed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-seed.json'), 'utf8'))

type Entry = { itemId: string; surfaceText: string; embedding: number[] }

const objects: Entry[] = []
for (const [itemId, ents] of Object.entries(seed.entityEmbeddings || {})) {
  for (const e of ents as any[]) {
    if (e.type === 'object' && e.surfaceText.length >= 8) {
      objects.push({ itemId, surfaceText: e.surfaceText, embedding: dequantize(e.embedding) })
    }
  }
}

// LSH + Union-Find (same as before)
const NUM_TABLES = 15
const BITS_PER_TABLE = 8
const DIM = 256
const THRESHOLD = 0.70

function dot(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s
}

const planes: number[][] = []
for (let i = 0; i < NUM_TABLES * BITS_PER_TABLE; i++) {
  planes.push(Array.from({ length: DIM }, () => Math.random() * 2 - 1))
}

const tables: Map<number, number[]>[] = Array.from({ length: NUM_TABLES }, () => new Map())
for (let i = 0; i < objects.length; i++) {
  for (let t = 0; t < NUM_TABLES; t++) {
    let hash = 0
    for (let b = 0; b < BITS_PER_TABLE; b++) {
      hash = (hash << 1) | (dot(objects[i].embedding, planes[t * BITS_PER_TABLE + b]) > 0 ? 1 : 0)
    }
    const bucket = tables[t].get(hash)
    if (bucket) bucket.push(i)
    else tables[t].set(hash, [i])
  }
}

const candidatePairs = new Set<string>()
for (let t = 0; t < NUM_TABLES; t++) {
  for (const bucket of tables[t].values()) {
    if (bucket.length < 2 || bucket.length > 50) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j]
        if (objects[a].itemId === objects[b].itemId) continue
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        candidatePairs.add(key)
      }
    }
  }
}

const parent = Array.from({ length: objects.length }, (_, i) => i)
function find(x: number): number { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
function union(a: number, b: number) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

for (const key of candidatePairs) {
  const [ai, bi] = key.split('|').map(Number)
  if (cosine(objects[ai].embedding, objects[bi].embedding) >= THRESHOLD) union(ai, bi)
}

const clusterMap = new Map<number, number[]>()
for (let i = 0; i < objects.length; i++) {
  const root = find(i)
  if (!clusterMap.has(root)) clusterMap.set(root, [])
  clusterMap.get(root)!.push(i)
}

const multiClusters = [...clusterMap.values()]
  .map(indices => {
    const items = new Set(indices.map(i => objects[i].itemId))
    return { indices, uniqueItems: items.size, entries: indices.map(i => objects[i]) }
  })
  .filter(c => c.uniqueItems >= 2)
  .sort((a, b) => b.uniqueItems - a.uniqueItems)

// Now: apply text similarity within each cluster
const TEXT_THRESHOLD = 0.55
const allTextEmbs = new Map<string, number[]>()
for (const [id, emb] of Object.entries(seed.embeddings)) {
  allTextEmbs.set(id, emb as number[])
}
// Also load live items text embeddings
const liveData = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-live-items.json'), 'utf8'))
for (const item of liveData.items) {
  allTextEmbs.set(item.id, item.embedding)
}

type ConfirmedCluster = {
  rank: number
  clusterSize: number
  confirmedPairs: Array<{ a: string; b: string; textSim: number; entities: string[] }>
  hasSignal: boolean
}

const results: ConfirmedCluster[] = []

for (let rank = 0; rank < multiClusters.length; rank++) {
  const cluster = multiClusters[rank]
  const uniqueItemIds = [...new Set(cluster.entries.map(e => e.itemId))]

  const confirmedPairs: ConfirmedCluster['confirmedPairs'] = []

  for (let i = 0; i < uniqueItemIds.length; i++) {
    const embA = allTextEmbs.get(uniqueItemIds[i])
    if (!embA) continue
    for (let j = i + 1; j < uniqueItemIds.length; j++) {
      const embB = allTextEmbs.get(uniqueItemIds[j])
      if (!embB) continue
      const textSim = cosine(embA, embB)
      if (textSim >= TEXT_THRESHOLD) {
        const sharedEntities = cluster.entries
          .filter(e => e.itemId === uniqueItemIds[i] || e.itemId === uniqueItemIds[j])
          .map(e => e.surfaceText)
        confirmedPairs.push({ a: uniqueItemIds[i], b: uniqueItemIds[j], textSim, entities: [...new Set(sharedEntities)] })
      }
    }
  }

  if (confirmedPairs.length > 0) {
    const hasSignal = uniqueItemIds.some(id => id.includes('strata'))
    results.push({ rank: rank + 1, clusterSize: cluster.uniqueItems, confirmedPairs, hasSignal })
  }
}

console.log(`Clusters with confirmed text-similar pairs: ${results.length} / ${multiClusters.length}`)
console.log('')

for (let i = 0; i < Math.min(results.length, 20); i++) {
  const r = results[i]
  console.log(`#${i + 1} (entity cluster rank ${r.rank}, ${r.clusterSize} items) ${r.hasSignal ? '*** SIGNAL ***' : ''}`)
  console.log(`  Confirmed pairs: ${r.confirmedPairs.length}`)
  for (const p of r.confirmedPairs.slice(0, 5)) {
    console.log(`    ${p.a} <-> ${p.b} (text: ${p.textSim.toFixed(3)})`)
    console.log(`      entities: ${p.entities.slice(0, 3).map(e => '"' + e.slice(0, 35) + '"').join(', ')}`)
  }
  if (r.confirmedPairs.length > 5) console.log(`    ... +${r.confirmedPairs.length - 5} more`)
  console.log('')
}
