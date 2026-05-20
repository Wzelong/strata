import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
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
// ALGORITHM: Post-backfill cluster scan
//
// Goal: Find buried connections in existing data without N² comparisons.
//
// Algorithm:
//   1. Walk the entity index
//   2. For each entity surfaceText embedding, find SIMILAR entity embeddings
//      within the same type bucket (cosine > threshold)
//   3. Group items that share similar entities across different threads
//   4. A "cluster" = 2+ items with similar rare entities, different threads,
//      different authors
//   5. Only classify clusters (not all pairs)
//
// But wait — step 2 is still O(entities²) within a type bucket.
// Optimization: only check entities that are RARE (non-hub, appear in <10 items).
// Those are the discriminative ones. If "dark green Subaru Outback" appears in
// 3 items across 3 threads — that's a cluster. We don't need to compare embeddings
// to find it because it's the SAME entity text (or very similar).
//
// Simpler algorithm:
//   1. For each entity embedding in the index, find its nearest neighbors
//      within the same type (cosine > 0.75)
//   2. Group: items connected by high-sim entity pairs = cluster
//   3. Filter: cluster must span 2+ threads, 2+ authors
//   4. Rank clusters by: number of items × entity similarity
//   5. Classify top-N clusters
//
// HYPOTHESES:
//   H1: This finds the 4 signal items as a cluster (they share vehicle entities)
//   H2: Number of clusters is small (< 50) — not N²
//   H3: Signal cluster ranks above noise clusters
//   H4: False positive clusters are easily distinguishable (low entity sim or generic)
// ============================================================

type SeedItem = { id: string; text: string; entities: Entity[]; threadRootId: string; authorId: string }

