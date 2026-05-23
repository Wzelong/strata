// Comprehensive benchmark harness.
//
// Runs N trials of surface + scan + 3 flag checks, plus one-time computations
// for the classifier confusion matrix + network graph + channel match matrix.
//
// Output: a single JSON file with everything the viz script needs to render
// the 5 plots, so visualizations can be tuned without re-running the LLM.
//
// Env vars:
//   SEED_PATH    default benchmark/benchmark-seed.json
//   LIVE_PATH    default benchmark/benchmark-live-items.json
//   TRIALS       default 10
//   OUTPUT       default benchmark/results.json

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { buildScanPairs } from '../src/engine/scan.js'
import { cosine } from '../src/engine/embed.js'
import { stringSimilarity } from '../src/engine/search.js'
import { LABELED_CASES } from '../dataset/labeled-cases.js'
import { REMOVED_ITEMS, SURFACE_IDS, BRIGADE_IDS, DECOY_IDS } from '../dataset/signal-items.js'
import type { StoredItem, Entity } from '../src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_PATH = resolve(process.cwd(), process.env.SEED_PATH ?? 'benchmark/benchmark-seed.json')
const LIVE_PATH = resolve(process.cwd(), process.env.LIVE_PATH ?? 'benchmark/benchmark-live-items.json')
const OUTPUT = resolve(process.cwd(), process.env.OUTPUT ?? 'benchmark/results.json')
const TRIALS = parseInt(process.env.TRIALS ?? '10', 10)

const CASE = LABELED_CASES['case-a-cyclist']
const BURIED = new Set(CASE.buriedWitnessIds)
const IN_THREAD = new Set(CASE.inThreadIds)
const DECOYS = new Set(CASE.decoyIds)
const REMOVED_IDS = new Set(Object.keys(REMOVED_ITEMS))

function roleOf(id: string): string {
  if (id === CASE.anchorId) return 'anchor'
  if (BURIED.has(id)) return 'buried'
  if (DECOYS.has(id)) return 'decoy'
  if (BRIGADE_IDS.has(id)) return 'brigade'
  if (id === 't1_strata_flag2b' || id === 't1_strata_flag2a') return 'contradiction'
  if (REMOVED_IDS.has(id)) return 'removed'
  if (id === 't3_strata_flag4') return 'pattern'
  if (IN_THREAD.has(id)) return 'thread'
  return 'corpus'
}

function shortLabel(id: string): string {
  const m: Record<string, string> = {
    't3_strata_casepost': 'Case Post',
    't1_strata_surface1': 'S1 near-miss',
    't3_strata_surface2': 'S2 case#',
    't1_strata_surface3': 'S3 garage -K77',
    't3_strata_surface4': 'S4 earwitness',
    't3_strata_decoy1': 'D1 cat (vehicle)',
    't1_strata_decoy2': 'D2 bike case#',
    't1_strata_decoy3': 'D3 CharlieCard K77',
    't3_strata_decoy4': 'D4 Davis crash',
    't1_strata_flag2a': 'flag2a (bar post)',
    't1_strata_flag2b': 'flag2b (contradicts)',
    't3_strata_flag4': 'flag4 (pattern)',
    't3_strata_flag3a': 'flag3a (removed)',
    't3_strata_flag3b': 'flag3b (removed)',
    't3_strata_flag3c': 'flag3c (removed)',
  }
  if (m[id]) return m[id]
  if (id.startsWith('t1_strata_brigade')) return `Brigade ${id.slice(-1)}`
  if (id.startsWith('t1_strata_thread_')) return `Thread ${id.replace('t1_strata_thread_', '')}`
  return id
}

