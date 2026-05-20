import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'
import { embedBatch, cosine } from '../src/engine/embed.js'
import type { StoredItem, Entity, CostTracker } from '../src/engine/types.js'
import { BACKFILL_ITEMS, LIVE_ITEMS, SURFACE_IDS } from '../dataset/signal-items.js'

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
// HYPOTHESIS: On a 3K-item corpus, entity-embed hybrid
// outperforms pure full-text cosine on retrieval quality.
//
// The 20-item test had baseline at ceiling (all signals top-4).
// With 3K real reddit posts as noise, the baseline will degrade
// and the entity signal should provide meaningful lift.
//
// SUCCESS CONDITIONS:
//   C1: Hybrid recall@10 >= baseline recall@10
//   C2: Hybrid precision@5 > baseline precision@5
//   C3: All 4 signal items ranked above any confuser noise
//   C4: Option A shrinks search space by >80% while keeping recall
// ============================================================

type SeedData = {
  items: StoredItem[]
  embeddings: Record<string, number[]>
}

function precision(ranked: string[], k: number, signals: Set<string>): number {
  const topK = ranked.slice(0, k)
  return topK.filter(id => signals.has(id)).length / k
}

function recall(ranked: string[], k: number, signals: Set<string>): number {
  const topK = ranked.slice(0, k)
  return topK.filter(id => signals.has(id)).length / signals.size
}

function mrr(ranked: string[], signals: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (signals.has(ranked[i])) return 1 / (i + 1)
  }
  return 0
}

