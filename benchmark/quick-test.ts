// Quick test: one surface() call + one scan cycle with live items.
// Run: tsx --env-file=.env benchmark/quick-test.ts

import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { MemoryAlertStore } from '../src/engine/storage/memory-alert-store.js'
import { buildScanPairs, classifyAndCreateAlerts } from '../src/engine/scan.js'
import type { StoredItem, Item, Entity } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')

const SEED_PATH = resolve(process.cwd(), 'dataset/seed.json.gz')

const LIVE_ITEMS_RAW = JSON.parse(readFileSync(resolve(process.cwd(), 'src/server/demo-signals.json'), 'utf-8')) as Array<{
  id: string; type: 'post' | 'comment'; title: string; text: string
  authorId: string; authorName: string; threadRootId: string; parentId: string | null
  entities: Entity[]; embedding: number[]
}>

const WITNESS_IDS = ['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4']
const CASE_POST_ID = 't3_strata_casepost'

type SeedData = {
  items: StoredItem[]
  embeddings: Record<string, number[]>
  entityEmbeddings: Record<string, Record<string, string>>
}

function loadSeed(): SeedData {
  const raw = gunzipSync(readFileSync(SEED_PATH))
  return JSON.parse(raw.toString('utf-8'))
}

async function hydrateStore(seed: SeedData): Promise<MemoryKVStore> {
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

  // Inject live items
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
  return store
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  console.log('Loading seed + live items...')
  const seed = loadSeed()
  const store = await hydrateStore(seed)
  const engine = new StrataEngine(store, client)
  console.log(`  ${seed.items.length + LIVE_ITEMS_RAW.length} items total\n`)

  // --- SURFACE ---
  console.log('=' .repeat(50))
  console.log('  SURFACE: case post → find witnesses')
  console.log('=' .repeat(50))

  const caseStored = await store.getItem(CASE_POST_ID)
  const caseEmb = await store.getEmbedding(CASE_POST_ID)
  if (!caseStored || !caseEmb) { console.error('Case post not found!'); return }
  const caseItem: Item = { ...caseStored, embedding: caseEmb }

  const t0 = performance.now()
  const { candidates, entityMatches } = await engine.surface(caseItem)
  console.log(`\n  Surface returned ${candidates.length} candidates (${Math.round(performance.now() - t0)}ms)`)
  console.log(`  Entity matches: ${entityMatches.size} items\n`)

  const classifications = await engine.classifyBatch(caseItem, candidates.map(c => ({ id: c.item.id, text: c.item.text })))

  console.log('  Results:')
  const found: string[] = []
  for (const cls of classifications) {
    const isWitness = WITNESS_IDS.includes(cls.id)
    const tag = isWitness ? ' ★ WITNESS' : ''
    const mark = cls.relationship === 'UNRELATED' ? '  ' : '→ '
    console.log(`  ${mark}${cls.id.padEnd(25)} ${cls.relationship.padEnd(12)} ${cls.confidence ?? '-'}\t${cls.reason.slice(0, 80)}${tag}`)
    if (isWitness && cls.relationship !== 'UNRELATED') found.push(cls.id)
  }

  console.log(`\n  Witnesses found: ${found.length}/4 — ${found.join(', ') || 'none'}`)
  const missed = WITNESS_IDS.filter(id => !found.includes(id))
  if (missed.length > 0) console.log(`  Missed: ${missed.join(', ')}`)

  // --- SCAN ---
  console.log('\n' + '=' .repeat(50))
  console.log('  SCAN: entity-based anchor discovery')
  console.log('=' .repeat(50))

  const alertStore = new MemoryAlertStore()
  const allItems = await Promise.all((await store.getItemIds()).map(id => store.getItem(id)))
  const itemsMap = new Map(allItems.filter((x): x is StoredItem => !!x).map(it => [it.id, { threadRootId: it.threadRootId, entities: it.entities }]))

  const t1 = performance.now()
  const pairs = await buildScanPairs(store, itemsMap)
  console.log(`\n  ${pairs.length} scan pairs found (${Math.round(performance.now() - t1)}ms)`)

  const plantedAnchors = pairs.filter(p => p.anchorId.includes('strata'))
  if (plantedAnchors.length > 0) {
    console.log(`  Planted anchors: ${plantedAnchors.map(p => `${p.anchorId}(${p.connectionIds.length})`).join(', ')}`)
  }

  const alertIds = await classifyAndCreateAlerts(
    pairs,
    async (id) => {
      const s = await store.getItem(id)
      if (!s) return null
      const e = await store.getEmbedding(id)
      return { ...s, embedding: e ?? [] }
    },
    (anchor, cands) => engine.classifyBatch(anchor, cands.map(c => ({ id: c.id, text: c.text }))),
    alertStore,
    'test_sub',
    (item, sub) => `/r/${sub}/comments/${item.id}`,
    () => `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  )

  console.log(`  ${alertIds.length} alerts created`)

  let scanWitnesses: string[] = []
  for (const alertId of alertIds) {
    const alert = await alertStore.getAlert(alertId)
    const conns = await alertStore.getAlertConnections(alertId)
    const witnessConns = conns.filter(c => WITNESS_IDS.includes(c.itemId))
    if (witnessConns.length > 0 || (alert && WITNESS_IDS.includes(alert.anchorId))) {
      const ids = [...witnessConns.map(c => c.itemId)]
      if (alert && WITNESS_IDS.includes(alert.anchorId)) ids.push(alert.anchorId)
      scanWitnesses.push(...ids)
      console.log(`  Alert ${alertId}: anchor=${alert?.anchorId}, witness connections: ${ids.join(', ')}`)
    }
  }
  scanWitnesses = [...new Set(scanWitnesses)]
  console.log(`\n  Scan witnesses: ${scanWitnesses.length}/4 — ${scanWitnesses.join(', ') || 'none'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