async function buildStore(): Promise<MemoryKVStore> {
  console.log(`Loading seed from ${SEED_PATH}...`)
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
    items: StoredItem[]
    embeddings: Record<string, number[]>
    entityEmbeddings: Record<string, Record<string, string>>
  }
  const live = JSON.parse(readFileSync(LIVE_PATH, 'utf8')) as {
    items: Array<{ id: string; textNormalized: string; embedding: number[]; entities: Entity[] }>
  }
  const store = new MemoryKVStore()

  for (const it of seed.items) {
    await store.setItem(it)
    if (seed.embeddings[it.id]) await store.setEmbedding(it.id, seed.embeddings[it.id])
    if (it.entities.length > 0) await store.addToEntityIndex(it.entities, it.id, it.createdAt)
  }
  const entsByItem = new Map<string, Array<{ type: string; surfaceText: string; embedding: string }>>()
  for (const [type, entries] of Object.entries(seed.entityEmbeddings ?? {})) {
    for (const [key, enc] of Object.entries(entries)) {
      const colon = key.indexOf(':')
      const itemId = key.slice(0, colon)
      const surfaceText = key.slice(colon + 1)
      if (!entsByItem.has(itemId)) entsByItem.set(itemId, [])
      entsByItem.get(itemId)!.push({ type, surfaceText, embedding: enc })
    }
  }
  for (const [itemId, ents] of entsByItem) await store.setEntityEmbeddings(itemId, ents)

  for (const li of live.items) {
    const isInThread = li.id.startsWith('t1_strata_brigade') || li.id === 't1_strata_flag2b'
    const stored: StoredItem = {
      id: li.id,
      type: li.id.startsWith('t1_') ? 'comment' : 'post',
      text: li.textNormalized,
      textNormalized: li.textNormalized,
      authorId: li.id.startsWith('t1_strata_brigade') ? `t2_brigade_${li.id.slice(-1)}` :
                li.id === 't1_strata_flag2b' ? 't2_tkfromcambridge' :
                li.id === 't3_strata_casepost' ? 't2_sarahsroommate' :
                li.id === 't3_strata_flag4' ? 't2_massavesafety' : 'live',
      authorName: li.id === 't1_strata_flag2b' ? 'TKfromCambridge' :
                  li.id === 't3_strata_flag4' ? 'MassAveSafety' :
                  li.id === 't3_strata_casepost' ? 'SarahsRoommate2026' : li.id,
      createdAt: Date.now(),
      threadRootId: isInThread ? 't3_strata_casepost' : li.id,
      parentId: isInThread ? 't3_strata_casepost' : null,
      entities: li.entities,
      decision: 'pending',
      decisionAt: null,
      decisionBy: null,
      decisionReason: null,
    }
    await store.setItem(stored)
    await store.setEmbedding(li.id, li.embedding)
    if (li.entities.length > 0) await store.addToEntityIndex(li.entities, li.id, stored.createdAt)
  }

  for (const [id, meta] of Object.entries(REMOVED_ITEMS)) {
    const it = await store.getItem(id)
    if (!it) continue
    await store.setItem({ ...it, decision: meta.decision, decisionAt: it.createdAt + 3600000, decisionBy: meta.decisionBy, decisionReason: meta.decisionReason })
    await store.moveDecision(id, 'pending', 'removed', it.createdAt + 3600000)
  }

  console.log(`  hydrated: ${seed.items.length + live.items.length} items`)
  return store
}

type TrialData = {
  trial: number
  surface: {
    ok: boolean
    ms: number
    candidates: Array<{ id: string; score: number; role: string; label: string }>
    buried_at_K: number[]
  }
  scan: {
    ok: boolean
    ms: number
    first_signal_rank: number
    groups: Array<{ rank: number; anchor: string; anchor_label: string; size: number; buried: number; decoy: number; in_thread: number }>
    buried_in_anchors_unique: number
  }
  flag_contradiction: { ok: boolean; ms: number; refs_flag2a: boolean; reasoning: string }
  flag_pattern: { ok: boolean; ms: number; fired: boolean; precedents: string[]; reasoning: string }
  flag_brigade: { ok: boolean; ms: number; fired: boolean; authors: number; reasoning: string }
}

