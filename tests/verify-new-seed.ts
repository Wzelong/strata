import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore } from '../src/engine/index.js'
import { buildScanPairs } from '../src/engine/scan.js'
import { LABELED_CASES } from '../dataset/labeled-cases.js'
import { SURFACE_IDS } from '../dataset/signal-items.js'
import type { StoredItem, Entity } from '../src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, '../dataset/seed.json')
const LIVE_FILE = resolve(__dirname, '../dataset/live-items.json')

const SIGNAL_SET = new Set<string>([
  ...Array.from(SURFACE_IDS),
  't3_strata_casepost',
  ...Object.values(LABELED_CASES).flatMap(c => c.buriedWitnessIds),
])

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  console.log('=== Verify new 3K seed: surface + scan ===\n')

  const t0 = performance.now()
  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: StoredItem[]
    embeddings: Record<string, number[]>
    entityEmbeddings: Record<string, Record<string, string>>
  }
  const live = JSON.parse(readFileSync(LIVE_FILE, 'utf8')) as {
    items: Array<{ id: string; textNormalized: string; embedding: number[]; entities: Entity[] }>
  }
  console.log(`Loaded seed: ${seed.items.length} items, live: ${live.items.length} items (${((performance.now() - t0) / 1000).toFixed(1)}s)`)

  const store = new MemoryKVStore()

  for (const it of seed.items) {
    await store.setItem(it)
    const emb = seed.embeddings[it.id]
    if (emb) await store.setEmbedding(it.id, emb)
    if (it.entities.length > 0) await store.addToEntityIndex(it.entities, it.id, it.createdAt)
  }

  const entsByItem = new Map<string, Array<{ type: string; surfaceText: string; embedding: string }>>()
  for (const [type, entries] of Object.entries(seed.entityEmbeddings ?? {})) {
    for (const [key, encoded] of Object.entries(entries)) {
      const colon = key.indexOf(':')
      const itemId = key.slice(0, colon)
      const surfaceText = key.slice(colon + 1)
      if (!entsByItem.has(itemId)) entsByItem.set(itemId, [])
      entsByItem.get(itemId)!.push({ type, surfaceText, embedding: encoded })
    }
  }
  for (const [itemId, ents] of entsByItem) await store.setEntityEmbeddings(itemId, ents)

  console.log(`Hydrated store with seed + entity embeddings`)

  // Promote live items to first-class items in the store (so scan sees them)
  for (const li of live.items) {
    const stored: StoredItem = {
      id: li.id,
      type: li.id.startsWith('t1_') ? 'comment' : 'post',
      text: '',
      textNormalized: li.textNormalized,
      authorId: 'live',
      authorName: 'live',
      createdAt: Date.now(),
      threadRootId: li.id.startsWith('t1_strata_brigade') || li.id === 't1_strata_flag2b' ? 't3_strata_casepost' : li.id,
      parentId: null,
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

  // === Part 1: surface() on the live casepost ===
  console.log('\n--- surface(t3_strata_casepost) ---')
  const engine = new StrataEngine(store, client)
  const casepost = await store.getItem('t3_strata_casepost')
  if (!casepost) throw new Error('casepost not in store')
  const cpEmb = await store.getEmbedding('t3_strata_casepost')
  const t1 = performance.now()
  const surfaceRes = await engine.surface(
    { ...casepost, embedding: cpEmb ?? [] },
    { topK: 15 },
  )
  console.log(`  ${surfaceRes.candidates.length} candidates in ${((performance.now() - t1) / 1000).toFixed(2)}s`)

  const role = (id: string): string => {
    if (id === 't3_strata_casepost') return 'ANCHOR'
    const lc = LABELED_CASES['case-a-cyclist']
    if (lc?.buriedWitnessIds.includes(id)) return 'BURIED'
    if (lc?.inThreadIds.includes(id)) return 'IN_THREAD'
    if (lc?.decoyIds.includes(id)) return 'DECOY'
    if (SURFACE_IDS.has(id)) return 'SURFACE'
    return ''
  }

  const ORIGINAL_SURFACE = ['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4']
  const NEW_WITNESSES = ['t1_strata_witnessE', 't3_strata_witnessF', 't1_strata_witnessG']
  let origInTop = 0, newInTop = 0
  let buriedInTop = 0
  for (let i = 0; i < surfaceRes.candidates.length; i++) {
    const c = surfaceRes.candidates[i]
    const r = role(c.item.id)
    const tag = r ? `[${r}]` : ''
    const matches = surfaceRes.entityMatches.get(c.item.id) ?? []
    const matchStr = matches.length > 0 ? ` via {${matches.slice(0, 3).join(', ')}${matches.length > 3 ? '...' : ''}}` : ''
    console.log(`  #${i + 1}  ${c.weight.toFixed(3)}  ${tag.padEnd(11)} ${c.item.id}${matchStr}`)
    if (r === 'BURIED') buriedInTop++
  }
  console.log(`  buried witnesses in top-15: ${buriedInTop}/${LABELED_CASES['case-a-cyclist']?.buriedWitnessIds.length ?? 0}`)

  // === Part 2: buildScanPairs ===
  console.log('\n--- buildScanPairs(store) ---')
  const t2 = performance.now()
  const pairs = await buildScanPairs(store)
  console.log(`  ${pairs.length} anchor groups in ${((performance.now() - t2) / 1000).toFixed(2)}s`)

  let firstSignalRank = -1
  let buriedInScanTop10 = new Set<string>()
  for (let i = 0; i < pairs.length; i++) {
    const groupIds = [pairs[i].anchorId, ...pairs[i].connectionIds]
    const signalCount = groupIds.filter(id => SIGNAL_SET.has(id)).length
    const buriedCount = groupIds.filter(id => LABELED_CASES['case-a-cyclist']?.buriedWitnessIds.includes(id)).length
    if (firstSignalRank === -1 && buriedCount >= 2) firstSignalRank = i + 1
    if (i < 10) {
      for (const id of groupIds) if (LABELED_CASES['case-a-cyclist']?.buriedWitnessIds.includes(id)) buriedInScanTop10.add(id)
    }
    if (i < 5 || signalCount >= 2) {
      const tag = signalCount >= 2 ? ' [SIGNAL]' : ''
      console.log(`  #${i + 1}  anchor=${pairs[i].anchorId}  connections=${pairs[i].connectionIds.length}  signal=${signalCount}${tag}`)
      if (signalCount >= 2 || i < 3) {
        console.log(`         members: ${groupIds.slice(0, 8).map(id => `${id}${role(id) ? `[${role(id)}]` : ''}`).join(', ')}${groupIds.length > 8 ? '...' : ''}`)
        const allClusters = [...new Set(
          [...pairs[i].entitiesByItem.values()].flat().map(e => e.clusterId)
        )]
        console.log(`         via: ${allClusters.slice(0, 5).join(', ')}${allClusters.length > 5 ? '...' : ''}`)
      }
    }
  }

  const buriedTotal = LABELED_CASES['case-a-cyclist']?.buriedWitnessIds.length ?? 0
  console.log(`\n  first anchor group with ≥2 buried witnesses: ${firstSignalRank > 0 ? `#${firstSignalRank}` : 'NOT FOUND'}`)
  console.log(`  buried_recall@10 (scan): ${buriedInScanTop10.size}/${buriedTotal}`)

  console.log('\n=== Done ===')
}

main().catch(err => { console.error(err); process.exit(1) })
