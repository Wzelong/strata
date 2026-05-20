import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'
import { embedBatch, cosine } from '../src/engine/embed.js'
import type { StoredItem, Entity, CostTracker } from '../src/engine/types.js'
import { LIVE_ITEMS, SURFACE_IDS } from '../dataset/signal-items.js'

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
// TEST: Hybrid retrieval (entity filter + full-text safety net)
//
// Approach:
//   1. Entity filter (strong types) → ~6% of corpus
//   2. Full-text cosine top-N (always, scan all) → safety net
//   Union → dedupe → rerank by full-text cosine → top-K → classify
//
// WORST-CASE SCENARIOS tested:
//   W1: Pure narrative witness (no strong-type entities)
//   W2: Person-linked connection (person type, not strong)
//   W3: Indirect evidence (case number = quantity, not strong)
//   W4: Vocabulary gap (different words for same thing)
//
// SUCCESS CONDITIONS:
//   C1: Hybrid retrieval finds all 4 signal items in top-10
//   C2: Entity-only would MISS at least 1 signal (proving safety net needed)
//   C3: Safety net catches earwitness (narrative-only match)
//   C4: Hybrid candidate set is still <15% of corpus (still shrinks search)
//   C5: Custom worst-case items are found by safety net when entities fail
// ============================================================

type SeedData = {
  items: StoredItem[]
  embeddings: Record<string, number[]>
}

function precision(ranked: string[], k: number, signals: Set<string>): number {
  return ranked.slice(0, k).filter(id => signals.has(id)).length / k
}

function recall(ranked: string[], k: number, signals: Set<string>): number {
  return ranked.slice(0, k).filter(id => signals.has(id)).length / signals.size
}

// Synthetic worst-case items (not in seed — we simulate their embeddings)
const WORST_CASES = [
  {
    id: 'wc_narrative_only',
    text: 'I heard a loud crash and someone screaming around 6pm on Tuesday. By the time I looked out my window I saw people running toward the intersection on Mass Ave near Prospect. One person was on the ground. A car sped away. I didn\'t see the color or make.',
    description: 'Pure narrative — no vehicle/object entities of value',
  },
  {
    id: 'wc_person_linked',
    text: 'Sarah mentioned to me last week that someone in a green car had been following her on her bike commute through Central Square. She said she felt unsafe and was going to start taking a different route.',
    description: 'Person-linked — "Sarah" is the join key, not a strong type',
  },
  {
    id: 'wc_case_number',
    text: 'Update on Cambridge PD case #2026-04891 — they are actively seeking dashcam footage from Mass Ave near Prospect St. If you have anything please contact Detective Morales at the Cambridge PD traffic unit.',
    description: 'Indirect evidence — case number is quantity type, not strong',
  },
  {
    id: 'wc_vocab_gap',
    text: 'Witnessed an incident at the Prospect and Massachusetts Avenue crossing Tuesday evening. A large vehicle struck a person on a two-wheeled cycle and fled the scene heading east. Several bystanders were present but appeared confused about what just happened.',
    description: 'Vocabulary gap — "vehicle" "two-wheeled cycle" "crossing" — no standard car/bike words',
  },
]

