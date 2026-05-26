import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { buildScanPairs } from '../src/engine/scan.js'
import type { StoredItem } from '../src/engine/types.js'

const seed = JSON.parse(gunzipSync(readFileSync('dataset/seed.json.gz')).toString()) as {
  items: StoredItem[]
  embeddings: Record<string, number[]>
  entityEmbeddings?: Record<string, Record<string, string>>
}

console.log(`Loaded seed: ${seed.items.length} items`)

const store = new MemoryKVStore()

async function main() {
  // Load all items into memory store
  for (const item of seed.items) {
    await store.setItem(item)
    if (item.entities?.length) await store.addToEntityIndex(item.entities, item.id, item.createdAt)
  }

  // Load embeddings
  for (const [id, emb] of Object.entries(seed.embeddings)) {
    await store.setEmbedding(id, emb)
  }

  // Load entity embeddings
  if (seed.entityEmbeddings) {
    for (const [type, entries] of Object.entries(seed.entityEmbeddings)) {
      for (const [field, emb] of Object.entries(entries)) {
        const colonIdx = field.indexOf(':')
        const itemId = field.slice(0, colonIdx)
        const surfaceText = field.slice(colonIdx + 1)
        await store.setEntityEmbeddings(itemId, [{ type, surfaceText, embedding: emb }])
      }
    }
  }

  console.log(`Store loaded: ${await store.getItemCount()} items`)

  // Build items map (like server cache)
  const allItemsMap = new Map<string, { threadRootId: string; entities: { type: string; surfaceText: string }[] }>()
  for (const item of seed.items) {
    allItemsMap.set(item.id, { threadRootId: item.threadRootId, entities: item.entities })
  }

  // Run scan
  console.log('\nRunning buildScanPairs...')
  const t = Date.now()
  const pairs = await buildScanPairs(store, allItemsMap)
  console.log(`Done in ${Date.now() - t}ms — ${pairs.length} pairs`)

  // Analyze results
  const SURFACE_IDS = new Set(['t1_strata_surface1', 't3_strata_surface2', 't1_strata_surface3', 't3_strata_surface4'])
  const DECOY_IDS = new Set(['t3_strata_decoy1', 't1_strata_decoy2', 't1_strata_decoy3', 't3_strata_decoy4'])
  const CASE_POST = 't3_strata_casepost'

  console.log('\n--- Scan Pair Analysis ---')
  for (const pair of pairs) {
    const anchorItem = seed.items.find(i => i.id === pair.anchorId)
    const anchorLabel = anchorItem?.title?.slice(0, 50) ?? pair.anchorId
    const isPlanted = pair.anchorId.includes('strata_')

    console.log(`\nAnchor: ${pair.anchorId} "${anchorLabel}"${isPlanted ? ' [PLANTED]' : ''}`)
    console.log(`  Connections (${pair.connectionIds.length}):`)

    let surfaceHits = 0, decoyHits = 0, caseHits = 0, corpusHits = 0
    for (const connId of pair.connectionIds) {
      const isSurface = SURFACE_IDS.has(connId)
      const isDecoy = DECOY_IDS.has(connId)
      const isCase = connId === CASE_POST
      const connItem = seed.items.find(i => i.id === connId)
      const connThread = connItem?.threadRootId
      const anchorThread = anchorItem?.threadRootId

      if (isSurface) surfaceHits++
      else if (isDecoy) decoyHits++
      else if (isCase) caseHits++
      else corpusHits++

      if (connId.includes('strata_') || isSurface || isDecoy || isCase) {
        const tag = isSurface ? 'SURFACE' : isDecoy ? 'DECOY' : isCase ? 'CASE' : 'PLANTED'
        const sameThread = connThread === anchorThread ? ' [SAME THREAD!]' : ''
        console.log(`    ${tag}: ${connId}${sameThread}`)
      }
    }
    if (corpusHits > 0) console.log(`    + ${corpusHits} corpus items`)
    console.log(`  Summary: ${surfaceHits} surfaces, ${decoyHits} decoys, ${caseHits} case, ${corpusHits} corpus`)
  }

  // Check: did planted items get surfaced?
  const allConnIds = new Set(pairs.flatMap(p => [p.anchorId, ...p.connectionIds]))
  console.log('\n--- Planted Item Coverage ---')
  for (const id of SURFACE_IDS) {
    console.log(`  ${id}: ${allConnIds.has(id) ? '✓ FOUND' : '✗ MISSED'}`)
  }
  for (const id of DECOY_IDS) {
    console.log(`  ${id}: ${allConnIds.has(id) ? '⚠ INCLUDED (should be excluded)' : '✓ excluded'}`)
  }
  console.log(`  ${CASE_POST}: ${allConnIds.has(CASE_POST) ? '✓ FOUND' : '✗ MISSED'}`)

  // Check: any same-thread connections?
  let sameThreadCount = 0
  for (const pair of pairs) {
    const anchorThread = allItemsMap.get(pair.anchorId)?.threadRootId
    for (const connId of pair.connectionIds) {
      const connThread = allItemsMap.get(connId)?.threadRootId
      if (anchorThread && connThread === anchorThread) sameThreadCount++
    }
  }
  console.log(`\n--- Same-thread connections: ${sameThreadCount} (should be 0) ---`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
