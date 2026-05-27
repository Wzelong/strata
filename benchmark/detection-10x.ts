// Detection stability benchmark.
//
// Loads the canonical demo seed (corpus + buried witnesses + decoys + removed
// precedents), injects the planted "live" items (case-post anchor, brigade
// comments, pattern post), then runs the three detection paths N times:
//
//   surface  — engine.surface(case post): do the 4 buried witnesses surface in top-15?
//   scan     — buildScanPairs(): do the buried witnesses land in scan anchor groups?
//   flag     — engine.flag(): does the pattern post fire 'pattern', the brigade comment 'brigade'?
//
// LLM calls make surface/flag non-deterministic, so we repeat and report the
// pass rate across trials. Writes JSON + a markdown summary.
//
// Env: OPENAI_API_KEY (required), TRIALS=10, SEED_PATH, LIVE_PATH, OUT, REPORT
// Run:  npm run test:detection   (or: tsx --env-file=.env benchmark/detection-10x.ts)

import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { MemoryAlertStore } from '../src/engine/storage/memory-alert-store.js'
import { buildScanPairs, classifyAndCreateAlerts } from '../src/engine/scan.js'
import { LABELED_CASES } from '../dataset/labeled-cases.js'
import { REMOVED_ITEMS, DECOY_IDS } from '../dataset/signal-items.js'
import type { StoredItem, Item, Entity } from '../src/engine/types.js'

const SEED_PATH = resolve(process.cwd(), process.env.SEED_PATH ?? 'dataset/seed.json.gz')
const LIVE_PATH = resolve(process.cwd(), process.env.LIVE_PATH ?? 'dataset/live-items.json')
const OUT = resolve(process.cwd(), process.env.OUT ?? 'benchmark/detection-results.json')
const REPORT = resolve(process.cwd(), process.env.REPORT ?? 'benchmark/DETECTION-RESULTS.md')
const TRIALS = parseInt(process.env.TRIALS ?? '10', 10)

const CASE = LABELED_CASES['case-a-cyclist']
const BURIED = CASE.buriedWitnessIds
const BURIED_SET = new Set(BURIED)
const DECOY_SET = new Set(DECOY_IDS)
const PATTERN_PROBE = 't3_strata_flag4'
const BRIGADE_PROBE = 't1_strata_brigade2'

// Mirror the server's helpers so alert creation runs exactly as in production.
let alertSeq = 0
const genAlertId = () => `alert_${Date.now().toString(36)}_${alertSeq++}`
const buildPermalink = (item: Item, sub: string) =>
  item.type === 'comment' ? `/r/${sub}/comments/${item.threadRootId}/_/${item.id}` : `/r/${sub}/comments/${item.id}`

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const WITNESS_LABEL: Record<string, string> = {
  t1_strata_surface1: 'S1 vehicle paraphrase',
  t3_strata_surface2: 'S2 exact case#',
  t1_strata_surface3: 'S3 plate -K77',
  t3_strata_surface4: 'S4 narrative only',
}

function readSeed(path: string) {
  const buf = readFileSync(path)
  const json = path.endsWith('.gz') ? gunzipSync(buf).toString() : buf.toString()
  return JSON.parse(json) as {
    items: StoredItem[]
    embeddings: Record<string, number[]>
    entityEmbeddings?: Record<string, Record<string, string>>
  }
}

