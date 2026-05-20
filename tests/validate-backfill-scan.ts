import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { embedBatch, cosine } from '../src/engine/embed.js'
import type { Entity, CostTracker } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, '..', 'dataset', 'seed.json')

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

// ============================================================
// TWO APPROACHES for post-backfill connection discovery:
//
// APPROACH A: MinHash/LSH on Entity Sets
//   - Represent each doc as a set of entity keys
//   - MinHash signature (k=128) per doc
//   - LSH banding finds candidate pairs with entity set overlap
//   - Verify with entity embeddings
//
// APPROACH B: IDF-Weighted Edges (no clustering)
//   - Bipartite graph: doc ↔ entity (soft nodes via embeddings)
//   - IDF weight per entity node
//   - Project to doc-doc edges weighted by shared entity IDF
//   - Report top edges directly (no union-find, no components)
//
// HYPOTHESES:
//   H1: Signal items appear in top-20 edges (at least one signal pair)
//   H2: Total candidate pairs < 100 (manageable for classification)
//   H3: Signal pairs have higher weight/similarity than noise pairs
//   H4: False positive pairs are clearly distinguishable
// ============================================================

type SeedItem = { id: string; text: string; entities: Entity[]; threadRootId: string; authorId: string }

// --- MinHash implementation ---
function createHashFunctions(k: number, maxVal: number): Array<(x: number) => number> {
  const fns: Array<(x: number) => number> = []
  for (let i = 0; i < k; i++) {
    const a = Math.floor(Math.random() * maxVal) + 1
    const b = Math.floor(Math.random() * maxVal)
    const p = 2147483647 // large prime
    fns.push((x: number) => ((a * x + b) % p) % maxVal)
  }
  return fns
}

function minhashSignature(set: Set<number>, hashFns: Array<(x: number) => number>): number[] {
  const sig = new Array(hashFns.length).fill(Infinity)
  for (const elem of set) {
    for (let i = 0; i < hashFns.length; i++) {
      const h = hashFns[i](elem)
      if (h < sig[i]) sig[i] = h
    }
  }
  return sig
}

function estimateJaccard(sigA: number[], sigB: number[]): number {
  let matches = 0
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] === sigB[i]) matches++
  }
  return matches / sigA.length
}