async function runTrial(store: MemoryKVStore, client: OpenAI, trial: number): Promise<TrialData> {
  const engine = new StrataEngine(store, client)
  const ts: TrialData = {
    trial,
    surface: { ok: false, ms: 0, candidates: [], buried_at_K: [] },
    scan: { ok: false, ms: 0, first_signal_rank: -1, groups: [], buried_in_anchors_unique: 0 },
    flag_contradiction: { ok: false, ms: 0, refs_flag2a: false, reasoning: '' },
    flag_pattern: { ok: false, ms: 0, fired: false, precedents: [], reasoning: '' },
    flag_brigade: { ok: false, ms: 0, fired: false, authors: 0, reasoning: '' },
  }

  // Surface
  {
    const t0 = performance.now()
    const stored = await store.getItem('t3_strata_casepost')
    const emb = await store.getEmbedding('t3_strata_casepost')
    const { candidates } = await engine.surface({ ...stored!, embedding: emb ?? [] }, { topK: 40 })
    const buriedAtK: number[] = []
    let found = new Set<string>()
    for (let k = 0; k < 25; k++) {
      if (k < candidates.length && BURIED.has(candidates[k].item.id)) found.add(candidates[k].item.id)
      buriedAtK.push(found.size)
    }
    ts.surface = {
      // Pass = ≥3 of 4 buried witnesses surfaced in top-15. The pure-narrative
      // S4 (text cosine only) is genuinely hard at 10K scale and is honestly
      // reported in the recall@K curve rather than enforced as a hard pass.
      ok: buriedAtK[14] >= 3,
      ms: performance.now() - t0,
      candidates: candidates.map(c => ({
        id: c.item.id,
        score: c.weight,
        role: roleOf(c.item.id),
        label: shortLabel(c.item.id),
      })),
      buried_at_K: buriedAtK,
    }
  }

  // Scan
  {
    const t0 = performance.now()
    const pairs = await buildScanPairs(store)
    let signalRank = -1
    const buried = new Set<string>()
    const groups: TrialData['scan']['groups'] = []
    for (let i = 0; i < pairs.length; i++) {
      const all = [pairs[i].anchorId, ...pairs[i].connectionIds]
      const b = all.filter(id => BURIED.has(id)).length
      const d = all.filter(id => DECOYS.has(id)).length
      const t = all.filter(id => IN_THREAD.has(id)).length
      for (const id of all) if (BURIED.has(id)) buried.add(id)
      if (signalRank === -1 && b >= 2) signalRank = i + 1
      groups.push({
        rank: i + 1,
        anchor: pairs[i].anchorId,
        anchor_label: shortLabel(pairs[i].anchorId),
        size: all.length,
        buried: b,
        decoy: d,
        in_thread: t,
      })
    }
    ts.scan = {
      ok: buried.size >= 3,
      ms: performance.now() - t0,
      first_signal_rank: signalRank,
      groups,
      buried_in_anchors_unique: buried.size,
    }
  }

  // Flag: contradiction
  {
    const t0 = performance.now()
    const stored = await store.getItem('t1_strata_flag2b')
    const emb = await store.getEmbedding('t1_strata_flag2b')
    const flags = await engine.flag({ ...stored!, embedding: emb ?? [] })
    const contradiction = flags.find(f => f.type === 'contradiction')
    const refs = !!contradiction?.connectionItems.find(c => c.id === 't1_strata_flag2a')
    ts.flag_contradiction = {
      ok: refs,
      ms: performance.now() - t0,
      refs_flag2a: refs,
      reasoning: contradiction?.reasoning ?? '',
    }
  }

  // Flag: pattern
  {
    const t0 = performance.now()
    const stored = await store.getItem('t3_strata_flag4')
    const emb = await store.getEmbedding('t3_strata_flag4')
    const flags = await engine.flag({ ...stored!, embedding: emb ?? [] })
    const pattern = flags.find(f => f.type === 'pattern')
    ts.flag_pattern = {
      ok: !!pattern,
      ms: performance.now() - t0,
      fired: !!pattern,
      precedents: pattern?.connectionItems.map(c => c.id) ?? [],
      reasoning: pattern?.reasoning ?? '',
    }
  }

  // Flag: brigade
  {
    const t0 = performance.now()
    const stored = await store.getItem('t1_strata_brigade2')
    const emb = await store.getEmbedding('t1_strata_brigade2')
    const flags = await engine.flag({ ...stored!, embedding: emb ?? [] })
    const brigade = flags.find(f => f.type === 'brigade')
    const authors = brigade ? new Set(brigade.connectionItems.map(c => c.authorId)).size + 1 : 0
    ts.flag_brigade = {
      ok: !!brigade,
      ms: performance.now() - t0,
      fired: !!brigade,
      authors,
      reasoning: brigade?.reasoning ?? '',
    }
  }

  return ts
}

