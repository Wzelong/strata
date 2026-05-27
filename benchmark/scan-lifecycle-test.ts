// Scan lifecycle test: runs 5 full scans (buildScanPairs + classifyAndCreateAlerts)
// on two configurations:
//   A) Seed-only (5,388 items — the backfill corpus without the case post)
//   B) Seed + live planted items (case post + brigade comments injected)
//
// Reports which anchors surface, how many alerts are created, and whether
// the planted witness items appear in connections.
//
// Run: tsx --env-file=.env benchmark/scan-lifecycle-test.ts

import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { MemoryAlertStore } from '../src/engine/storage/memory-alert-store.js'
import { buildScanPairs, classifyAndCreateAlerts } from '../src/engine/scan.js'
import type { StoredItem, Item, Entity, Alert, AlertConnection } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const SEED_PATH = resolve(process.cwd(), 'dataset/seed.json.gz')
const TRIALS = 5

const WITNESS_IDS = new Set([
  't1_strata_surface1',
  't3_strata_surface2',
  't1_strata_surface3',
  't3_strata_surface4',
])

const LIVE_ITEMS_RAW = JSON.parse(readFileSync(resolve(process.cwd(), 'src/server/demo-signals.json'), 'utf-8')) as Array<{
  id: string; type: 'post' | 'comment'; title: string; text: string
  authorId: string; authorName: string; threadRootId: string; parentId: string | null
  entities: Entity[]; embedding: number[]
}>

type SeedData = {
  items: StoredItem[]
  embeddings: Record<string, number[]>
  entityEmbeddings: Record<string, Record<string, string>>
}

function loadSeed(): SeedData {
  const raw = gunzipSync(readFileSync(SEED_PATH))
  return JSON.parse(raw.toString('utf-8'))
}

async function hydrateStore(seed: SeedData, includeLive: boolean): Promise<MemoryKVStore> {
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

  if (includeLive) {
    const now = Date.now()
    for (const s of LIVE_ITEMS_RAW) {
      const stored: StoredItem = {
        id: s.id, type: s.type, title: s.title, text: s.text, textNormalized: s.text,
        authorId: s.authorId, authorName: s.authorName, createdAt: now,
        threadRootId: s.threadRootId, parentId: s.parentId, entities: s.entities,
        decision: 'pending', decisionAt: null, decisionBy: null, decisionReason: null,
      }
      await store.setItem(stored)
      await store.setEmbedding(s.id, s.embedding)
      if (s.entities.length > 0) await store.addToEntityIndex(s.entities, s.id, now)
    }
  }

  return store
}

type TrialResult = {
  pairsCount: number
  anchors: Array<{ id: string; connectionCount: number; isPlanted: boolean }>
  alertsCreated: number
  witnessesFound: string[]
  elapsedMs: number
}

async function runTrial(seed: SeedData, includeLive: boolean, client: OpenAI, trial: number): Promise<TrialResult> {
  const t0 = performance.now()
  const store = await hydrateStore(seed, includeLive)
  const alertStore = new MemoryAlertStore()
  const engine = new StrataEngine(store, client)

  const allItems = await Promise.all((await store.getItemIds()).map(id => store.getItem(id)))
  const itemsMap = new Map(allItems.filter((x): x is StoredItem => !!x).map(it => [it.id, { threadRootId: it.threadRootId, entities: it.entities }]))

  const pairs = await buildScanPairs(store, itemsMap)

  const anchors = pairs.map(p => ({
    id: p.anchorId,
    connectionCount: p.connectionIds.length,
    isPlanted: p.anchorId.includes('strata'),
  }))

  const alertIds = await classifyAndCreateAlerts(
    pairs,
    async (id) => {
      const stored = await store.getItem(id)
      if (!stored) return null
      const emb = await store.getEmbedding(id)
      return { ...stored, embedding: emb ?? [] }
    },
    (anchor, candidates) => engine.classifyBatch(anchor, candidates.map(c => ({ id: c.id, text: c.text }))),
    alertStore,
    'test_sub',
    (item, sub) => `/r/${sub}/comments/${item.id}`,
    () => `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  )

  const witnessesFound: string[] = []
  for (const alertId of alertIds) {
    const conns = await alertStore.getAlertConnections(alertId)
    for (const c of conns) {
      if (WITNESS_IDS.has(c.itemId)) witnessesFound.push(c.itemId)
    }
    const alert = await alertStore.getAlert(alertId)
    if (alert && WITNESS_IDS.has(alert.anchorId)) witnessesFound.push(alert.anchorId)
  }

  return {
    pairsCount: pairs.length,
    anchors,
    alertsCreated: alertIds.length,
    witnessesFound: [...new Set(witnessesFound)],
    elapsedMs: Math.round(performance.now() - t0),
  }
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  console.log('Loading seed...')
  const seed = loadSeed()
  console.log(`  ${seed.items.length} items\n`)

  for (const mode of ['seed-only', 'seed+live'] as const) {
    const includeLive = mode === 'seed+live'
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  MODE: ${mode} (${includeLive ? seed.items.length + LIVE_ITEMS_RAW.length : seed.items.length} items)`)
    console.log(`${'='.repeat(60)}\n`)

    const results: TrialResult[] = []
    for (let i = 0; i < TRIALS; i++) {
      console.log(`  Trial ${i + 1}/${TRIALS}...`)
      const r = await runTrial(seed, includeLive, client, i)
      results.push(r)
      console.log(`    ${r.pairsCount} pairs → ${r.alertsCreated} alerts (${r.elapsedMs}ms)`)
      console.log(`    Anchors: ${r.anchors.map(a => `${a.id.replace('t3_', '').replace('t1_', '').slice(0, 20)}(${a.connectionCount})`).join(', ')}`)
      if (r.witnessesFound.length > 0) {
        console.log(`    ✓ Witnesses found: ${r.witnessesFound.join(', ')}`)
      }
    }

    console.log(`\n  --- Summary (${mode}) ---`)
    console.log(`  Avg pairs:  ${(results.reduce((s, r) => s + r.pairsCount, 0) / TRIALS).toFixed(1)}`)
    console.log(`  Avg alerts: ${(results.reduce((s, r) => s + r.alertsCreated, 0) / TRIALS).toFixed(1)}`)
    const witnessRate = results.filter(r => r.witnessesFound.length > 0).length
    console.log(`  Trials with witnesses: ${witnessRate}/${TRIALS}`)
    const allWitnesses = new Set(results.flatMap(r => r.witnessesFound))
    console.log(`  Unique witnesses ever found: ${[...allWitnesses].join(', ') || 'none'}`)

    const anchorFreq = new Map<string, number>()
    for (const r of results) for (const a of r.anchors) anchorFreq.set(a.id, (anchorFreq.get(a.id) ?? 0) + 1)
    const sorted = [...anchorFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log(`  Top anchors (across ${TRIALS} trials):`)
    for (const [id, count] of sorted) {
      const planted = id.includes('strata') ? ' [PLANTED]' : ''
      console.log(`    ${count}/${TRIALS}: ${id}${planted}`)
    }
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