async function buildStore(): Promise<MemoryKVStore> {
  const seed = readSeed(SEED_PATH)
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

  // Inject planted "live" items: brigade comments live in the case-post thread.
  for (const li of live.items) {
    const isInThread = li.id.startsWith('t1_strata_brigade')
    const stored: StoredItem = {
      id: li.id,
      type: li.id.startsWith('t1_') ? 'comment' : 'post',
      text: li.textNormalized,
      textNormalized: li.textNormalized,
      authorId: li.id.startsWith('t1_strata_brigade') ? `t2_brigade_${li.id.slice(-1)}`
        : li.id === 't3_strata_casepost' ? 't2_sarahsroommate'
        : li.id === 't3_strata_flag4' ? 't2_massavesafety' : 'live',
      authorName: li.id === 't3_strata_flag4' ? 'MassAveSafety'
        : li.id === 't3_strata_casepost' ? 'SarahsRoommate2026' : li.id,
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

  // Mark the FLAG-3 precedents as removed so the pattern probe has prior decisions to match.
  for (const [id, meta] of Object.entries(REMOVED_ITEMS)) {
    const it = await store.getItem(id)
    if (!it) continue
    await store.setItem({ ...it, decision: meta.decision, decisionAt: it.createdAt + 3600000, decisionBy: meta.decisionBy, decisionReason: meta.decisionReason })
    await store.moveDecision(id, 'pending', 'removed', it.createdAt + 3600000)
  }

  return store
}

interface WitnessOutcome { retrieved: boolean; related: boolean; relationship: string }
interface Trial {
  trial: number
  surface: { ok: boolean; ms: number; retrievedTop15: number; relatedTop15: number; witnesses: Record<string, WitnessOutcome>; decoysRetrieved: number; decoysFalsePos: number }
  scan: { ok: boolean; ms: number; pairs: number; alertsCreated: number; buriedInAlerts: number; decoyInAlerts: number; topAnchor: string; topAnchorBuried: number }
  flagPattern: { ok: boolean; ms: number; precedents: number }
  flagBrigade: { ok: boolean; ms: number; authors: number }
}

async function runTrial(store: MemoryKVStore, client: OpenAI, trial: number): Promise<Trial> {
  const engine = new StrataEngine(store, client)

  // --- surface: retrieve top-15, then classify; do buried witnesses survive as RELATED? ---
  const sT = performance.now()
  const anchor = await store.getItem(CASE.anchorId)
  const anchorEmb = await store.getEmbedding(CASE.anchorId)
  const anchorItem = { ...anchor!, embedding: anchorEmb ?? [] }
  const { candidates } = await engine.surface(anchorItem, { topK: 15 })
  const retrievedItems = candidates.map(c => c.item)
  const retrievedIds = new Set(retrievedItems.map(i => i.id))
  const cls = await engine.classifyBatch(anchorItem, retrievedItems)
  const relById = new Map(cls.map(r => [r.id, r.relationship]))
  const witnesses: Record<string, WitnessOutcome> = {}
  for (const id of BURIED) {
    const retrieved = retrievedIds.has(id)
    const relationship = retrieved ? (relById.get(id) ?? 'UNCLASSIFIED') : 'NOT_RETRIEVED'
    witnesses[id] = { retrieved, related: retrieved && relationship !== 'UNRELATED', relationship }
  }
  const retrievedTop15 = Object.values(witnesses).filter(w => w.retrieved).length
  const relatedTop15 = Object.values(witnesses).filter(w => w.related).length
  // Precision side: decoys share one detail but are NOT the same incident — they should stay UNRELATED.
  const decoyIds = [...DECOY_IDS]
  const decoysRetrieved = decoyIds.filter(id => retrievedIds.has(id)).length
  const decoysFalsePos = decoyIds.filter(id => retrievedIds.has(id) && (relById.get(id) ?? 'UNRELATED') !== 'UNRELATED').length
  const surface = { ok: relatedTop15 >= 3, ms: performance.now() - sT, retrievedTop15, relatedTop15, witnesses, decoysRetrieved, decoysFalsePos }

  // --- scan: end-to-end. build pairs, then classify + create real alert records,
  // and assert on the alerts a moderator would actually see. ---
  const scT = performance.now()
  const pairs = await buildScanPairs(store)
  const alertStore = new MemoryAlertStore()
  await mapPool(pairs, 8, pair => classifyAndCreateAlerts(
    [pair],
    id => engine.getItem(id),
    (a, cs) => engine.classifyBatch(a, cs),
    alertStore,
    'strata_test',
    buildPermalink,
    genAlertId,
  ))
  const { alerts } = await alertStore.listAlerts({ limit: 1000 })
  const buriedSeen = new Set<string>()
  let decoyInAlerts = 0
  let topAnchor = ''
  let topAnchorBuried = 0
  for (const al of alerts) {
    const conns = await alertStore.getAlertConnections(al.id)
    let b = 0
    for (const cn of conns) {
      if (BURIED_SET.has(cn.itemId)) { buriedSeen.add(cn.itemId); b++ }
      if (DECOY_SET.has(cn.itemId)) decoyInAlerts++
    }
    // A buried witness that became its own anchor still surfaces to the mod.
    if (BURIED_SET.has(al.anchorId)) buriedSeen.add(al.anchorId)
    if (b > topAnchorBuried) { topAnchorBuried = b; topAnchor = al.anchorId }
    if (process.env.DEBUG) {
      const tagIds = (ids: string[]) => ids.filter(id => BURIED_SET.has(id) || DECOY_SET.has(id) || id.includes('strata_'))
      const connIds = conns.map(cn => cn.itemId)
      const tagged = tagIds([al.anchorId, ...connIds])
      if (tagged.length) console.log(`  alert anchor=${al.anchorId}${BURIED_SET.has(al.anchorId) ? ' [BURIED]' : ''}  buriedConns=${connIds.filter(id => BURIED_SET.has(id)).join(',') || '-'}  decoyConns=${connIds.filter(id => DECOY_SET.has(id)).join(',') || '-'}`)
    }
  }
  const scan = {
    ok: buriedSeen.size >= 3 && decoyInAlerts === 0,
    ms: performance.now() - scT,
    pairs: pairs.length,
    alertsCreated: alerts.length,
    buriedInAlerts: buriedSeen.size,
    decoyInAlerts,
    topAnchor,
    topAnchorBuried,
  }

  // --- flag: pattern on the FLAG-4 post ---
  const pT = performance.now()
  const pItem = await store.getItem(PATTERN_PROBE)
  const pEmb = await store.getEmbedding(PATTERN_PROBE)
  const pFlags = await engine.flag({ ...pItem!, embedding: pEmb ?? [] })
  const pattern = pFlags.find(f => f.type === 'pattern')
  const flagPattern = { ok: !!pattern, ms: performance.now() - pT, precedents: pattern?.connectionItems.length ?? 0 }

  // --- flag: brigade on a brigade comment ---
  const bT = performance.now()
  const bItem = await store.getItem(BRIGADE_PROBE)
  const bEmb = await store.getEmbedding(BRIGADE_PROBE)
  const bFlags = await engine.flag({ ...bItem!, embedding: bEmb ?? [] })
  const brigade = bFlags.find(f => f.type === 'brigade')
  const authors = brigade ? new Set(brigade.connectionItems.map(c => c.authorId)).size + 1 : 0
  const flagBrigade = { ok: !!brigade, ms: performance.now() - bT, authors }

  return { trial, surface, scan, flagPattern, flagBrigade }
}

function pct(n: number, d: number): string {
  return `${((n / d) * 100).toFixed(0)}%`
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function buildReport(trials: Trial[], corpusSize: number): string {
  const n = trials.length
  const sp = trials.filter(t => t.surface.ok).length
  const scp = trials.filter(t => t.scan.ok).length
  const pp = trials.filter(t => t.flagPattern.ok).length
  const bp = trials.filter(t => t.flagBrigade.ok).length
  const L = [
    '# Strata Detection Benchmark',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Corpus: ${corpusSize} items (\`${SEED_PATH.split('/').slice(-2).join('/')}\` + planted live items)`,
    `- Trials: ${n}`,
    `- Probes: anchor \`${CASE.anchorId}\`, pattern \`${PATTERN_PROBE}\`, brigade \`${BRIGADE_PROBE}\``,
    '',
    '## Summary',
    '',
    '| Check | Pass | Rate | Criterion |',
    '| --- | --- | --- | --- |',
    `| Surface (recall) | ${sp}/${n} | ${pct(sp, n)} | ≥3 of 4 buried witnesses retrieved AND classified RELATED |`,
    `| Surface (precision) | ${trials.filter(t => t.surface.decoysFalsePos === 0).length}/${n} | — | 0 decoys mis-classified RELATED (total decoy FPs: ${trials.reduce((a, t) => a + t.surface.decoysFalsePos, 0)}) |`,
    `| Scan (E2E alerts) | ${scp}/${n} | ${pct(scp, n)} | ≥3 buried witnesses land in created alert connections AND 0 decoy connections |`,
    `| Flag · pattern | ${pp}/${n} | ${pct(pp, n)} | 'pattern' flag fires on FLAG-4 post |`,
    `| Flag · brigade | ${bp}/${n} | ${pct(bp, n)} | 'brigade' flag fires on a brigade comment |`,
    '',
    '## Surface witness survival (per channel)',
    '',
    'Each buried witness links to the case post through a different channel. "Retrieved" = reached top-15 candidates; "Related" = also survived the classifier (not marked UNRELATED).',
    '',
    '| Witness | Channel | Retrieved | Classified RELATED |',
    '| --- | --- | --- | --- |',
    ...BURIED.map(id => {
      const retrieved = trials.filter(t => t.surface.witnesses[id]?.retrieved).length
      const related = trials.filter(t => t.surface.witnesses[id]?.related).length
      const label = (WITNESS_LABEL[id] ?? id).split(' ').slice(1).join(' ')
      const tag = (WITNESS_LABEL[id] ?? id).split(' ')[0]
      return `| ${tag} | ${label} | ${retrieved}/${n} | ${related}/${n} |`
    }),
    '',
    '## Latency (mean)',
    '',
    '| Check | Mean ms |',
    '| --- | --- |',
    `| Surface | ${mean(trials.map(t => t.surface.ms)).toFixed(0)} |`,
    `| Scan (E2E build+classify+create) | ${mean(trials.map(t => t.scan.ms)).toFixed(0)} |`,
    `| Flag · pattern | ${mean(trials.map(t => t.flagPattern.ms)).toFixed(0)} |`,
    `| Flag · brigade | ${mean(trials.map(t => t.flagBrigade.ms)).toFixed(0)} |`,
    '',
    '## Per-trial',
    '',
    '| # | Surface (related/4) | Scan (alerts, buried/4, decoyFP) | Pattern (precedents) | Brigade (authors) |',
    '| --- | --- | --- | --- | --- |',
    ...trials.map(t =>
      `| ${t.trial} | ${t.surface.ok ? 'PASS' : 'FAIL'} (${t.surface.relatedTop15}/4) `
      + `| ${t.scan.ok ? 'PASS' : 'FAIL'} (${t.scan.alertsCreated}, ${t.scan.buriedInAlerts}/4, ${t.scan.decoyInAlerts}) `
      + `| ${t.flagPattern.ok ? 'PASS' : 'FAIL'} (${t.flagPattern.precedents}) `
      + `| ${t.flagBrigade.ok ? 'PASS' : 'FAIL'} (${t.flagBrigade.authors}) |`,
    ),
    '',
    '> Surface/scan/flag use real OpenAI calls; surface S4 is narrative-cosine only and is the',
    '> hardest channel, so occasional surface misses at top-15 are expected and reported, not hidden.',
    '',
  ]
  return L.join('\n')
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY (e.g. add it to .env and use `npm run test:detection`).')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  console.log(`\n=== Strata Detection Benchmark — TRIALS=${TRIALS} ===\n`)
  const t0 = performance.now()
  const store = await buildStore()
  const corpusSize = (await store.getItemIds()).length
  console.log(`Hydrated ${corpusSize} items in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`)

  const trials: Trial[] = []
  for (let i = 1; i <= TRIALS; i++) {
    const r = await runTrial(store, client, i)
    trials.push(r)
    const tag = (ok: boolean) => (ok ? 'PASS' : 'FAIL')
    console.log(
      `Trial ${String(i).padStart(2)}  `
      + `surface ${tag(r.surface.ok)} (related ${r.surface.relatedTop15}/4, decoyFP ${r.surface.decoysFalsePos}/${r.surface.decoysRetrieved}, ${r.surface.ms.toFixed(0)}ms)  `
      + `scan ${tag(r.scan.ok)} (${r.scan.alertsCreated} alerts, buried ${r.scan.buriedInAlerts}/4, decoyFP ${r.scan.decoyInAlerts}, ${r.scan.ms.toFixed(0)}ms)  `
      + `pattern ${tag(r.flagPattern.ok)} (${r.flagPattern.precedents}, ${r.flagPattern.ms.toFixed(0)}ms)  `
      + `brigade ${tag(r.flagBrigade.ok)} (${r.flagBrigade.authors}, ${r.flagBrigade.ms.toFixed(0)}ms)`,
    )
  }

  const summary = {
    surface: trials.filter(t => t.surface.ok).length,
    scan: trials.filter(t => t.scan.ok).length,
    flagPattern: trials.filter(t => t.flagPattern.ok).length,
    flagBrigade: trials.filter(t => t.flagBrigade.ok).length,
  }
  console.log(`\n=== SUMMARY (${TRIALS} trials) ===`)
  console.log(`  surface        ${summary.surface}/${TRIALS}`)
  console.log(`  scan           ${summary.scan}/${TRIALS}`)
  console.log(`  flag pattern   ${summary.flagPattern}/${TRIALS}`)
  console.log(`  flag brigade   ${summary.flagBrigade}/${TRIALS}`)

  writeFileSync(OUT, JSON.stringify({ config: { corpusSize, trials: TRIALS, timestamp: new Date().toISOString() }, summary, trials }, null, 2))
  writeFileSync(REPORT, buildReport(trials, corpusSize))
  console.log(`\nWrote ${OUT}\nWrote ${REPORT}`)
}

main().catch(err => { console.error(err); process.exit(1) })