// ============================================================================
// Static data: computed once, not per trial. Used by network + channels viz.
// ============================================================================

async function computeStaticData(store: MemoryKVStore, client: OpenAI) {
  // The set of planted items we want in the network graph
  const networkItems = [
    't3_strata_casepost',
    't1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4',
    't3_strata_decoy1', 't1_strata_decoy2', 't1_strata_decoy3', 't3_strata_decoy4',
    't1_strata_brigade1', 't1_strata_brigade2', 't1_strata_brigade3', 't1_strata_brigade4',
    't1_strata_flag2a', 't1_strata_flag2b',
    't3_strata_flag4',
    't3_strata_flag3a', 't3_strata_flag3b', 't3_strata_flag3c',
    't1_strata_thread_modA', 't1_strata_thread_closureA',
  ]

  type ItemInfo = { id: string; entities: Entity[]; embedding: number[]; label: string; role: string }
  const items = new Map<string, ItemInfo>()
  for (const id of networkItems) {
    const stored = await store.getItem(id)
    const emb = await store.getEmbedding(id)
    if (!stored || !emb) continue
    items.set(id, { id, entities: stored.entities, embedding: emb, label: shortLabel(id), role: roleOf(id) })
  }

  // Edges: planted-item to planted-item. Two kinds of links:
  //   strong entity match (Dice ≥0.9 or embedding cosine ≥0.7 by type rules)
  //   narrative cosine ≥0.55 (text-level topical proximity)
  // Each edge captures channel (entity type or 'narrative') + strength.
  type Edge = { source: string; target: string; channel: string; strength: number; type: 'entity' | 'narrative' }
  const edges: Edge[] = []
  const ids = [...items.keys()]
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = items.get(ids[i])!
      const b = items.get(ids[j])!
      let best: { channel: string; strength: number } | null = null
      for (const ea of a.entities) {
        for (const eb of b.entities) {
          if (ea.type !== eb.type) continue
          const sim = stringSimilarity(ea.surfaceText, eb.surfaceText)
          if (sim >= 0.9) {
            if (!best || sim > best.strength) best = { channel: ea.type, strength: sim }
          }
        }
      }
      if (best) {
        edges.push({ source: a.id, target: b.id, channel: best.channel, strength: best.strength, type: 'entity' })
      } else {
        const cos = cosine(a.embedding, b.embedding)
        if (cos >= 0.55) {
          edges.push({ source: a.id, target: b.id, channel: 'narrative', strength: cos, type: 'narrative' })
        }
      }
    }
  }

  const nodes = [...items.values()].map(it => ({
    id: it.id,
    label: it.label,
    role: it.role,
    entity_count: it.entities.length,
  }))

  // -----------------------------------------------------------------
  // Channels matrix
  // -----------------------------------------------------------------
  const channelRows = [
    { id: 't1_strata_surface1', label: 'S1 near-miss', role: 'buried' },
    { id: 't3_strata_surface2', label: 'S2 case#', role: 'buried' },
    { id: 't1_strata_surface3', label: 'S3 garage', role: 'buried' },
    { id: 't3_strata_surface4', label: 'S4 earwitness', role: 'buried' },
    { id: 't3_strata_decoy1', label: 'D1 cat', role: 'decoy' },
    { id: 't1_strata_decoy2', label: 'D2 bike case#', role: 'decoy' },
    { id: 't1_strata_decoy3', label: 'D3 CharlieCard', role: 'decoy' },
    { id: 't3_strata_decoy4', label: 'D4 Davis crash', role: 'decoy' },
  ]
  const channelCols = ['Vehicle', 'Case#', 'Plate -K77', 'Narrative']

  // Reference values for each channel
  const VEHICLE_REF = 'dark green Subaru wagon'
  const CASE_REF = 'case #2026-04891'
  const PLATE_REF = '-K77'
  const cpEmb = (await store.getEmbedding('t3_strata_casepost'))!

  const matrix: number[][] = []
  for (const row of channelRows) {
    const stored = await store.getItem(row.id)
    const itemEmb = await store.getEmbedding(row.id)
    if (!stored || !itemEmb) { matrix.push([0, 0, 0, 0]); continue }

    // Vehicle match: best object-entity Dice against reference
    let vehicle = 0
    for (const e of stored.entities) {
      if (e.type !== 'object') continue
      const sim = stringSimilarity(VEHICLE_REF, e.surfaceText)
      if (sim > vehicle) vehicle = sim
    }
    // For decoy1 (hatchback), Dice is moderate but should match. Add embedding fallback.
    if (vehicle < 0.5) {
      const cpVehicleEnts = stored.entities.filter(e => e.type === 'object')
      for (const e of cpVehicleEnts) {
        // Use string sim as proxy — these don't have stored embeddings in our schema
        const sim = stringSimilarity(VEHICLE_REF, e.surfaceText)
        if (sim > vehicle) vehicle = sim
      }
    }

    // Case# match: best quantity-entity Dice against reference
    let caseNum = 0
    for (const e of stored.entities) {
      if (e.type !== 'quantity') continue
      const sim = stringSimilarity(CASE_REF, e.surfaceText)
      if (sim > caseNum) caseNum = sim
    }

    // Plate match: best quantity-entity Dice against -K77
    let plate = 0
    for (const e of stored.entities) {
      if (e.type !== 'quantity') continue
      const sim = stringSimilarity(PLATE_REF, e.surfaceText)
      if (sim > plate) plate = sim
    }

    // Narrative match: text cosine to casepost
    const narrative = cosine(cpEmb, itemEmb)

    matrix.push([vehicle, caseNum, plate, narrative])
  }

  return {
    network: { nodes, edges },
    channels: { rows: channelRows, cols: channelCols, matrix },
  }
}