async function main() {
  const cost = new SimpleCost()
  console.log('=== Backfill Scan: Approach A (MinHash) vs Approach B (IDF Edges) ===\n')

  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: SeedItem[]
    embeddings: Record<string, number[]>
  }
  console.log(`  ${seed.items.length} items`)

  // Collect multi-word object entities
  type Mention = { surfaceText: string; itemId: string; threadRootId: string; authorId: string }
  const mentions: Mention[] = []
  for (const item of seed.items) {
    for (const e of item.entities) {
      if (e.type !== 'object') continue
      if (e.surfaceText.trim().split(/\s+/).length < 2) continue
      mentions.push({ surfaceText: e.surfaceText, itemId: item.id, threadRootId: item.threadRootId, authorId: item.authorId })
    }
  }
  console.log(`  ${mentions.length} multi-word object mentions`)

  // Embed all mentions
  console.log('\nEmbedding entity mentions...')
  const mentionTexts = mentions.map(m => m.surfaceText)
  const mentionEmbs = await embedBatch(client, mentionTexts, cost)
  console.log(`  Cost: $${cost.total.toFixed(4)}`)

  // Build soft-entity nodes (cosine > 0.80 = same node)
  console.log('\nBuilding soft-entity nodes...')
  const ENTITY_SIM = 0.80
  type Node = { id: number; representative: string; mentionIndices: number[] }
  const nodes: Node[] = []
  const mentionToNode: number[] = new Array(mentions.length).fill(-1)

  for (let i = 0; i < mentions.length; i++) {
    let bestNode = -1, bestSim = 0
    for (let n = 0; n < nodes.length; n++) {
      const sim = cosine(mentionEmbs[i], mentionEmbs[nodes[n].mentionIndices[0]])
      if (sim > bestSim) { bestSim = sim; bestNode = n }
    }
    if (bestSim >= ENTITY_SIM) {
      nodes[bestNode].mentionIndices.push(i)
      mentionToNode[i] = bestNode
    } else {
      mentionToNode[i] = nodes.length
      nodes.push({ id: nodes.length, representative: mentions[i].surfaceText, mentionIndices: [i] })
    }
  }
  console.log(`  ${nodes.length} nodes from ${mentions.length} mentions`)

  const SIGNAL_IDS = new Set(['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4'])
  const N = seed.items.length

  // ============================================================
  // APPROACH A: MinHash/LSH on Entity Node Sets
  // ============================================================
  console.log('\n=== APPROACH A: MinHash/LSH ===\n')

  // Build entity node set per document
  const docNodeSets = new Map<string, Set<number>>()
  for (let i = 0; i < mentions.length; i++) {
    const itemId = mentions[i].itemId
    const nodeId = mentionToNode[i]
    if (!docNodeSets.has(itemId)) docNodeSets.set(itemId, new Set())
    docNodeSets.get(itemId)!.add(nodeId)
  }

  // Only consider docs with 2+ entity nodes
  const docsWithEntities = [...docNodeSets.entries()].filter(([_, s]) => s.size >= 2)
  console.log(`  Docs with 2+ entity nodes: ${docsWithEntities.length}`)

  // MinHash signatures
  const K = 128
  const hashFns = createHashFunctions(K, nodes.length * 10)
  const signatures = new Map<string, number[]>()
  for (const [docId, nodeSet] of docsWithEntities) {
    signatures.set(docId, minhashSignature(nodeSet, hashFns))
  }

  // LSH banding: b bands of r rows (b*r = K)
  const BANDS = 32
  const ROWS = K / BANDS // 4 rows per band
  const JACCARD_THRESHOLD = 0.05 // very low — even 1 shared entity out of 10 is interesting

  type CandidatePair = { docA: string; docB: string; jaccard: number }
  const candidatePairsA: CandidatePair[] = []
  const seen = new Set<string>()

  // LSH: hash each band, find collisions
  const bandBuckets: Map<string, string[]>[] = []
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map<string, string[]>()
    for (const [docId, sig] of signatures) {
      const bandSlice = sig.slice(b * ROWS, (b + 1) * ROWS)
      const key = bandSlice.join(',')
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(docId)
    }
    bandBuckets.push(buckets)
  }

  for (const buckets of bandBuckets) {
    for (const [_, docs] of buckets) {
      if (docs.length < 2 || docs.length > 20) continue
      for (let i = 0; i < docs.length; i++) {
        for (let j = i + 1; j < docs.length; j++) {
          const pairKey = docs[i] < docs[j] ? `${docs[i]}|${docs[j]}` : `${docs[j]}|${docs[i]}`
          if (seen.has(pairKey)) continue
          seen.add(pairKey)

          const itemA = seed.items.find(it => it.id === docs[i])!
          const itemB = seed.items.find(it => it.id === docs[j])!
          if (itemA.threadRootId === itemB.threadRootId) continue
          if (itemA.authorId === itemB.authorId) continue

          const jaccard = estimateJaccard(signatures.get(docs[i])!, signatures.get(docs[j])!)
          if (jaccard >= JACCARD_THRESHOLD) {
            candidatePairsA.push({ docA: docs[i], docB: docs[j], jaccard })
          }
        }
      }
    }
  }

  candidatePairsA.sort((a, b) => b.jaccard - a.jaccard)
  console.log(`  Candidate pairs found: ${candidatePairsA.length}`)

  console.log('\n  Top 15 pairs (by estimated Jaccard):')
  for (let i = 0; i < Math.min(15, candidatePairsA.length); i++) {
    const p = candidatePairsA[i]
    const aSignal = SIGNAL_IDS.has(p.docA)
    const bSignal = SIGNAL_IDS.has(p.docB)
    const marker = (aSignal || bSignal) ? '★' : ' '
    const itemA = seed.items.find(it => it.id === p.docA)
    const itemB = seed.items.find(it => it.id === p.docB)
    // Find shared entity nodes
    const setA = docNodeSets.get(p.docA)!
    const setB = docNodeSets.get(p.docB)!
    const shared = [...setA].filter(n => setB.has(n)).map(n => nodes[n].representative)
    console.log(`  ${marker} J=${p.jaccard.toFixed(3)} [${p.docA}] ↔ [${p.docB}]`)
    console.log(`    Shared: ${shared.map(s => '"' + s + '"').join(', ') || '(signature collision only)'}`)
    console.log(`    A: ${itemA?.text.slice(0, 60)}...`)
    console.log(`    B: ${itemB?.text.slice(0, 60)}...`)
  }

  // ============================================================
  // APPROACH B: IDF-Weighted Edges (direct, no components)
  // ============================================================
  console.log('\n\n=== APPROACH B: IDF-Weighted Edges (no clustering) ===\n')

  // IDF per node
  const nodeDocSets = nodes.map(node => {
    return new Set(node.mentionIndices.map(idx => mentions[idx].itemId))
  })
  const nodeIDF = nodes.map((_, i) => Math.log(N / Math.max(nodeDocSets[i].size, 1)))

  // Build doc-doc edges
  // Weight = sum of (IDF × word_count_bonus) for each shared entity
  // Multi-entity bonus: edges with 2+ shared entities get multiplied
  type Edge = { docA: string; docB: string; weight: number; entities: string[]; entityCount: number }
  const edgeMap = new Map<string, Edge>()

  for (let ni = 0; ni < nodes.length; ni++) {
    if (nodeDocSets[ni].size < 2 || nodeDocSets[ni].size > 30) continue
    const idf = nodeIDF[ni]
    const wordCount = nodes[ni].representative.trim().split(/\s+/).length
    const specificity = idf * Math.pow(wordCount, 1.5) // longer entity = exponentially more weight
    const docs = [...nodeDocSets[ni]]

    for (let a = 0; a < docs.length; a++) {
      for (let b = a + 1; b < docs.length; b++) {
        const itemA = seed.items.find(i => i.id === docs[a])!
        const itemB = seed.items.find(i => i.id === docs[b])!
        if (itemA.threadRootId === itemB.threadRootId) continue
        if (itemA.authorId === itemB.authorId) continue

        const key = docs[a] < docs[b] ? `${docs[a]}|${docs[b]}` : `${docs[b]}|${docs[a]}`
        if (!edgeMap.has(key)) edgeMap.set(key, { docA: docs[a], docB: docs[b], weight: 0, entities: [], entityCount: 0 })
        const edge = edgeMap.get(key)!
        edge.weight += specificity
        edge.entities.push(nodes[ni].representative)
        edge.entityCount++
      }
    }
  }

  // Multi-entity bonus: multiply weight by entity count for compound matches
  for (const edge of edgeMap.values()) {
    if (edge.entityCount >= 2) {
      edge.weight *= edge.entityCount
    }
  }

  const edgesB = [...edgeMap.values()].sort((a, b) => b.weight - a.weight)
  console.log(`  Total edges: ${edgesB.length}`)

  console.log('\n  Top 20 edges (by IDF weight):')
  for (let i = 0; i < Math.min(20, edgesB.length); i++) {
    const e = edgesB[i]
    const aSignal = SIGNAL_IDS.has(e.docA)
    const bSignal = SIGNAL_IDS.has(e.docB)
    const marker = (aSignal || bSignal) ? '★' : ' '
    const itemA = seed.items.find(it => it.id === e.docA)
    const itemB = seed.items.find(it => it.id === e.docB)
    console.log(`  ${marker} W=${e.weight.toFixed(2)} [${e.docA}] ↔ [${e.docB}]`)
    console.log(`    Shared: ${e.entities.map(s => '"' + s + '"').join(', ')}`)
    console.log(`    A: ${itemA?.text.slice(0, 60)}...`)
    console.log(`    B: ${itemB?.text.slice(0, 60)}...`)
  }

  // ============================================================
  // EVALUATION
  // ============================================================
  console.log('\n\n=== EVALUATION ===\n')

  // H1: Signal pairs in top-20 edges
  const signalPairsA = candidatePairsA.slice(0, 20).filter(p => SIGNAL_IDS.has(p.docA) || SIGNAL_IDS.has(p.docB))
  const signalPairsB = edgesB.slice(0, 20).filter(e => SIGNAL_IDS.has(e.docA) || SIGNAL_IDS.has(e.docB))

  console.log('  H1: Signal pairs in top-20')
  console.log(`    Approach A (MinHash): ${signalPairsA.length} signal pairs`)
  console.log(`    Approach B (IDF edges): ${signalPairsB.length} signal pairs`)
  const h1A = signalPairsA.length >= 1
  const h1B = signalPairsB.length >= 1
  console.log(`    A: ${h1A ? 'PASS' : 'FAIL'} | B: ${h1B ? 'PASS' : 'FAIL'}`)

  // H2: Total candidates manageable
  const h2A = candidatePairsA.length < 100
  const topEdgeWeight = edgesB.length > 0 ? edgesB[0].weight : 0
  const weightThreshold = topEdgeWeight * 0.1 // top 10% of max weight
  const h2B = edgesB.filter(e => e.weight > weightThreshold).length < 100
  console.log(`\n  H2: Candidate count`)
  console.log(`    Approach A: ${candidatePairsA.length} pairs`)
  console.log(`    Approach B (weight > ${weightThreshold.toFixed(1)}): ${edgesB.filter(e => e.weight > weightThreshold).length} pairs`)
  console.log(`    A: ${h2A ? 'PASS' : 'FAIL'} | B: ${h2B ? 'PASS' : 'FAIL'}`)

  // H3: Signal rank (where do signal pairs first appear)
  const firstSignalA = candidatePairsA.findIndex(p => SIGNAL_IDS.has(p.docA) || SIGNAL_IDS.has(p.docB))
  const firstSignalB = edgesB.findIndex(e => SIGNAL_IDS.has(e.docA) || SIGNAL_IDS.has(e.docB))
  console.log(`\n  H3: First signal pair rank`)
  console.log(`    Approach A: rank ${firstSignalA >= 0 ? firstSignalA + 1 : 'NOT FOUND'}`)
  console.log(`    Approach B: rank ${firstSignalB >= 0 ? firstSignalB + 1 : 'NOT FOUND'}`)
  const h3A = firstSignalA >= 0 && firstSignalA < 10
  const h3B = firstSignalB >= 0 && firstSignalB < 10
  console.log(`    A: ${h3A ? 'PASS' : 'FAIL'} | B: ${h3B ? 'PASS' : 'FAIL'}`)

  // H4: Which signal items are found
  const signalFoundA = new Set<string>()
  for (const p of candidatePairsA) {
    if (SIGNAL_IDS.has(p.docA)) signalFoundA.add(p.docA)
    if (SIGNAL_IDS.has(p.docB)) signalFoundA.add(p.docB)
  }
  const signalFoundB = new Set<string>()
  for (const e of edgesB) {
    if (SIGNAL_IDS.has(e.docA)) signalFoundB.add(e.docA)
    if (SIGNAL_IDS.has(e.docB)) signalFoundB.add(e.docB)
  }
  console.log(`\n  H4: Signal items discovered`)
  console.log(`    Approach A: ${signalFoundA.size}/4 — ${[...signalFoundA].join(', ') || 'none'}`)
  console.log(`    Approach B: ${signalFoundB.size}/4 — ${[...signalFoundB].join(', ') || 'none'}`)

  // Summary
  console.log('\n  --- SUMMARY ---')
  console.log(`                    | Approach A (MinHash) | Approach B (IDF Edges)`)
  console.log(`  ------------------|---------------------|----------------------`)
  console.log(`  Signal in top-20  | ${signalPairsA.length} pairs            | ${signalPairsB.length} pairs`)
  console.log(`  Total candidates  | ${candidatePairsA.length}                | ${edgesB.filter(e => e.weight > 7).length} (weight>7)`)
  console.log(`  First signal rank | ${firstSignalA >= 0 ? firstSignalA + 1 : '-'}                  | ${firstSignalB >= 0 ? firstSignalB + 1 : '-'}`)
  console.log(`  Signal items found| ${signalFoundA.size}/4                | ${signalFoundB.size}/4`)
  console.log(`  Cost              | $${cost.total.toFixed(4)} (shared embedding cost)`)

  const passA = [h1A, h2A, h3A].filter(Boolean).length
  const passB = [h1B, h2B, h3B].filter(Boolean).length
  console.log(`\n  Approach A: ${passA}/3 passed`)
  console.log(`  Approach B: ${passB}/3 passed`)
  console.log(`  Winner: ${passB > passA ? 'APPROACH B' : passA > passB ? 'APPROACH A' : 'TIE'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
