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
// ALGORITHM: Bipartite Graph Projection + IDF-Weighted Edges
//
// 1. Build bipartite graph: Document ↔ Entity
//    - Entities are "soft nodes": two surfaceTexts with embedding
//      cosine > 0.80 within the same type are treated as the SAME entity node
// 2. Compute IDF per entity node: log(N / df)
//    - High IDF = rare = discriminative = useful join key
//    - Low IDF = common = noise
// 3. Project onto doc-doc graph:
//    - Edge weight between doc A and doc B = sum of IDF weights of
//      shared entity nodes (where "shared" means same soft-entity)
//    - Only count cross-thread, cross-author links
// 4. Extract connected components with edge weight > threshold
//    - Each component = a group of docs connected by rare shared entities
//    - Rank by edge weight (higher = more confident connection)
//
// HYPOTHESES:
//   H1: Signal items form a high-weight connected component
//   H2: Components are small (2-6 items) — no 599-item monsters
//   H3: Signal component ranks #1 by weight
//   H4: Total components < 30 — manageable for classification
// ============================================================

type SeedItem = { id: string; text: string; entities: Entity[]; threadRootId: string; authorId: string }

async function main() {
  const cost = new SimpleCost()
  console.log('=== Bipartite Graph Scan ===\n')

  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: SeedItem[]
    embeddings: Record<string, number[]>
  }
  console.log(`  ${seed.items.length} items`)

  // Step 1: Collect all object entities (multi-word only)
  console.log('\nStep 1: Collecting entities (object type, 2+ words)...')
  type EntityMention = { surfaceText: string; itemId: string; threadRootId: string; authorId: string }
  const mentions: EntityMention[] = []

  for (const item of seed.items) {
    for (const e of item.entities) {
      if (e.type !== 'object') continue
      const wordCount = e.surfaceText.trim().split(/\s+/).length
      if (wordCount < 2) continue
      mentions.push({ surfaceText: e.surfaceText, itemId: item.id, threadRootId: item.threadRootId, authorId: item.authorId })
    }
  }
  console.log(`  ${mentions.length} multi-word object mentions`)

  // Step 2: Embed all mentions
  console.log('\nStep 2: Embedding entity mentions...')
  const mentionTexts = mentions.map(m => m.surfaceText)
  const mentionEmbs = await embedBatch(client, mentionTexts, cost)
  console.log(`  Done. Cost: $${cost.total.toFixed(4)}`)

  // Step 3: Build soft-entity nodes via embedding clustering
  // Two mentions with cosine > 0.80 = same entity node
  console.log('\nStep 3: Building soft-entity nodes (cosine > 0.80)...')
  const ENTITY_SIM_THRESHOLD = 0.80

  // Greedy clustering: assign each mention to an existing node or create new one
  type EntityNode = { id: number; representative: string; mentionIndices: number[] }
  const nodes: EntityNode[] = []
  const mentionToNode: number[] = new Array(mentions.length).fill(-1)

  for (let i = 0; i < mentions.length; i++) {
    let bestNode = -1
    let bestSim = 0

    // Compare against existing node representatives
    for (let n = 0; n < nodes.length; n++) {
      const repIdx = nodes[n].mentionIndices[0]
      const sim = cosine(mentionEmbs[i], mentionEmbs[repIdx])
      if (sim > bestSim) { bestSim = sim; bestNode = n }
    }

    if (bestSim >= ENTITY_SIM_THRESHOLD) {
      nodes[bestNode].mentionIndices.push(i)
      mentionToNode[i] = bestNode
    } else {
      const newNode: EntityNode = { id: nodes.length, representative: mentions[i].surfaceText, mentionIndices: [i] }
      mentionToNode[i] = nodes.length
      nodes.push(newNode)
    }

    if (i > 0 && i % 500 === 0) {
      console.log(`    ${i}/${mentions.length} mentions processed, ${nodes.length} nodes`)
    }
  }
  console.log(`  ${nodes.length} entity nodes created from ${mentions.length} mentions`)

  // Step 4: Compute IDF per entity node
  console.log('\nStep 4: Computing IDF...')
  const N = seed.items.length
  const nodeDocSets = nodes.map(node => {
    const docs = new Set(node.mentionIndices.map(idx => mentions[idx].itemId))
    return docs
  })
  const nodeIDF = nodes.map((_, i) => Math.log(N / nodeDocSets[i].size))

  // Show top entity nodes by specificity (low df = high IDF)
  const nodesRankedByIDF = nodes
    .map((n, i) => ({ node: n, idf: nodeIDF[i], df: nodeDocSets[i].size }))
    .filter(n => n.df >= 2) // must appear in 2+ docs to be useful
    .sort((a, b) => b.idf - a.idf)

  console.log(`  Entity nodes appearing in 2+ docs: ${nodesRankedByIDF.length}`)
  console.log('  Top 20 by IDF (most discriminative, appearing in 2+ docs):')
  for (const n of nodesRankedByIDF.slice(0, 20)) {
    const docs = [...nodeDocSets[n.node.id]]
    console.log(`    "${n.node.representative}" — df=${n.df}, IDF=${n.idf.toFixed(2)}, docs: ${docs.slice(0, 5).join(', ')}${docs.length > 5 ? '...' : ''}`)
  }

  // Step 5: Project onto doc-doc graph (IDF-weighted edges)
  console.log('\nStep 5: Projecting to doc-doc graph...')
  type DocEdge = { docA: string; docB: string; weight: number; sharedEntities: string[] }
  const edgeMap = new Map<string, DocEdge>()

  for (let ni = 0; ni < nodes.length; ni++) {
    if (nodeDocSets[ni].size < 2) continue // only entities in 2+ docs
    if (nodeDocSets[ni].size > 50) continue // skip very common entities

    const idf = nodeIDF[ni]
    const docList = [...nodeDocSets[ni]]

    for (let a = 0; a < docList.length; a++) {
      for (let b = a + 1; b < docList.length; b++) {
        const docA = docList[a]
        const docB = docList[b]

        // Must be cross-thread and cross-author
        const itemA = seed.items.find(i => i.id === docA)!
        const itemB = seed.items.find(i => i.id === docB)!
        if (itemA.threadRootId === itemB.threadRootId) continue
        if (itemA.authorId === itemB.authorId) continue

        const edgeKey = docA < docB ? `${docA}|${docB}` : `${docB}|${docA}`
        if (!edgeMap.has(edgeKey)) {
          edgeMap.set(edgeKey, { docA, docB, weight: 0, sharedEntities: [] })
        }
        const edge = edgeMap.get(edgeKey)!
        edge.weight += idf
        edge.sharedEntities.push(nodes[ni].representative)
      }
    }
  }

  const edges = [...edgeMap.values()].sort((a, b) => b.weight - a.weight)
  console.log(`  ${edges.length} doc-doc edges`)

  // Step 6: Extract connected components (edges above weight threshold)
  console.log('\nStep 6: Extracting components...')
  const WEIGHT_THRESHOLD = 5.0 // require substantial shared entity evidence

  const strongEdges = edges.filter(e => e.weight >= WEIGHT_THRESHOLD)
  console.log(`  ${strongEdges.length} edges above weight threshold ${WEIGHT_THRESHOLD}`)

  // Union-find on strong edges
  const parent = new Map<string, string>()
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x)
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
    return parent.get(x)!
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const edge of strongEdges) {
    union(edge.docA, edge.docB)
  }

  const componentMap = new Map<string, Set<string>>()
  for (const edge of strongEdges) {
    for (const doc of [edge.docA, edge.docB]) {
      const root = find(doc)
      if (!componentMap.has(root)) componentMap.set(root, new Set())
      componentMap.get(root)!.add(doc)
    }
  }

  type Component = {
    docs: string[]
    totalWeight: number
    entities: string[]
  }
  const components: Component[] = []
  for (const [_, docs] of componentMap) {
    if (docs.size < 2) continue
    let totalWeight = 0
    const entities = new Set<string>()
    for (const edge of strongEdges) {
      if (docs.has(edge.docA) && docs.has(edge.docB)) {
        totalWeight += edge.weight
        for (const e of edge.sharedEntities) entities.add(e)
      }
    }
    components.push({ docs: [...docs], totalWeight, entities: [...entities] })
  }
  components.sort((a, b) => b.totalWeight - a.totalWeight)

  console.log(`  ${components.length} components found`)

  // === DISPLAY RESULTS ===
  console.log('\n=== TOP COMPONENTS ===\n')

  const SIGNAL_IDS = new Set(['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4'])

  let signalComponentRank = -1
  for (let i = 0; i < Math.min(15, components.length); i++) {
    const c = components[i]
    const signalCount = c.docs.filter(id => SIGNAL_IDS.has(id)).length
    if (signalCount > 0 && signalComponentRank === -1) signalComponentRank = i

    const marker = signalCount > 0 ? '★' : ' '
    console.log(`${marker} Component ${i + 1}: ${c.docs.length} docs, weight=${c.totalWeight.toFixed(1)}`)
    console.log(`  Shared entities: ${c.entities.slice(0, 5).map(e => '"' + e + '"').join(', ')}${c.entities.length > 5 ? '...' : ''}`)
    for (const id of c.docs.slice(0, 5)) {
      const item = seed.items.find(it => it.id === id)
      const isSignal = SIGNAL_IDS.has(id)
      console.log(`    ${isSignal ? '★' : ' '} [${id}] ${item?.text.slice(0, 70)}...`)
    }
    if (c.docs.length > 5) console.log(`    ... and ${c.docs.length - 5} more`)
    console.log()
  }

  // Also show top edges (most confident doc pairs)
  console.log('=== TOP EDGES (strongest doc-doc connections) ===\n')
  for (let i = 0; i < Math.min(10, edges.length); i++) {
    const e = edges[i]
    const aSignal = SIGNAL_IDS.has(e.docA)
    const bSignal = SIGNAL_IDS.has(e.docB)
    const marker = (aSignal || bSignal) ? '★' : ' '
    const itemA = seed.items.find(it => it.id === e.docA)
    const itemB = seed.items.find(it => it.id === e.docB)
    console.log(`${marker} Weight ${e.weight.toFixed(2)}: [${e.docA}] ↔ [${e.docB}]`)
    console.log(`  Shared: ${e.sharedEntities.map(s => '"' + s + '"').join(', ')}`)
    console.log(`  A: ${itemA?.text.slice(0, 70)}...`)
    console.log(`  B: ${itemB?.text.slice(0, 70)}...`)
    console.log()
  }

  // === EVALUATION ===
  console.log('=== EVALUATION ===\n')

  const signalInComponents = components.filter(c => c.docs.some(id => SIGNAL_IDS.has(id)))
  const signalDocsClustered = new Set(signalInComponents.flatMap(c => c.docs.filter(id => SIGNAL_IDS.has(id))))

  const h1Pass = signalDocsClustered.size >= 3
  console.log(`  H1: Signal items in components: ${signalDocsClustered.size}/4`)
  for (const id of SIGNAL_IDS) {
    const inComponent = [...componentMap.values()].some(s => s.has(id))
    console.log(`      ${id}: ${inComponent ? 'YES' : 'NO'}`)
  }
  console.log(`      ${h1Pass ? 'PASS' : 'FAIL'} (need >= 3)`)

  const maxComponentSize = components.length > 0 ? Math.max(...components.map(c => c.docs.length)) : 0
  const h2Pass = maxComponentSize <= 10
  console.log(`\n  H2: Largest component: ${maxComponentSize} docs`)
  console.log(`      ${h2Pass ? 'PASS' : 'FAIL'} (need <= 10)`)

  const h3Pass = signalComponentRank === 0
  console.log(`\n  H3: Signal component rank: ${signalComponentRank >= 0 ? signalComponentRank + 1 : 'NOT FOUND'}`)
  console.log(`      ${h3Pass ? 'PASS' : 'FAIL'} (need #1)`)

  const h4Pass = components.length <= 30
  console.log(`\n  H4: Total components: ${components.length}`)
  console.log(`      ${h4Pass ? 'PASS' : 'FAIL'} (need <= 30)`)

  // Complexity
  const nSquared = seed.items.length * (seed.items.length - 1) / 2
  console.log(`\n  Complexity:`)
  console.log(`    N² doc pairs (brute force): ${nSquared.toLocaleString()}`)
  console.log(`    Entity mentions processed: ${mentions.length}`)
  console.log(`    Entity nodes created: ${nodes.length}`)
  console.log(`    Doc-doc edges evaluated: ${edges.length}`)
  console.log(`    Strong edges: ${strongEdges.length}`)
  console.log(`    Components to classify: ${components.length}`)

  const passCount = [h1Pass, h2Pass, h3Pass, h4Pass].filter(Boolean).length
  console.log(`\n  ${passCount}/4 passed`)
  console.log(`  Cost: $${cost.total.toFixed(4)}`)
  console.log(`  Verdict: ${passCount >= 4 ? 'BIPARTITE SCAN VALIDATED' : passCount >= 3 ? 'MOSTLY WORKS' : 'NEEDS TUNING'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