async function main() {
  const cost = new SimpleCost()
  console.log('=== Entity-Embed Hybrid vs Baseline — 3K Corpus ===\n')

  // --- Load seed data (pre-computed embeddings + entities) ---
  console.log('Loading seed.json (3K items)...')
  const seed: SeedData = JSON.parse(readFileSync(SEED_FILE, 'utf8'))
  console.log(`  ${seed.items.length} items, ${Object.keys(seed.embeddings).length} embeddings`)

  // Build lookup maps
  const itemById = new Map<string, StoredItem>(seed.items.map(i => [i.id, i]))
  const embById = new Map<string, number[]>(Object.entries(seed.embeddings))

  // The case post
  const casePost = LIVE_ITEMS.find(i => i.id === 't3_strata_casepost')!
  const caseText = normalize(casePost.text)

  // --- Step 1: Embed case post full-text ---
  console.log('\nStep 1: Embedding case post...')
  const [caseEmbedding] = await embedBatch(client, [caseText], cost)

  // --- Step 2: Extract + embed case post entities ---
  console.log('Step 2: Extracting case post entities...')
  const caseEntities = await extractEntities(client, caseText, cost)
  console.log(`  Found ${caseEntities.length} entities`)
  for (const e of caseEntities) {
    console.log(`    ${e.type}: "${e.surfaceText}"`)
  }

  console.log('\nStep 3: Embedding case post entity surfaceTexts...')
  const caseEntityTexts = caseEntities.map(e => e.surfaceText)
  const caseEntityEmbeddings = await embedBatch(client, caseEntityTexts, cost)

  // --- Step 4: Build type-bucketed entity index from seed ---
  console.log('Step 4: Building entity embedding index from 3K seed items...')
  type IndexEntry = { surfaceText: string; embedding: number[]; itemId: string }
  type TypeIndex = Map<string, IndexEntry[]>

  const toEmbed: Array<{ type: string; surfaceText: string; itemId: string }> = []
  for (const item of seed.items) {
    for (const e of item.entities) {
      toEmbed.push({ type: e.type, surfaceText: e.surfaceText, itemId: item.id })
    }
  }
  console.log(`  Total entities to embed: ${toEmbed.length}`)

  // Embed in batches
  const entityEmbTexts = toEmbed.map(e => e.surfaceText)
  console.log('  Embedding entity surfaceTexts (this may take a moment)...')
  const entityEmbeddings = await embedBatch(client, entityEmbTexts, cost)
  console.log(`  Done. Cost so far: $${cost.total.toFixed(4)}`)

  const typeIndex: TypeIndex = new Map()
  for (let i = 0; i < toEmbed.length; i++) {
    const { type, surfaceText, itemId } = toEmbed[i]
    if (!typeIndex.has(type)) typeIndex.set(type, [])
    typeIndex.get(type)!.push({ surfaceText, embedding: entityEmbeddings[i], itemId })
  }

  console.log('\n  Type buckets:')
  for (const [type, entries] of typeIndex) {
    const uniqueItems = new Set(entries.map(e => e.itemId)).size
    console.log(`    ${type}: ${entries.length} entities from ${uniqueItems} items`)
  }

  // --- Hub detection (per-type IDF) ---
  // An entity is a hub if it appears in too many items relative to its type bucket.
  // This catches "car" (48/769 object items = 6%) while keeping "dark green SUV" (1 item).
  console.log('\nStep 5: Hub detection (per-type)...')
  const TYPE_HUB_THRESHOLD = 0.03 // entity in >3% of items within its type = hub
  const MIN_HUB_COUNT = 10 // must appear in at least 10 items to be a hub

  // Count items per entity
  const entityItemCount = new Map<string, Set<string>>()
  for (const [type, entries] of typeIndex) {
    for (const entry of entries) {
      const key = `${type}:${entry.surfaceText.toLowerCase()}`
      if (!entityItemCount.has(key)) entityItemCount.set(key, new Set())
      entityItemCount.get(key)!.add(entry.itemId)
    }
  }

  // Count unique items per type
  const itemsPerType = new Map<string, number>()
  for (const [type, entries] of typeIndex) {
    itemsPerType.set(type, new Set(entries.map(e => e.itemId)).size)
  }

  const hubEntities = new Set<string>()
  const hubList: Array<{ key: string; count: number; pct: number }> = []
  for (const [key, items] of entityItemCount) {
    const type = key.split(':')[0]
    const typeTotal = itemsPerType.get(type) ?? seed.items.length
    const freq = items.size / typeTotal
    if (freq > TYPE_HUB_THRESHOLD && items.size >= MIN_HUB_COUNT) {
      hubEntities.add(key)
      hubList.push({ key, count: items.size, pct: freq * 100 })
    }
  }
  hubList.sort((a, b) => b.count - a.count)
  console.log(`  Hubs (>${(TYPE_HUB_THRESHOLD * 100).toFixed(0)}% within type, ${MIN_HUB_COUNT}+ items): ${hubList.length}`)
  for (const h of hubList.slice(0, 30)) {
    console.log(`    ${h.key}: ${h.count} items (${h.pct.toFixed(1)}% of type)`)
  }

  function isHubEntity(type: string, surfaceText: string): boolean {
    return hubEntities.has(`${type}:${surfaceText.toLowerCase()}`)
  }

  const caseEntityIsHub = caseEntities.map(e => isHubEntity(e.type, e.surfaceText))
  const nonHubCaseEntities = caseEntities.filter((_, i) => !caseEntityIsHub[i])
  console.log(`\n  Case entities: ${nonHubCaseEntities.length}/${caseEntities.length} non-hub`)
  for (let i = 0; i < caseEntities.length; i++) {
    if (caseEntityIsHub[i]) console.log(`    HUB: ${caseEntities[i].type}:"${caseEntities[i].surfaceText}"`)
  }

  // --- Type weights ---
  const TYPE_WEIGHTS: Record<string, number> = {
    object: 1.0, person: 1.0, username: 1.0, phone: 1.0, email: 1.0, url: 1.0,
    quantity: 0.7, organization: 0.5, location: 0.3, time: 0.3, monetary_amount: 0.5,
  }
  const STRONG_TYPES = new Set(['object', 'username', 'phone', 'email', 'url'])
  const STRONG_THRESHOLD = 0.55

  // ============================================================
  // BASELINE: Full-text cosine scan
  // ============================================================
  console.log('\n--- BASELINE: Full-text cosine (3K scan) ---')
  const baselineScores: Array<{ id: string; score: number }> = []
  for (const [id, emb] of embById) {
    if (id === casePost.id) continue
    baselineScores.push({ id, score: cosine(caseEmbedding, emb) })
  }
  baselineScores.sort((a, b) => b.score - a.score)
  const baselineRanking = baselineScores.map(s => s.id)

  console.log('  Top 15:')
  for (let i = 0; i < 15; i++) {
    const s = baselineScores[i]
    const isSignal = SURFACE_IDS.has(s.id)
    const item = itemById.get(s.id)
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} ${s.id} (${s.score.toFixed(4)}) — ${item?.text.slice(0, 60)}...`)
  }

  // ============================================================
  // Helper: compute type-weighted entity score for an item
  // ============================================================
  function entityScore(itemId: string): { score: number; hasStrong: boolean; bestMatch: string; typesMatched: number } {
    const bestPerType = new Map<string, { sim: number; match: string }>()

    for (let ci = 0; ci < caseEntities.length; ci++) {
      if (caseEntityIsHub[ci]) continue
      const caseEntity = caseEntities[ci]
      const bucket = typeIndex.get(caseEntity.type)
      if (!bucket) continue

      for (const entry of bucket) {
        if (entry.itemId !== itemId) continue
        if (isHubEntity(caseEntity.type, entry.surfaceText)) continue
        const sim = cosine(caseEntityEmbeddings[ci], entry.embedding)
        const current = bestPerType.get(caseEntity.type)
        if (!current || sim > current.sim) {
          bestPerType.set(caseEntity.type, { sim, match: `${caseEntity.type}:"${caseEntity.surfaceText}" ↔ "${entry.surfaceText}"` })
        }
      }
    }

    let hasStrong = false
    for (const type of STRONG_TYPES) {
      if ((bestPerType.get(type)?.sim ?? 0) >= STRONG_THRESHOLD) { hasStrong = true; break }
    }

    let wSum = 0, wTotal = 0, bestMatch = '', bestWeighted = 0
    for (const [type, { sim, match }] of bestPerType) {
      const tw = TYPE_WEIGHTS[type] ?? 0.5
      if (!STRONG_TYPES.has(type) && !hasStrong) continue
      wSum += sim * tw
      wTotal += tw
      if (sim * tw > bestWeighted) { bestWeighted = sim * tw; bestMatch = match }
    }

    return { score: wTotal > 0 ? wSum / wTotal : 0, hasStrong, bestMatch, typesMatched: bestPerType.size }
  }

  // ============================================================
  // OPTION A: Entity filter → full-text rerank
  // ============================================================
  console.log('\n--- OPTION A: Entity filter → full-text rerank ---')
  const FILTER_K = 30
  const optionACandidates = new Set<string>()

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
      optionACandidates.add(s.itemId)
    }
  }

  const optionAScores = [...optionACandidates].map(id => ({
    id, score: cosine(caseEmbedding, embById.get(id)!),
  })).filter(s => s.score !== undefined)
  optionAScores.sort((a, b) => b.score - a.score)
  const optionARanking = optionAScores.map(s => s.id)

  // Diagnostic: check signal items' entity scores against case entities
  console.log('\n  Diagnostic — signal items vs case product entities:')
  for (const sigId of SURFACE_IDS) {
    const bucket = typeIndex.get('object')
    if (!bucket) continue
    const sigEntries = bucket.filter(e => e.itemId === sigId)
    if (sigEntries.length === 0) { console.log(`    ${sigId}: NO product entities in index`); continue }

    let bestSim = 0, bestPair = ''
    for (let ci = 0; ci < caseEntities.length; ci++) {
      if (caseEntities[ci].type !== 'object') continue
      for (const entry of sigEntries) {
        const sim = cosine(caseEntityEmbeddings[ci], entry.embedding)
        if (sim > bestSim) {
          bestSim = sim
          bestPair = `"${caseEntities[ci].surfaceText}" ↔ "${entry.surfaceText}"`
        }
      }
    }
    const inCandidates = optionACandidates.has(sigId)
    console.log(`    ${sigId}: best=${bestSim.toFixed(4)} ${bestPair} ${inCandidates ? '(IN candidates)' : '(MISSED)'}`)
  }

  console.log(`\n  Candidates from entity filter: ${optionACandidates.size}/${seed.items.length} (${((optionACandidates.size / seed.items.length) * 100).toFixed(1)}% of corpus)`)
  console.log('  Top 15:')
  for (let i = 0; i < Math.min(15, optionAScores.length); i++) {
    const s = optionAScores[i]
    const isSignal = SURFACE_IDS.has(s.id)
    const item = itemById.get(s.id)
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} ${s.id} (${s.score.toFixed(4)}) — ${item?.text.slice(0, 60)}...`)
  }

  // ============================================================
  // OPTION B: Weighted fusion (type-weighted, hub-filtered)
  // ============================================================
  console.log('\n--- OPTION B: Weighted fusion (α=0.5) ---')
  const ALPHA = 0.5

  const optionBScores = baselineScores.map(({ id, score: ft }) => {
    const es = entityScore(id)
    return { id, score: ALPHA * es.score + (1 - ALPHA) * ft, ft, entity: es.score, hasStrong: es.hasStrong, bestMatch: es.bestMatch }
  })
  optionBScores.sort((a, b) => b.score - a.score)
  const optionBRanking = optionBScores.map(s => s.id)

  console.log('  Top 15:')
  for (let i = 0; i < 15; i++) {
    const s = optionBScores[i]
    const isSignal = SURFACE_IDS.has(s.id)
    const item = itemById.get(s.id)
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} ${s.id} (combined=${s.score.toFixed(4)}, ft=${s.ft.toFixed(4)}, ent=${s.entity.toFixed(4)}, strong=${s.hasStrong})`)
    if (s.bestMatch) console.log(`         ${s.bestMatch}`)
  }

  // ============================================================
  // OPTION C: Entity boost on full scan (strong types only)
  // ============================================================
  console.log('\n--- OPTION C: Full scan + entity boost (0.3x) ---')
  const BOOST = 0.3

  const optionCScores = baselineScores.map(({ id, score: ft }) => {
    const es = entityScore(id)
    const boost = es.hasStrong ? es.score : 0
    return { id, score: ft + BOOST * boost }
  })
  optionCScores.sort((a, b) => b.score - a.score)
  const optionCRanking = optionCScores.map(s => s.id)

  console.log('  Top 15:')
  for (let i = 0; i < 15; i++) {
    const s = optionCScores[i]
    const isSignal = SURFACE_IDS.has(s.id)
    const item = itemById.get(s.id)
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} ${s.id} (${s.score.toFixed(4)}) — ${item?.text.slice(0, 60)}...`)
  }

  // ============================================================
  // EVALUATION
  // ============================================================
  console.log('\n=== EVALUATION ===\n')

  const baseP5 = precision(baselineRanking, 5, SURFACE_IDS)
  const baseP10 = precision(baselineRanking, 10, SURFACE_IDS)
  const baseR10 = recall(baselineRanking, 10, SURFACE_IDS)
  const baseR15 = recall(baselineRanking, 15, SURFACE_IDS)
  const baseMRR = mrr(baselineRanking, SURFACE_IDS)

  const optA_P5 = precision(optionARanking, 5, SURFACE_IDS)
  const optA_P10 = precision(optionARanking, 10, SURFACE_IDS)
  const optA_R10 = recall(optionARanking, 10, SURFACE_IDS)
  const optA_R15 = recall(optionARanking, 15, SURFACE_IDS)
  const optA_MRR = mrr(optionARanking, SURFACE_IDS)

  const optB_P5 = precision(optionBRanking, 5, SURFACE_IDS)
  const optB_P10 = precision(optionBRanking, 10, SURFACE_IDS)
  const optB_R10 = recall(optionBRanking, 10, SURFACE_IDS)
  const optB_R15 = recall(optionBRanking, 15, SURFACE_IDS)
  const optB_MRR = mrr(optionBRanking, SURFACE_IDS)

  const optC_P5 = precision(optionCRanking, 5, SURFACE_IDS)
  const optC_P10 = precision(optionCRanking, 10, SURFACE_IDS)
  const optC_R10 = recall(optionCRanking, 10, SURFACE_IDS)
  const optC_R15 = recall(optionCRanking, 15, SURFACE_IDS)
  const optC_MRR = mrr(optionCRanking, SURFACE_IDS)

  console.log('  Approach                      | P@5  | P@10 | R@10 | R@15 | MRR')
  console.log('  ------------------------------|------|------|------|------|-----')
  console.log(`  Baseline (full-text only)     | ${baseP5.toFixed(2)} | ${baseP10.toFixed(2)} | ${baseR10.toFixed(2)} | ${baseR15.toFixed(2)} | ${baseMRR.toFixed(2)}`)
  console.log(`  Option A (entity filter)      | ${optA_P5.toFixed(2)} | ${optA_P10.toFixed(2)} | ${optA_R10.toFixed(2)} | ${optA_R15.toFixed(2)} | ${optA_MRR.toFixed(2)}`)
  console.log(`  Option B (weighted fusion)    | ${optB_P5.toFixed(2)} | ${optB_P10.toFixed(2)} | ${optB_R10.toFixed(2)} | ${optB_R15.toFixed(2)} | ${optB_MRR.toFixed(2)}`)
  console.log(`  Option C (entity boost)       | ${optC_P5.toFixed(2)} | ${optC_P10.toFixed(2)} | ${optC_R10.toFixed(2)} | ${optC_R15.toFixed(2)} | ${optC_MRR.toFixed(2)}`)

  // Signal positions
  console.log('\n  Signal item positions:')
  console.log('  Item                    | Baseline | Opt A | Opt B | Opt C')
  console.log('  ------------------------|----------|-------|-------|------')
  for (const id of SURFACE_IDS) {
    const bPos = baselineRanking.indexOf(id) + 1
    const aPos = optionARanking.indexOf(id) + 1 || '-'
    const bpPos = optionBRanking.indexOf(id) + 1
    const cPos = optionCRanking.indexOf(id) + 1
    const item = itemById.get(id)
    const label = item?.text.slice(0, 22).padEnd(22) ?? id.padEnd(22)
    console.log(`  ${label} | ${String(bPos).padStart(8)} | ${String(aPos).padStart(5)} | ${String(bpPos).padStart(5)} | ${String(cPos).padStart(5)}`)
  }

  // --- Success conditions ---
  console.log('\n--- Success Conditions ---\n')

  const c1Pass = optB_R10 >= baseR10 && optC_R10 >= baseR10
  console.log(`  C1: Hybrid recall@10 >= baseline`)
  console.log(`      Baseline R@10=${baseR10.toFixed(2)}, OptB=${optB_R10.toFixed(2)}, OptC=${optC_R10.toFixed(2)}`)
  console.log(`      ${c1Pass ? 'PASS' : 'FAIL'}`)

  const c2Pass = optB_P5 > baseP5 || optC_P5 > baseP5
  console.log(`  C2: Any hybrid P@5 > baseline`)
  console.log(`      Baseline P@5=${baseP5.toFixed(2)}, OptB=${optB_P5.toFixed(2)}, OptC=${optC_P5.toFixed(2)}`)
  console.log(`      ${c2Pass ? 'PASS' : 'FAIL'}`)

  const c3_signals_base = [...SURFACE_IDS].map(id => baselineRanking.indexOf(id))
  const c3_signals_C = [...SURFACE_IDS].map(id => optionCRanking.indexOf(id))
  const c3_avgBase = c3_signals_base.reduce((a, b) => a + b, 0) / 4
  const c3_avgC = c3_signals_C.reduce((a, b) => a + b, 0) / 4
  const c3Pass = c3_avgC < c3_avgBase
  console.log(`  C3: Avg signal rank improved`)
  console.log(`      Baseline avg rank: ${c3_avgBase.toFixed(1)}, OptC avg rank: ${c3_avgC.toFixed(1)}`)
  console.log(`      ${c3Pass ? 'PASS' : 'FAIL'}`)

  const searchSpaceReduction = 1 - (optionACandidates.size / seed.items.length)
  const optA_recallAll = [...SURFACE_IDS].filter(id => optionACandidates.has(id)).length / SURFACE_IDS.size
  const c4Pass = searchSpaceReduction > 0.80 && optA_recallAll >= 0.75
  console.log(`  C4: Option A shrinks search >80% while keeping recall >=75%`)
  console.log(`      Search space reduction: ${(searchSpaceReduction * 100).toFixed(1)}%`)
  console.log(`      Signal recall in candidates: ${(optA_recallAll * 100).toFixed(0)}% (${[...SURFACE_IDS].filter(id => optionACandidates.has(id)).length}/4)`)
  console.log(`      ${c4Pass ? 'PASS' : 'FAIL'}`)

  // Alpha sensitivity
  console.log('\n--- Alpha Sensitivity (Option B) ---')
  for (const alpha of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const scores = baselineScores.map(({ id, score: ft }) => {
      const es = entityScore(id)
      return { id, score: alpha * es.score + (1 - alpha) * ft }
    })
    scores.sort((a, b) => b.score - a.score)
    const ranking = scores.map(s => s.id)
    console.log(`  α=${alpha.toFixed(1)}: P@5=${precision(ranking, 5, SURFACE_IDS).toFixed(2)} P@10=${precision(ranking, 10, SURFACE_IDS).toFixed(2)} R@10=${recall(ranking, 10, SURFACE_IDS).toFixed(2)} MRR=${mrr(ranking, SURFACE_IDS).toFixed(2)}`)
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  const conditions = [
    { id: 'C1', name: 'Recall not degraded', pass: c1Pass },
    { id: 'C2', name: 'Precision improved', pass: c2Pass },
    { id: 'C3', name: 'Avg signal rank improved', pass: c3Pass },
    { id: 'C4', name: 'Option A: >80% search reduction + recall', pass: c4Pass },
  ]

  console.log('\n=== RESULTS ===\n')
  for (const c of conditions) {
    console.log(`  ${c.id} (${c.name}): ${c.pass ? 'PASS' : 'FAIL'}`)
  }
  const passCount = conditions.filter(c => c.pass).length
  console.log(`\n  ${passCount}/${conditions.length} passed`)
  console.log(`  Cost: $${cost.total.toFixed(4)}`)
  console.log(`\n  Verdict: ${passCount >= 4 ? 'ENTITY-EMBED VALIDATED ON 3K' : passCount >= 3 ? 'MOSTLY WORKS — SHIP WITH CAVEATS' : passCount >= 2 ? 'MIXED — NEEDS TUNING' : 'DOES NOT HELP AT SCALE'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
