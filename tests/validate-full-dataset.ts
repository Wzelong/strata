import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore, cosine } from '../src/engine/index.js'
import type { StoredItem, Entity, CostTracker } from '../src/engine/types.js'
import { LIVE_ITEMS, SURFACE_IDS, BRIGADE_IDS } from '../dataset/signal-items.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, '..', 'dataset', 'seed.json')
const LIVE_FILE = resolve(__dirname, '..', 'dataset', 'live-items.json')

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

type SeedData = {
  items: StoredItem[]
  embeddings: Record<string, number[]>
  canonicals: Record<string, string[]>
}

type LiveItem = { id: string; textNormalized: string; embedding: number[]; entities: Entity[] }

async function main() {
  const cost = new SimpleCost()
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  console.log('=== Full Dataset Validation ===\n')

  // Load seed into MemoryKVStore
  console.log('Loading seed.json into store...')
  const seed: SeedData = JSON.parse(readFileSync(SEED_FILE, 'utf8'))
  for (const item of seed.items) {
    await store.setItem(item)
    await store.addToEntityIndex(item.entities, item.id, item.createdAt)
  }
  for (const [id, emb] of Object.entries(seed.embeddings)) {
    await store.setEmbedding(id, emb)
  }
  for (const [type, list] of Object.entries(seed.canonicals)) {
    await store.addCanonicals(list.map(c => ({ type, surfaceText: c, canonical: c })))
  }
  console.log(`  ${seed.items.length} items loaded\n`)

  // Load pre-computed live items
  const liveData: { items: LiveItem[] } = JSON.parse(readFileSync(LIVE_FILE, 'utf8'))
  const liveById = new Map<string, LiveItem>(liveData.items.map(i => [i.id, i]))

  // ============================================================
  // TEST A: Surface — does findSimilar rank signal fragments in top 10?
  // ============================================================
  console.log('--- Test A: Surface (findSimilar) ---')

  const casePostLive = liveById.get('t3_strata_casepost')!
  const casePostItem = await engine.ingest(LIVE_ITEMS.find(i => i.id === 't3_strata_casepost')!)

  const similar = await engine.findSimilar(casePostItem.embedding, 10, { excludeIds: new Set(['t3_strata_casepost']) })
  const top10Ids = similar.map(h => h.item.id)

  console.log('  Top 10 by embedding similarity:')
  for (let i = 0; i < similar.length; i++) {
    const hit = similar[i]
    const isSignal = SURFACE_IDS.has(hit.item.id)
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} ${hit.item.id} (${hit.weight.toFixed(4)}) — ${hit.item.text.slice(0, 60)}...`)
  }

  const surfaceInTop10 = [...SURFACE_IDS].filter(id => top10Ids.includes(id))
  const h1Pass = surfaceInTop10.length === 4
  const h2Pass = surfaceInTop10.length >= 3 && similar.findIndex(h => SURFACE_IDS.has(h.item.id)) < 5
  console.log(`\n  H1 (all 4 surface in top 10): ${surfaceInTop10.length}/4 — ${h1Pass ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`  H2 (signals rank above noise): best signal at position ${similar.findIndex(h => SURFACE_IDS.has(h.item.id)) + 1} — ${h2Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // TEST B: Classification — are surface hits classified as related?
  // ============================================================
  console.log('\n--- Test B: Classification ---')

  let relatedCount = 0
  let unrelatedNoiseCount = 0
  const classifyTargets = similar.slice(0, 6)

  for (const hit of classifyTargets) {
    const rel = await engine.classifyRelationship(casePostItem, hit.item)
    const isSignal = SURFACE_IDS.has(hit.item.id)
    const correct = isSignal ? rel !== 'UNRELATED' : rel === 'UNRELATED'
    if (isSignal && rel !== 'UNRELATED') relatedCount++
    if (!isSignal && rel === 'UNRELATED') unrelatedNoiseCount++
    console.log(`    ${isSignal ? '★' : ' '} ${hit.item.id}: ${rel} ${correct ? '✓' : '✗'}`)
  }

  const signalsInTop6 = classifyTargets.filter(h => SURFACE_IDS.has(h.item.id)).length
  const h3Pass = relatedCount >= 3
  const noiseInTop6 = classifyTargets.filter(h => !SURFACE_IDS.has(h.item.id)).length
  const h4Pass = noiseInTop6 === 0 || unrelatedNoiseCount > 0
  console.log(`\n  H3 (surface items classified related): ${relatedCount}/${signalsInTop6} — ${h3Pass ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`  H4 (noise classified unrelated): ${unrelatedNoiseCount}/${noiseInTop6} — ${h4Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // TEST C: Flag — Precedent match (FLAG-4 vs removed items)
  // ============================================================
  console.log('\n--- Test C: Flag — Precedent Match ---')

  const flag4Item = await engine.ingest(LIVE_ITEMS.find(i => i.id === 't3_strata_flag4')!)
  const precedentHits = await engine.findSimilar(flag4Item.embedding, 10, { decision: ['removed'], excludeIds: new Set(['t3_strata_flag4']) })

  console.log('  Top hits against removed items:')
  const removedIds = new Set(['t3_strata_flag3a', 't3_strata_flag3b', 't3_strata_flag3c'])
  let removedFound = 0
  for (const hit of precedentHits.slice(0, 5)) {
    const isRemoved = removedIds.has(hit.item.id)
    if (isRemoved) removedFound++
    console.log(`    ${isRemoved ? '★' : ' '} ${hit.item.id} (${hit.weight.toFixed(4)}) — ${hit.item.text.slice(0, 60)}...`)
  }

  const h5Pass = removedFound >= 2
  const bestRemovedScore = precedentHits.find(h => removedIds.has(h.item.id))?.weight ?? 0
  const h6Pass = bestRemovedScore > 0.6
  console.log(`\n  H5 (2+ removed items found): ${removedFound}/3 — ${h5Pass ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`  H6 (best score > 0.6): ${bestRemovedScore.toFixed(4)} — ${h6Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // TEST D: Flag — Brigade detection
  // ============================================================
  console.log('\n--- Test D: Flag — Brigade Detection ---')

  for (const brigadeRaw of LIVE_ITEMS.filter(i => BRIGADE_IDS.has(i.id))) {
    await engine.ingest(brigadeRaw)
  }

  const brigadeItems = await engine.getItemsInThread('t3_strata_casepost')
  const brigadeAuthors = new Set(brigadeItems.filter(i => BRIGADE_IDS.has(i.id)).map(i => i.authorId))
  const brigadeWindow = brigadeItems.filter(i => BRIGADE_IDS.has(i.id))
  const timeSpanMs = brigadeWindow.length > 1
    ? Math.max(...brigadeWindow.map(i => i.createdAt)) - Math.min(...brigadeWindow.map(i => i.createdAt))
    : 0

  const h7Pass = brigadeWindow.length >= 4 && brigadeAuthors.size >= 4 && timeSpanMs < 2 * 60 * 60 * 1000
  console.log(`  Brigade items in thread: ${brigadeWindow.length}`)
  console.log(`  Distinct authors: ${brigadeAuthors.size}`)
  console.log(`  Time span: ${(timeSpanMs / 1000 / 60).toFixed(0)} minutes`)
  console.log(`  H7 (brigade detected: 4+ items, 4+ authors, <2h): ${h7Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // Also check semantic uniformity
  const brigadeEmbeddings = await Promise.all(
    brigadeWindow.map(async i => (await store.getEmbedding(i.id))!)
  )
  let pairCount = 0, totalSim = 0
  for (let i = 0; i < brigadeEmbeddings.length; i++) {
    for (let j = i + 1; j < brigadeEmbeddings.length; j++) {
      totalSim += cosine(brigadeEmbeddings[i], brigadeEmbeddings[j])
      pairCount++
    }
  }
  const avgSim = pairCount > 0 ? totalSim / pairCount : 0
  console.log(`  Avg pairwise similarity: ${avgSim.toFixed(4)} (high = coordinated)`)

  // ============================================================
  // TEST E: Flag — Contradiction
  // ============================================================
  console.log('\n--- Test E: Flag — Contradiction ---')

  const flag2b = await engine.ingest(LIVE_ITEMS.find(i => i.id === 't1_strata_flag2b')!)
  const flag2a = await engine.getItem('t1_strata_flag2a')

  if (!flag2a) {
    console.log('  ERROR: FLAG-2a not found in store')
  } else {
    const authorItems = await engine.getItemsByAuthor('t2_tkfromcambridge')
    console.log(`  Items by TKfromCambridge: ${authorItems.length}`)
    console.log(`  FLAG-2a: "${flag2a.text.slice(0, 80)}..."`)
    console.log(`  FLAG-2b: "${flag2b.text.slice(0, 80)}..."`)

    const rel = await engine.classifyRelationship(flag2a, flag2b)
    const h8Pass = rel === 'CONTRADICTS'
    console.log(`\n  Classification: ${rel}`)
    console.log(`  H8 (CONTRADICTS): ${h8Pass ? 'PASS ✓' : 'FAIL ✗'}`)
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  const results = [
    { id: 'H1', name: 'All 4 surface items in top 10', pass: h1Pass },
    { id: 'H2', name: 'Signals rank above noise', pass: h2Pass },
    { id: 'H3', name: 'Surface items classified as related', pass: h3Pass },
    { id: 'H4', name: 'Noise classified as unrelated', pass: h4Pass },
    { id: 'H5', name: '2+ removed items found for precedent', pass: h5Pass },
    { id: 'H6', name: 'Precedent similarity > 0.6', pass: h6Pass },
    { id: 'H7', name: 'Brigade detected', pass: h7Pass },
    { id: 'H8', name: 'Contradiction detected', pass: flag2a ? (await engine.classifyRelationship(flag2a, flag2b)) === 'CONTRADICTS' : false },
  ]

  console.log('\n=== RESULTS ===')
  for (const r of results) {
    console.log(`  ${r.id} (${r.name}): ${r.pass ? 'PASS ✓' : 'FAIL ✗'}`)
  }
  const passCount = results.filter(r => r.pass).length
  console.log(`\n  ${passCount}/${results.length} passed`)
  console.log(`  Total cost: $${cost.total.toFixed(4)}`)
  console.log(`  Verdict: ${passCount >= 6 ? 'DATASET VALIDATED ✓' : passCount >= 4 ? 'PARTIALLY WORKS' : 'NEEDS REWORK'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
