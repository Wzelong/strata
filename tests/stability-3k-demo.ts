// Stability test on the 3K demo seed. Runs each pipeline 10 times and reports
// pass-rate + per-trial details. The hydration cost is amortized — store is
// built once, then each pipeline is re-invoked.
//
// Pass criteria:
//   surface() on casepost:       buried_recall@15 == 4/4
//   scan() on full store:        buried_recall@10 >= 3/4
//   flag() on flag4:             type 'pattern' fires (matches FLAG-3 removed)
//   flag() on brigade2:          type 'brigade' fires

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { buildScanPairs } from '../src/engine/scan.js'
import { LABELED_CASES } from '../dataset/labeled-cases.js'
import { REMOVED_ITEMS } from '../dataset/signal-items.js'
import type { StoredItem, Entity } from '../src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED = resolve(__dirname, '../dataset/seed.json')
const LIVE = resolve(__dirname, '../dataset/live-items.json')

const TRIALS = 10
const CASE = LABELED_CASES['case-a-cyclist']
const BURIED = new Set(CASE.buriedWitnessIds)

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

type Trial<T> = { ok: boolean; ms: number; details: T }

async function buildStore(): Promise<MemoryKVStore> {
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as {
    items: StoredItem[]
    embeddings: Record<string, number[]>
    entityEmbeddings: Record<string, Record<string, string>>
  }
  const live = JSON.parse(readFileSync(LIVE, 'utf8')) as {
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
    const isInThread = li.id.startsWith('t1_strata_brigade')
    const stored: StoredItem = {
      id: li.id,
      type: li.id.startsWith('t1_') ? 'comment' : 'post',
      text: li.textNormalized,
      textNormalized: li.textNormalized,
      authorId: li.id.startsWith('t1_strata_brigade') ? `t2_${li.id.replace('t1_strata_', '')}` :
                li.id === 't3_strata_casepost' ? 't2_sarahsroommate' :
                li.id === 't3_strata_flag4' ? 't2_massavesafety' : 'live',
      authorName: li.id === 't3_strata_flag4' ? 'MassAveSafety' :
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

  return store
}

async function runTrial(store: MemoryKVStore, client: OpenAI): Promise<{
  surface: Trial<{ buriedFound: string[]; total: number }>
  scan: Trial<{ buriedFound: string[]; signalRank: number; total: number }>
  flagPattern: Trial<{ patternFired: boolean; precedentCount: number }>
  flagBrigade: Trial<{ brigadeFired: boolean; authors: number }>
}> {
  const engine = new StrataEngine(store, client)

  // 1) surface(casepost)
  let surface: Trial<{ buriedFound: string[]; total: number }>
  {
    const t0 = performance.now()
    const stored = await store.getItem('t3_strata_casepost')
    const emb = await store.getEmbedding('t3_strata_casepost')
    const { candidates } = await engine.surface({ ...stored!, embedding: emb ?? [] }, { topK: 15 })
    const buriedFound = candidates.map(c => c.item.id).filter(id => BURIED.has(id))
    surface = {
      ok: buriedFound.length === CASE.buriedWitnessIds.length,
      ms: performance.now() - t0,
      details: { buriedFound, total: CASE.buriedWitnessIds.length },
    }
  }

  // 2) scan()
  let scan: Trial<{ buriedFound: string[]; signalRank: number; total: number }>
  {
    const t0 = performance.now()
    const pairs = await buildScanPairs(store)
    const buriedSet = new Set<string>()
    let signalRank = -1
    for (let i = 0; i < Math.min(10, pairs.length); i++) {
      const all = [pairs[i].anchorId, ...pairs[i].connectionIds]
      const found = all.filter(id => BURIED.has(id))
      for (const id of found) buriedSet.add(id)
      if (signalRank === -1 && found.length >= 2) signalRank = i + 1
    }
    scan = {
      ok: buriedSet.size >= 3,
      ms: performance.now() - t0,
      details: { buriedFound: [...buriedSet], signalRank, total: CASE.buriedWitnessIds.length },
    }
  }

  // 3) flag(flag4) — expect pattern match against FLAG-3 removed items
  let flagPattern: Trial<{ patternFired: boolean; precedentCount: number }>
  {
    const t0 = performance.now()
    const stored = await store.getItem('t3_strata_flag4')
    const emb = await store.getEmbedding('t3_strata_flag4')
    const flags = await engine.flag({ ...stored!, embedding: emb ?? [] })
    const pattern = flags.find(f => f.type === 'pattern')
    flagPattern = {
      ok: !!pattern,
      ms: performance.now() - t0,
      details: { patternFired: !!pattern, precedentCount: pattern?.connectionItems.length ?? 0 },
    }
  }

  // 4) flag(brigade2) — expect brigade detection
  let flagBrigade: Trial<{ brigadeFired: boolean; authors: number }>
  {
    const t0 = performance.now()
    const stored = await store.getItem('t1_strata_brigade2')
    const emb = await store.getEmbedding('t1_strata_brigade2')
    const flags = await engine.flag({ ...stored!, embedding: emb ?? [] })
    const brigade = flags.find(f => f.type === 'brigade')
    const authors = brigade ? new Set(brigade.connectionItems.map(c => c.authorId)).size + 1 : 0
    flagBrigade = {
      ok: !!brigade,
      ms: performance.now() - t0,
      details: { brigadeFired: !!brigade, authors },
    }
  }

  return { surface, scan, flagPattern, flagBrigade }
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  console.log(`Building shared store (one time)...`)
  const t0 = performance.now()
  const store = await buildStore()
  console.log(`  hydrated in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`)

  const summary = {
    surface: { pass: 0, totalMs: 0 },
    scan: { pass: 0, totalMs: 0 },
    flagPattern: { pass: 0, totalMs: 0 },
    flagBrigade: { pass: 0, totalMs: 0 },
  }

  for (let i = 1; i <= TRIALS; i++) {
    const r = await runTrial(store, client)
    const tag = (t: { ok: boolean }) => t.ok ? 'PASS' : 'FAIL'
    console.log(`Trial ${i}:`)
    console.log(`  surface         ${tag(r.surface)}  ${r.surface.ms.toFixed(0).padStart(5)}ms  buried=${r.surface.details.buriedFound.length}/${r.surface.details.total}`)
    console.log(`  scan            ${tag(r.scan)}  ${r.scan.ms.toFixed(0).padStart(5)}ms  buried=${r.scan.details.buriedFound.length}/${r.scan.details.total}  signal@#${r.scan.details.signalRank}`)
    console.log(`  flag pattern    ${tag(r.flagPattern)}  ${r.flagPattern.ms.toFixed(0).padStart(5)}ms  precedents=${r.flagPattern.details.precedentCount}`)
    console.log(`  flag brigade    ${tag(r.flagBrigade)}  ${r.flagBrigade.ms.toFixed(0).padStart(5)}ms  authors=${r.flagBrigade.details.authors}`)

    if (r.surface.ok) summary.surface.pass++
    if (r.scan.ok) summary.scan.pass++
    if (r.flagPattern.ok) summary.flagPattern.pass++
    if (r.flagBrigade.ok) summary.flagBrigade.pass++
    summary.surface.totalMs += r.surface.ms
    summary.scan.totalMs += r.scan.ms
    summary.flagPattern.totalMs += r.flagPattern.ms
    summary.flagBrigade.totalMs += r.flagBrigade.ms
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(` STABILITY SUMMARY (${TRIALS} trials)`)
  console.log('='.repeat(60))
  const row = (name: string, s: { pass: number; totalMs: number }) =>
    console.log(`  ${name.padEnd(20)}  ${s.pass}/${TRIALS}  avg ${(s.totalMs / TRIALS).toFixed(0)}ms`)
  row('surface', summary.surface)
  row('scan', summary.scan)
  row('flag pattern', summary.flagPattern)
  row('flag brigade', summary.flagBrigade)

  const allPassRate =
    summary.surface.pass + summary.scan.pass + summary.flagPattern.pass + summary.flagBrigade.pass
  const allTrials = TRIALS * 4
  console.log(`\n  Total ${allPassRate}/${allTrials} (${((allPassRate / allTrials) * 100).toFixed(0)}%)`)
  if (allPassRate < allTrials) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
