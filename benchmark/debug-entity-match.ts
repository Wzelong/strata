import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cosine, dequantize } from '../src/engine/embed.js'
import { stringSimilarity } from '../src/engine/search.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { LIVE_ITEMS } from '../dataset/signal-items.js'
import type { StoredItem, Entity } from '../src/engine/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-seed.json'), 'utf8'))
const liveData = JSON.parse(readFileSync(resolve(__dirname, 'benchmark-live-items.json'), 'utf8'))
const liveMap = new Map(liveData.items.map((i: any) => [i.id, i]))

const cpObj = seed.entityEmbeddings['t3_strata_casepost'].find((e: any) => e.type === 'object')
const s1Obj = seed.entityEmbeddings['t1_strata_surface1'].find((e: any) => e.surfaceText === 'dark green Subaru Outback')
const s3Obj = seed.entityEmbeddings['t1_strata_surface3']?.find((e: any) => e.surfaceText === 'dark green Subaru Outback')

console.log('Case post object:', cpObj.surfaceText)
console.log('Surface1 object:', s1Obj?.surfaceText)
console.log('')

if (cpObj && s1Obj) {
  const a = dequantize(cpObj.embedding)
  const b = dequantize(s1Obj.embedding)
  console.log('Quantized cosine:', cosine(a, b).toFixed(4))
  console.log('String sim:', stringSimilarity(cpObj.surfaceText, s1Obj.surfaceText).toFixed(4))
  console.log('Passes 0.75 threshold?', cosine(a, b) >= 0.75)
}

// Simulate what the benchmark does — load into store and verify
const store = new MemoryKVStore()
const seen = new Set<string>()

for (const item of seed.items) {
  if (seen.has(item.id)) continue
  seen.add(item.id)
  await store.setItem(item)
  const emb = seed.embeddings[item.id]
  if (emb) await store.setEmbedding(item.id, emb)
  if (item.entities.length > 0) await store.addToEntityIndex(item.entities, item.id, item.createdAt)
  const entEmbs = seed.entityEmbeddings?.[item.id]
  if (entEmbs?.length > 0) await store.setEntityEmbeddings(item.id, entEmbs)
}

for (const rawItem of LIVE_ITEMS) {
  if (seen.has(rawItem.id)) continue
  seen.add(rawItem.id)
  const live = liveMap.get(rawItem.id)
  if (!live) continue
  const item: StoredItem = {
    id: rawItem.id, type: rawItem.type, text: rawItem.text,
    textNormalized: live.textNormalized, authorId: rawItem.authorId,
    authorName: rawItem.authorName, createdAt: rawItem.createdAt,
    threadRootId: rawItem.threadRootId, parentId: rawItem.parentId,
    entities: live.entities, decision: 'pending', decisionAt: null,
    decisionBy: null, decisionReason: null,
  }
  await store.setItem(item)
  await store.setEmbedding(rawItem.id, live.embedding)
  if (live.entities.length > 0) await store.addToEntityIndex(live.entities, rawItem.id, rawItem.createdAt)
  const entEmbs = seed.entityEmbeddings?.[rawItem.id]
  if (entEmbs?.length > 0) await store.setEntityEmbeddings(rawItem.id, entEmbs)
}

// Now check what's in the object bucket
const objectBucket = await store.getEntityEmbeddingsByType('object')
const signalObjects = objectBucket.filter(e =>
  e.itemId.includes('strata_casepost') || e.itemId.includes('strata_surface')
)
console.log('\nObject bucket entries for signal items:')
for (const e of signalObjects) {
  console.log(`  ${e.itemId}: "${e.surfaceText}" (emb: ${e.embedding.length} chars)`)
}

// Check text similarity
const cpTextEmb = await store.getEmbedding('t3_strata_casepost')
const s1TextEmb = await store.getEmbedding('t1_strata_surface1')
if (cpTextEmb && s1TextEmb) {
  console.log('\nText similarity case post <-> surface1:', cosine(cpTextEmb, s1TextEmb).toFixed(4))
}