async function main() {
  const cost = new SimpleCost()
  console.log('=== Hybrid Retrieval Validation ===\n')

  // Load seed
  console.log('Loading seed.json...')
  const seed: SeedData = JSON.parse(readFileSync(SEED_FILE, 'utf8'))
  const embById = new Map<string, number[]>(Object.entries(seed.embeddings))
  console.log(`  ${seed.items.length} items, ${embById.size} embeddings`)

  // Case post
  const casePost = LIVE_ITEMS.find(i => i.id === 't3_strata_casepost')!
  const caseText = normalize(casePost.text)

  // Step 1: Embed case post + worst cases + extract entities
  console.log('\nStep 1: Embedding case post + worst-case items...')
  const allTexts = [caseText, ...WORST_CASES.map(w => normalize(w.text))]
  const allEmbeddings = await embedBatch(client, allTexts, cost)
  const caseEmbedding = allEmbeddings[0]

  // Add worst-case embeddings to the pool (simulate them being in the corpus)
  for (let i = 0; i < WORST_CASES.length; i++) {
    embById.set(WORST_CASES[i].id, allEmbeddings[i + 1])
  }

  console.log('Step 2: Extracting entities...')
  const caseEntities = await extractEntities(client, caseText, cost)
  const wcEntities = new Map<string, Entity[]>()
  for (const wc of WORST_CASES) {
    wcEntities.set(wc.id, await extractEntities(client, normalize(wc.text), cost))
  }

  console.log(`  Case post: ${caseEntities.length} entities`)
  for (const wc of WORST_CASES) {
    const ents = wcEntities.get(wc.id)!
    console.log(`  ${wc.id}: ${ents.length} entities [${ents.map(e => e.type + ':"' + e.surfaceText + '"').join(', ')}]`)
  }

  // Step 3: Build entity embedding index
  console.log('\nStep 3: Building entity index...')
  type IndexEntry = { surfaceText: string; embedding: number[]; itemId: string }
  type TypeIndex = Map<string, IndexEntry[]>

  const toEmbed: Array<{ type: string; surfaceText: string; itemId: string }> = []
  for (const item of seed.items) {
    for (const e of item.entities) {
      toEmbed.push({ type: e.type, surfaceText: e.surfaceText, itemId: item.id })
    }
  }
  // Add worst-case items to the index
  for (const wc of WORST_CASES) {
    for (const e of wcEntities.get(wc.id)!) {
      toEmbed.push({ type: e.type, surfaceText: e.surfaceText, itemId: wc.id })
    }
  }

  const entityEmbTexts = toEmbed.map(e => e.surfaceText)
  const entityEmbeddings = await embedBatch(client, entityEmbTexts, cost)

  const typeIndex: TypeIndex = new Map()
  for (let i = 0; i < toEmbed.length; i++) {
    const { type, surfaceText, itemId } = toEmbed[i]
    if (!typeIndex.has(type)) typeIndex.set(type, [])
    typeIndex.get(type)!.push({ surfaceText, embedding: entityEmbeddings[i], itemId })
  }

  // Step 4: Hub detection
  console.log('Step 4: Hub detection...')
  const TYPE_HUB_THRESHOLD = 0.03
  const MIN_HUB_COUNT = 10
  const totalCorpus = seed.items.length + WORST_CASES.length

  const entityItemCount = new Map<string, Set<string>>()
  for (const [type, entries] of typeIndex) {
    for (const entry of entries) {
      const key = `${type}:${entry.surfaceText.toLowerCase()}`
      if (!entityItemCount.has(key)) entityItemCount.set(key, new Set())
      entityItemCount.get(key)!.add(entry.itemId)
    }
  }
  const itemsPerType = new Map<string, number>()
  for (const [type, entries] of typeIndex) {
    itemsPerType.set(type, new Set(entries.map(e => e.itemId)).size)
  }

  const hubEntities = new Set<string>()
  for (const [key, items] of entityItemCount) {
    const type = key.split(':')[0]
    const typeTotal = itemsPerType.get(type) ?? totalCorpus
    if (items.size / typeTotal > TYPE_HUB_THRESHOLD && items.size >= MIN_HUB_COUNT) {
      hubEntities.add(key)
    }
  }
  console.log(`  ${hubEntities.size} hub entities suppressed`)

  function isHubEntity(type: string, surfaceText: string): boolean {
    return hubEntities.has(`${type}:${surfaceText.toLowerCase()}`)
  }

  // Step 5: Embed case post entities
  console.log('Step 5: Embedding case post entities...')
  const caseEntityEmbTexts = caseEntities.map(e => e.surfaceText)
  const caseEntityEmbeddings = await embedBatch(client, caseEntityEmbTexts, cost)

  const STRONG_TYPES = new Set(['object', 'username', 'phone', 'email', 'url'])
  const caseEntityIsHub = caseEntities.map(e => isHubEntity(e.type, e.surfaceText))

  // ============================================================
  // RETRIEVAL: Entity filter only (Option A)
  // ============================================================
  console.log('\n--- Entity Filter Only ---')
  const FILTER_K = 30
  const entityCandidates = new Set<string>()

  for (let ci = 0; ci < caseEntities.length; ci++) {
    if (caseEntityIsHub[ci]) continue
    const caseEntity = caseEntities[ci]
    if (!STRONG_TYPES.has(caseEntity.type)) continue
    const bucket = typeIndex.get(caseEntity.type)
    if (!bucket) continue

    const scored = bucket
      .filter(e => !isHubEntity(caseEntity.type, e.surfaceText))
      .map(e => ({ itemId: e.itemId, sim: cosine(caseEntityEmbeddings[ci], e.embedding) }))
    scored.sort((a, b) => b.sim - a.sim)
    for (const s of scored.slice(0, FILTER_K)) {
      entityCandidates.add(s.itemId)
    }
  }

  console.log(`  Entity candidates: ${entityCandidates.size}`)
  console.log(`  Signal in entity candidates: ${[...SURFACE_IDS].filter(id => entityCandidates.has(id)).length}/4`)
  console.log(`  Worst-cases in entity candidates:`)
  for (const wc of WORST_CASES) {
    console.log(`    ${wc.id}: ${entityCandidates.has(wc.id) ? 'FOUND' : 'MISSED'} — ${wc.description}`)
  }

  // ============================================================
  // RETRIEVAL: Full-text safety net only (top-20)
  // ============================================================
  console.log('\n--- Full-Text Safety Net Only (top-20) ---')
  const SAFETY_K = 20

  const allIds = [...embById.keys()].filter(id => id !== casePost.id)
  const fullTextScores = allIds.map(id => ({ id, score: cosine(caseEmbedding, embById.get(id)!) }))
  fullTextScores.sort((a, b) => b.score - a.score)
  const safetyNetIds = new Set(fullTextScores.slice(0, SAFETY_K).map(s => s.id))

  console.log(`  Safety net candidates: ${safetyNetIds.size}`)
  console.log(`  Signal in safety net: ${[...SURFACE_IDS].filter(id => safetyNetIds.has(id)).length}/4`)
  console.log(`  Worst-cases in safety net:`)
  for (const wc of WORST_CASES) {
    const rank = fullTextScores.findIndex(s => s.id === wc.id) + 1
    console.log(`    ${wc.id}: ${safetyNetIds.has(wc.id) ? 'FOUND' : 'MISSED'} (rank ${rank}, score ${fullTextScores[rank-1]?.score.toFixed(4)}) — ${wc.description}`)
  }

  // ============================================================
  // RETRIEVAL: HYBRID (entity filter + safety net)
  // ============================================================
  console.log('\n--- HYBRID: Entity Filter + Safety Net ---')
  const hybridCandidates = new Set([...entityCandidates, ...safetyNetIds])
  console.log(`  Entity candidates: ${entityCandidates.size}`)
  console.log(`  Safety net adds: ${[...safetyNetIds].filter(id => !entityCandidates.has(id)).length} new`)
  console.log(`  Total hybrid candidates: ${hybridCandidates.size} (${((hybridCandidates.size / totalCorpus) * 100).toFixed(1)}% of corpus)`)

  // Rerank hybrid candidates by full-text cosine
  const hybridScores = [...hybridCandidates].map(id => ({
    id,
    score: cosine(caseEmbedding, embById.get(id)!),
    source: entityCandidates.has(id) && safetyNetIds.has(id) ? 'both' :
            entityCandidates.has(id) ? 'entity' : 'safety',
  }))
  hybridScores.sort((a, b) => b.score - a.score)
  const hybridRanking = hybridScores.map(s => s.id)

  console.log('\n  Top 15 (hybrid, reranked by full-text cosine):')
  for (let i = 0; i < 15; i++) {
    const s = hybridScores[i]
    const isSignal = SURFACE_IDS.has(s.id)
    const isWC = WORST_CASES.some(w => w.id === s.id)
    const marker = isSignal ? '★' : isWC ? '◆' : ' '
    const item = seed.items.find(it => it.id === s.id)
    const text = item?.text.slice(0, 50) ?? WORST_CASES.find(w => w.id === s.id)?.text.slice(0, 50) ?? ''
    console.log(`    ${i + 1}. ${marker} ${s.id} (${s.score.toFixed(4)}, via ${s.source}) — ${text}...`)
  }

  // ============================================================
  // EVALUATION
  // ============================================================
  console.log('\n=== EVALUATION ===\n')

  // Expand SIGNAL set to include worst-cases for retrieval testing
  const ALL_TARGETS = new Set([...SURFACE_IDS, ...WORST_CASES.map(w => w.id)])

  // C1: All 4 real signals in hybrid top-10
  const signalInHybridTop10 = [...SURFACE_IDS].filter(id => hybridRanking.indexOf(id) < 10)
  const c1Pass = signalInHybridTop10.length === 4
  console.log(`  C1: All 4 signals in hybrid top-10: ${signalInHybridTop10.length}/4`)
  for (const id of SURFACE_IDS) {
    console.log(`      ${id}: rank ${hybridRanking.indexOf(id) + 1}`)
  }
  console.log(`      ${c1Pass ? 'PASS' : 'FAIL'}`)

  // C2: Entity-only would miss at least 1 signal
  const entityOnlyMisses = [...SURFACE_IDS].filter(id => !entityCandidates.has(id))
  const c2Pass = entityOnlyMisses.length >= 1
  console.log(`\n  C2: Entity-only misses signals: ${entityOnlyMisses.length}`)
  for (const id of entityOnlyMisses) {
    console.log(`      MISSED: ${id}`)
  }
  console.log(`      ${c2Pass ? 'PASS (safety net needed)' : 'FAIL (entity-only sufficient)'}`)

  // C3: Safety net catches earwitness (t3_strata_surface4)
  const earwitness = 't3_strata_surface4'
  const earwitnessInSafety = safetyNetIds.has(earwitness)
  const earwitnessInEntity = entityCandidates.has(earwitness)
  const c3Pass = earwitnessInSafety
  console.log(`\n  C3: Earwitness (${earwitness}) found by:`)
  console.log(`      Entity filter: ${earwitnessInEntity ? 'YES' : 'NO'}`)
  console.log(`      Safety net: ${earwitnessInSafety ? 'YES' : 'NO'}`)
  console.log(`      ${c3Pass ? 'PASS' : 'FAIL'}`)

  // C4: Hybrid candidates < 15% of corpus
  const hybridPct = hybridCandidates.size / totalCorpus
  const c4Pass = hybridPct < 0.15
  console.log(`\n  C4: Hybrid size: ${hybridCandidates.size}/${totalCorpus} (${(hybridPct * 100).toFixed(1)}%)`)
  console.log(`      ${c4Pass ? 'PASS' : 'FAIL'} (need < 15%)`)

  // C5: Worst-case items found by hybrid when entities fail
  console.log(`\n  C5: Worst-case items in hybrid results:`)
  let wcFoundCount = 0
  for (const wc of WORST_CASES) {
    const inEntity = entityCandidates.has(wc.id)
    const inSafety = safetyNetIds.has(wc.id)
    const inHybrid = hybridCandidates.has(wc.id)
    const hybridRank = hybridRanking.indexOf(wc.id) + 1
    if (inHybrid) wcFoundCount++
    console.log(`      ${wc.id}: entity=${inEntity ? 'Y' : 'N'} safety=${inSafety ? 'Y' : 'N'} hybrid=${inHybrid ? 'Y' : 'N'} rank=${hybridRank || '-'}`)
    console.log(`        ${wc.description}`)
  }
  const c5Pass = wcFoundCount >= 3
  console.log(`      ${wcFoundCount}/4 worst-cases found`)
  console.log(`      ${c5Pass ? 'PASS' : 'FAIL'} (need >= 3)`)

  // --- Comparison table ---
  const entityRanking = [...entityCandidates]
    .map(id => ({ id, score: cosine(caseEmbedding, embById.get(id)!) }))
    .sort((a, b) => b.score - a.score)
    .map(s => s.id)
  const safetyRanking = fullTextScores.slice(0, SAFETY_K).map(s => s.id)

  console.log('\n  Signal positions across methods:')
  console.log('  Item                    | Entity | Safety | Hybrid')
  console.log('  ------------------------|--------|--------|-------')
  for (const id of [...SURFACE_IDS, ...WORST_CASES.map(w => w.id)]) {
    const eRank = entityRanking.indexOf(id) + 1 || '-'
    const sRank = safetyRanking.indexOf(id) + 1 || '-'
    const hRank = hybridRanking.indexOf(id) + 1 || '-'
    const label = (seed.items.find(i => i.id === id)?.text.slice(0, 22) ?? WORST_CASES.find(w => w.id === id)?.description.slice(0, 22) ?? id).padEnd(22)
    console.log(`  ${label} | ${String(eRank).padStart(6)} | ${String(sRank).padStart(6)} | ${String(hRank).padStart(6)}`)
  }

  // --- Summary ---
  const conditions = [
    { id: 'C1', name: 'All 4 signals in hybrid top-10', pass: c1Pass },
    { id: 'C2', name: 'Entity-only misses signal (proving safety net needed)', pass: c2Pass },
    { id: 'C3', name: 'Safety net catches earwitness', pass: c3Pass },
    { id: 'C4', name: 'Hybrid < 15% of corpus', pass: c4Pass },
    { id: 'C5', name: 'Worst-cases found by hybrid', pass: c5Pass },
  ]

  console.log('\n=== RESULTS ===\n')
  for (const c of conditions) {
    console.log(`  ${c.id} (${c.name}): ${c.pass ? 'PASS' : 'FAIL'}`)
  }
  const passCount = conditions.filter(c => c.pass).length
  console.log(`\n  ${passCount}/${conditions.length} passed`)
  console.log(`  Cost: $${cost.total.toFixed(4)}`)
  console.log(`\n  Verdict: ${passCount >= 5 ? 'HYBRID RETRIEVAL VALIDATED' : passCount >= 4 ? 'MOSTLY WORKS' : passCount >= 3 ? 'MIXED' : 'NEEDS REWORK'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