async function main() {
  const cost = new SimpleCost()
  console.log('=== Post-Backfill Cluster Scan ===\n')

  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: SeedItem[]
    embeddings: Record<string, number[]>
  }
  console.log(`  ${seed.items.length} items loaded`)

  // Step 1: Build entity embedding index (only object type for efficiency)
  console.log('\nStep 1: Building entity embedding index (object type only)...')
  const SCAN_TYPES = new Set(['object'])
  const MIN_ENTITY_SIM = 0.75

  type EntityEntry = { surfaceText: string; itemId: string; threadRootId: string; authorId: string }
  const entries: EntityEntry[] = []

  for (const item of seed.items) {
    for (const e of item.entities) {
      if (!SCAN_TYPES.has(e.type)) continue
      entries.push({ surfaceText: e.surfaceText, itemId: item.id, threadRootId: item.threadRootId, authorId: item.authorId })
    }
  }
  console.log(`  ${entries.length} object entities to embed`)

  // Embed all entity surfaceTexts
  const entityTexts = entries.map(e => e.surfaceText)
  const entityEmbs = await embedBatch(client, entityTexts, cost)
  console.log(`  Embedded. Cost: $${cost.total.toFixed(4)}`)

  // Step 2: Hub detection — skip entities that appear in too many items
  console.log('\nStep 2: Hub detection...')
  const entityItemCount = new Map<string, Set<string>>()
  for (const entry of entries) {
    const key = entry.surfaceText.toLowerCase()
    if (!entityItemCount.has(key)) entityItemCount.set(key, new Set())
    entityItemCount.get(key)!.add(entry.itemId)
  }

  const totalItemsWithEntities = new Set(entries.map(e => e.itemId)).size
  const hubTexts = new Set<string>()
  for (const [key, items] of entityItemCount) {
    if (items.size >= 10 && items.size / totalItemsWithEntities > 0.03) {
      hubTexts.add(key)
    }
  }
  console.log(`  ${hubTexts.size} hub entities suppressed`)
  for (const h of [...hubTexts].slice(0, 10)) {
    console.log(`    "${h}" (${entityItemCount.get(h)!.size} items)`)
  }

  // Filter out hub entities
  const nonHubIndices: number[] = []
  for (let i = 0; i < entries.length; i++) {
    if (!hubTexts.has(entries[i].surfaceText.toLowerCase())) {
      nonHubIndices.push(i)
    }
  }
  console.log(`  ${nonHubIndices.length} non-hub entity entries remain`)

  // Step 3: Find clusters via entity embedding similarity
  // For each non-hub entity, find others in the same type with cosine > threshold
  // Group by connected items across threads
  console.log('\nStep 3: Finding entity-linked clusters...')
  console.log('  (comparing non-hub entity embeddings pairwise within type...)')

  // Optimization: instead of full O(n²), bucket by approximate similarity
  // Use a simple approach: for each entity, find its top-5 nearest neighbors
  const TOP_NEIGHBORS = 5
  type Link = { iIdx: number; jIdx: number; sim: number }
  const links: Link[] = []

  // For efficiency with 3K+ entities, batch the comparisons
  for (let i = 0; i < nonHubIndices.length; i++) {
    const iIdx = nonHubIndices[i]
    const iEmb = entityEmbs[iIdx]
    const iEntry = entries[iIdx]

    const neighbors: Array<{ jIdx: number; sim: number }> = []
    for (let j = i + 1; j < nonHubIndices.length; j++) {
      const jIdx = nonHubIndices[j]
      const jEntry = entries[jIdx]

      // Skip same item or same thread
      if (iEntry.itemId === jEntry.itemId) continue
      if (iEntry.threadRootId === jEntry.threadRootId) continue

      const sim = cosine(iEmb, entityEmbs[jIdx])
      if (sim >= MIN_ENTITY_SIM) {
        neighbors.push({ jIdx, sim })
      }
    }

    neighbors.sort((a, b) => b.sim - a.sim)
    for (const n of neighbors.slice(0, TOP_NEIGHBORS)) {
      links.push({ iIdx, jIdx: n.jIdx, sim: n.sim })
    }

    if (i > 0 && i % 500 === 0) {
      console.log(`    ${i}/${nonHubIndices.length} entities scanned, ${links.length} links found`)
    }
  }
  console.log(`  ${links.length} cross-thread entity links found`)

  // Step 4: Build clusters from links (union-find)
  console.log('\nStep 4: Building clusters...')
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

  for (const link of links) {
    const itemA = entries[link.iIdx].itemId
    const itemB = entries[link.jIdx].itemId
    union(itemA, itemB)
  }

  // Group items by cluster root
  const clusterMap = new Map<string, Set<string>>()
  const allLinkedItems = new Set<string>()
  for (const link of links) {
    allLinkedItems.add(entries[link.iIdx].itemId)
    allLinkedItems.add(entries[link.jIdx].itemId)
  }
  for (const itemId of allLinkedItems) {
    const root = find(itemId)
    if (!clusterMap.has(root)) clusterMap.set(root, new Set())
    clusterMap.get(root)!.add(itemId)
  }

  // Filter: clusters must have 2+ items from 2+ authors across 2+ threads
  type Cluster = {
    items: string[]
    threads: Set<string>
    authors: Set<string>
    bestLink: { entityA: string; entityB: string; sim: number }
  }
  const clusters: Cluster[] = []

  for (const [root, itemIds] of clusterMap) {
    if (itemIds.size < 2) continue
    const threads = new Set<string>()
    const authors = new Set<string>()
    for (const id of itemIds) {
      const item = seed.items.find(i => i.id === id)
      if (item) {
        threads.add(item.threadRootId)
        authors.add(item.authorId)
      }
    }
    if (threads.size < 2 || authors.size < 2) continue

    // Find best entity link within this cluster
    let bestLink = { entityA: '', entityB: '', sim: 0 }
    for (const link of links) {
      const a = entries[link.iIdx].itemId
      const b = entries[link.jIdx].itemId
      if (itemIds.has(a) && itemIds.has(b) && link.sim > bestLink.sim) {
        bestLink = { entityA: entries[link.iIdx].surfaceText, entityB: entries[link.jIdx].surfaceText, sim: link.sim }
      }
    }

    clusters.push({ items: [...itemIds], threads, authors, bestLink })
  }

  // Sort by: cluster size × best entity sim
  clusters.sort((a, b) => (b.items.length * b.bestLink.sim) - (a.items.length * a.bestLink.sim))

  console.log(`  ${clusters.length} valid clusters (2+ items, 2+ threads, 2+ authors)`)

  // Step 5: Display results
  console.log('\n=== TOP CLUSTERS ===\n')

  const SIGNAL_IDS = new Set(['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4'])

  let signalClusterRank = -1

  for (let i = 0; i < Math.min(20, clusters.length); i++) {
    const c = clusters[i]
    const signalCount = c.items.filter(id => SIGNAL_IDS.has(id)).length
    if (signalCount > 0 && signalClusterRank === -1) signalClusterRank = i

    const marker = signalCount > 0 ? '★' : ' '
    console.log(`  ${marker} Cluster ${i + 1}: ${c.items.length} items, ${c.threads.size} threads, ${c.authors.size} authors`)
    console.log(`    Best entity link: "${c.bestLink.entityA}" ↔ "${c.bestLink.entityB}" (${c.bestLink.sim.toFixed(4)})`)
    console.log(`    Signal items: ${signalCount}/4`)

    // Show item previews
    for (const id of c.items.slice(0, 4)) {
      const item = seed.items.find(it => it.id === id)
      const isSignal = SIGNAL_IDS.has(id)
      console.log(`      ${isSignal ? '★' : ' '} [${id}] ${item?.text.slice(0, 70)}...`)
    }
    if (c.items.length > 4) console.log(`      ... and ${c.items.length - 4} more`)
    console.log()
  }

  // === EVALUATION ===
  console.log('=== EVALUATION ===\n')

  // H1: Signal items form a cluster
  const signalInAnyClusters = clusters.filter(c => c.items.some(id => SIGNAL_IDS.has(id)))
  const signalItemsClustered = new Set(signalInAnyClusters.flatMap(c => c.items.filter(id => SIGNAL_IDS.has(id))))
  const h1Pass = signalItemsClustered.size >= 3
  console.log(`  H1: Signal items found in clusters: ${signalItemsClustered.size}/4`)
  console.log(`      Items: ${[...signalItemsClustered].join(', ')}`)
  console.log(`      ${h1Pass ? 'PASS' : 'FAIL'} (need >= 3)`)

  // H2: Number of clusters is small
  const h2Pass = clusters.length < 50
  console.log(`\n  H2: Total clusters: ${clusters.length}`)
  console.log(`      ${h2Pass ? 'PASS' : 'FAIL'} (need < 50)`)

  // H3: Signal cluster ranks high
  const h3Pass = signalClusterRank >= 0 && signalClusterRank < 5
  console.log(`\n  H3: Signal cluster rank: ${signalClusterRank >= 0 ? signalClusterRank + 1 : 'NOT FOUND'}`)
  console.log(`      ${h3Pass ? 'PASS' : 'FAIL'} (need top-5)`)

  // H4: Classify-worthy clusters are few
  const classifyCount = clusters.filter(c => c.bestLink.sim > 0.80).length
  const h4Pass = classifyCount <= 20
  console.log(`\n  H4: High-confidence clusters (sim > 0.80): ${classifyCount}`)
  console.log(`      Total items to classify: ${clusters.filter(c => c.bestLink.sim > 0.80).reduce((s, c) => s + c.items.length, 0)}`)
  console.log(`      ${h4Pass ? 'PASS' : 'FAIL'} (need <= 20 clusters)`)

  // Complexity analysis
  const totalComparisons = nonHubIndices.length * (nonHubIndices.length - 1) / 2
  const nSquared = seed.items.length * (seed.items.length - 1) / 2
  console.log(`\n  Complexity:`)
  console.log(`    N² item pairs (brute force): ${nSquared.toLocaleString()}`)
  console.log(`    Entity pairs compared: ${totalComparisons.toLocaleString()}`)
  console.log(`    Reduction: ${(nSquared / totalComparisons).toFixed(1)}x fewer comparisons`)
  console.log(`    Clusters to classify: ${clusters.length}`)

  const passCount = [h1Pass, h2Pass, h3Pass, h4Pass].filter(Boolean).length
  console.log(`\n  ${passCount}/4 passed`)
  console.log(`  Cost: $${cost.total.toFixed(4)}`)
  console.log(`  Verdict: ${passCount >= 4 ? 'CLUSTER SCAN VALIDATED' : passCount >= 3 ? 'MOSTLY WORKS' : 'NEEDS REWORK'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
