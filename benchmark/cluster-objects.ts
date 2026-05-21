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
console.log('Object entities:', objects.length)

// --- LSH: Random Projection ---
const NUM_TABLES = 15
const BITS_PER_TABLE = 8
const DIM = 256
const THRESHOLD = 0.70

// Generate random hyperplanes
function randomHyperplanes(count: number, dim: number): number[][] {
  const planes: number[][] = []
  for (let i = 0; i < count; i++) {
    const plane = Array.from({ length: dim }, () => Math.random() * 2 - 1)
    planes.push(plane)
  }
  return planes
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function hashVector(emb: number[], planes: number[][], bitsPerTable: number): number[] {
  const hashes: number[] = []
  for (let t = 0; t < planes.length / bitsPerTable; t++) {
    let hash = 0
    for (let b = 0; b < bitsPerTable; b++) {
      const plane = planes[t * bitsPerTable + b]
      hash = (hash << 1) | (dot(emb, plane) > 0 ? 1 : 0)
    }
    hashes.push(hash)
  }
  return hashes
}

const t0 = performance.now()

// Step 1: Build LSH tables
const planes = randomHyperplanes(NUM_TABLES * BITS_PER_TABLE, DIM)
const tables: Map<number, number[]>[] = Array.from({ length: NUM_TABLES }, () => new Map())

for (let i = 0; i < objects.length; i++) {
  const hashes = hashVector(objects[i].embedding, planes, BITS_PER_TABLE)
  for (let t = 0; t < NUM_TABLES; t++) {
    const bucket = tables[t].get(hashes[t])
    if (bucket) bucket.push(i)
    else tables[t].set(hashes[t], [i])
  }
}

// Step 2: Find candidate pairs from buckets, verify with real cosine
const candidatePairs = new Set<string>()
let verifications = 0

for (let t = 0; t < NUM_TABLES; t++) {
  for (const bucket of tables[t].values()) {
    if (bucket.length < 2 || bucket.length > 50) continue // skip huge buckets (hubs)
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j]
        if (objects[a].itemId === objects[b].itemId) continue
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        if (candidatePairs.has(key)) continue
        candidatePairs.add(key)
      }
    }
  }
}

// Step 3: Verify candidates and union-find
const parent = Array.from({ length: objects.length }, (_, i) => i)
function find(x: number): number {
  while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
  return x
}
function union(a: number, b: number) {
  const ra = find(a), rb = find(b)
  if (ra !== rb) parent[ra] = rb
}

let edges = 0
for (const key of candidatePairs) {
  const [ai, bi] = key.split('|').map(Number)
  verifications++
  const sim = cosine(objects[ai].embedding, objects[bi].embedding)
  if (sim >= THRESHOLD) {
    union(ai, bi)
    edges++
  }
}

const elapsed = performance.now() - t0

// Collect clusters
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

console.log(`\nLSH: ${NUM_TABLES} tables × ${BITS_PER_TABLE} bits`)
console.log(`Candidate pairs: ${candidatePairs.size}`)
console.log(`Cosine verifications: ${verifications}`)
console.log(`Edges (above ${THRESHOLD}): ${edges}`)
console.log(`Time: ${Math.round(elapsed)}ms`)
console.log(`Brute force would be: ${Math.round(objects.length * (objects.length - 1) / 2)} comparisons`)
console.log(`Speedup: ${(objects.length * (objects.length - 1) / 2 / verifications).toFixed(1)}x`)

console.log(`\nClusters with 2+ unique items: ${multiClusters.length}`)
console.log(`\nTop 30 clusters:`)
for (const cluster of multiClusters.slice(0, 30)) {
  const signal = cluster.entries.filter(e => e.itemId.includes('strata'))
  const samples = [...new Set(cluster.entries.map(e => e.surfaceText))].slice(0, 4)
  console.log(`  [${cluster.uniqueItems} items] ${signal.length > 0 ? '*** ' : ''}${samples.map(s => '"' + s.slice(0, 35) + '"').join(', ')}${signal.length > 0 ? ' ***' : ''}`)
}