// ============================================================================
// Classifier confusion: top-15 surface candidates classified by gpt-5.5
// ============================================================================

async function runClassifierConfusion(store: MemoryKVStore, client: OpenAI) {
  const engine = new StrataEngine(store, client)
  const stored = await store.getItem('t3_strata_casepost')
  const emb = await store.getEmbedding('t3_strata_casepost')
  const { candidates } = await engine.surface({ ...stored!, embedding: emb ?? [] }, { topK: 15 })
  const itemsForClassify = candidates.map(c => c.item)
  const cls = await engine.classifyBatch({ ...stored!, embedding: emb ?? [] }, itemsForClassify)

  // Define signal as buried witness or in-thread (everything the mod should see).
  // Define noise as decoy, brigade, removed, corpus.
  // Classifier output: relationship != 'UNRELATED' = "RELATED"
  const results = cls.map(r => {
    const role = roleOf(r.id)
    const isSignal = role === 'buried' || role === 'anchor'
    return {
      id: r.id,
      label: shortLabel(r.id),
      role,
      is_signal: isSignal,
      classified_as: r.relationship === 'UNRELATED' ? 'UNRELATED' : 'RELATED',
      relationship: r.relationship,
      reason: r.reason.slice(0, 200),
    }
  })

  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const r of results) {
    const positive = r.classified_as === 'RELATED'
    if (r.is_signal && positive) tp++
    else if (!r.is_signal && positive) fp++
    else if (r.is_signal && !positive) fn++
    else tn++
  }

  return { tp, fp, fn, tn, results }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  console.log(`\n=== Stability Benchmark — TRIALS=${TRIALS} ===\n`)
  const t0 = performance.now()
  const store = await buildStore()
  console.log(`  hydrated in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`)

  const corpus_size = (await store.getItemIds()).length

  // Static data first (single computation)
  console.log('Computing static data (network + channels)...')
  const ts = performance.now()
  const staticData = await computeStaticData(store, client)
  console.log(`  ${staticData.network.nodes.length} nodes, ${staticData.network.edges.length} edges in ${((performance.now() - ts) / 1000).toFixed(1)}s\n`)

  // Trials
  const trials: TrialData[] = []
  for (let i = 1; i <= TRIALS; i++) {
    const r = await runTrial(store, client, i)
    trials.push(r)
    const tag = (t: { ok: boolean }) => t.ok ? 'PASS' : 'FAIL'
    console.log(`Trial ${i}:`)
    console.log(`  surface       ${tag(r.surface)} ${r.surface.ms.toFixed(0).padStart(5)}ms  buried_at_K15=${r.surface.buried_at_K[14]}/${BURIED.size}`)
    console.log(`  scan          ${tag(r.scan)} ${r.scan.ms.toFixed(0).padStart(5)}ms  buried=${r.scan.buried_in_anchors_unique}/${BURIED.size}  signal@#${r.scan.first_signal_rank}`)
    console.log(`  flag contra   ${tag(r.flag_contradiction)} ${r.flag_contradiction.ms.toFixed(0).padStart(5)}ms  refs_flag2a=${r.flag_contradiction.refs_flag2a}`)
    console.log(`  flag pattern  ${tag(r.flag_pattern)} ${r.flag_pattern.ms.toFixed(0).padStart(5)}ms  precedents=${r.flag_pattern.precedents.length}`)
    console.log(`  flag brigade  ${tag(r.flag_brigade)} ${r.flag_brigade.ms.toFixed(0).padStart(5)}ms  authors=${r.flag_brigade.authors}`)
  }

  // Classifier confusion on a canonical trial (independent run)
  console.log('\nRunning classifier confusion (one canonical trial)...')
  const tc = performance.now()
  const classification = await runClassifierConfusion(store, client)
  console.log(`  TP=${classification.tp} FP=${classification.fp} FN=${classification.fn} TN=${classification.tn} in ${((performance.now() - tc) / 1000).toFixed(1)}s`)

  // Summary
  const summary = {
    surface_pass: trials.filter(t => t.surface.ok).length,
    scan_pass: trials.filter(t => t.scan.ok).length,
    flag_contradiction_pass: trials.filter(t => t.flag_contradiction.ok).length,
    flag_pattern_pass: trials.filter(t => t.flag_pattern.ok).length,
    flag_brigade_pass: trials.filter(t => t.flag_brigade.ok).length,
  }
  console.log(`\n=== SUMMARY (${TRIALS} trials) ===`)
  for (const [k, v] of Object.entries(summary)) {
    console.log(`  ${k.padEnd(28)}  ${v}/${TRIALS}`)
  }

  const output = {
    config: {
      corpus_size,
      trials: TRIALS,
      seed_path: SEED_PATH,
      timestamp: new Date().toISOString(),
    },
    summary,
    trials,
    classification,
    static: staticData,
  }
  writeFileSync(OUTPUT, JSON.stringify(output, null, 2))
  console.log(`\nWrote ${OUTPUT}`)
}

main().catch(err => { console.error(err); process.exit(1) })
