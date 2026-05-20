import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import type { RawItem } from '../src/engine/types.js'
import {
  buildEmbeddingJsonl, buildExtractionJsonl, buildEntityEmbeddingJsonl,
  submitBatch, checkBatch, downloadBatchResults,
  parseEmbeddingResults, parseExtractionResults, storeResults,
} from '../src/engine/batch-ingest.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const TEST_ITEMS: RawItem[] = [
  { id: 'test-1', type: 'post', text: 'I saw a dark green Subaru Outback blow through the crosswalk at Prospect St around 6pm Tuesday. Cracked taillight and a marathon sticker on the back.', authorId: 'u1', authorName: 'ThursdayCommuter', createdAt: Date.now() - 86400000, threadRootId: 'test-1', parentId: null },
  { id: 'test-2', type: 'comment', text: 'Three weeks since I submitted dashcam footage to Cambridge PD for case #2026-04891. They told me a detective would follow up. Never heard back.', authorId: 'u2', authorName: 'DashcamDave', createdAt: Date.now() - 72000000, threadRootId: 'thread-x', parentId: 'thread-x' },
  { id: 'test-3', type: 'post', text: 'Best pizza in Davis Square? Looking for NY-style slices under $5.', authorId: 'u3', authorName: 'PizzaFan', createdAt: Date.now() - 50000000, threadRootId: 'test-3', parentId: null },
  { id: 'test-4', type: 'comment', text: 'Someone on P3 of the Cambridgeside garage has a dark green Subaru Outback with gnarly front bumper damage. Been there for weeks.', authorId: 'u4', authorName: 'GarageGuy', createdAt: Date.now() - 40000000, threadRootId: 'thread-y', parentId: 'thread-y' },
  { id: 'test-5', type: 'post', text: 'Heard a loud crash and tires screeching on Mass Ave near Prospect around 6pm. By the time I got there a bicycle was on the ground with the front wheel bent.', authorId: 'u5', authorName: 'InmanWalker', createdAt: Date.now() - 30000000, threadRootId: 'test-5', parentId: null },
]

async function main() {
  console.log(`=== Batch Ingest E2E (${TEST_ITEMS.length} items) ===\n`)
  const start = Date.now()

  // Phase 1: Build JSONLs
  const normalized = TEST_ITEMS.map(r => ({ id: r.id, text: normalize(r.text) }))
  const embJsonl = buildEmbeddingJsonl(normalized)
  const extractJsonl = buildExtractionJsonl(normalized)
  console.log(`Phase 1: Built JSONLs (emb: ${embJsonl.length}B, extract: ${extractJsonl.length}B)`)

  // Phase 2: Submit both batches
  const [embBatchId, extractBatchId] = await Promise.all([
    submitBatch(client, embJsonl, '/v1/embeddings', 'test-emb.jsonl'),
    submitBatch(client, extractJsonl, '/v1/responses', 'test-extract.jsonl'),
  ])
  console.log(`Phase 2: Submitted — emb=${embBatchId}, extract=${extractBatchId}`)

  // Phase 3: Poll until both complete
  console.log('Phase 3: Polling...')
  let embDone = false, extractDone = false
  let embOutputFileId = '', extractOutputFileId = ''

  while (!embDone || !extractDone) {
    await new Promise(r => setTimeout(r, 5000))
    if (!embDone) {
      const s = await checkBatch(client, embBatchId)
      if (s.status === 'completed') { embDone = true; embOutputFileId = s.outputFileId! }
      else if (s.status === 'failed') throw new Error('Embedding batch failed')
      process.stdout.write(`  emb: ${s.status}(${s.completed}/${s.total}) `)
    }
    if (!extractDone) {
      const s = await checkBatch(client, extractBatchId)
      if (s.status === 'completed') { extractDone = true; extractOutputFileId = s.outputFileId! }
      else if (s.status === 'failed') throw new Error('Extraction batch failed')
      process.stdout.write(`extract: ${s.status}(${s.completed}/${s.total})`)
    }
    console.log()
  }

  // Phase 4: Download results
  console.log('Phase 4: Downloading results...')
  const [embResults, extractResults] = await Promise.all([
    downloadBatchResults(client, embOutputFileId),
    downloadBatchResults(client, extractOutputFileId),
  ])

  const embeddings = parseEmbeddingResults(embResults)
  const entities = parseExtractionResults(extractResults)

  console.log(`  Embeddings: ${embeddings.size}/${TEST_ITEMS.length}`)
  console.log(`  Extractions: ${entities.size}/${TEST_ITEMS.length}`)
  for (const [id, ents] of entities) {
    console.log(`    ${id}: ${ents.map(e => `${e.type}:"${e.surfaceText}"`).join(', ')}`)
  }

  // Phase 5: Entity embeddings batch
  const entityItems: Array<{ id: string; text: string }> = []
  for (const [itemId, ents] of entities) {
    for (const e of ents) {
      entityItems.push({ id: `${itemId}:${e.surfaceText}`, text: e.surfaceText })
    }
  }
  console.log(`\nPhase 5: Entity embedding batch (${entityItems.length} entities)...`)

  let entityEmbeddings = new Map<string, number[]>()
  if (entityItems.length > 0) {
    const entEmbBatchId = await submitBatch(client, buildEntityEmbeddingJsonl(entityItems), '/v1/embeddings', 'test-ent-emb.jsonl')
    let entDone = false
    while (!entDone) {
      await new Promise(r => setTimeout(r, 5000))
      const s = await checkBatch(client, entEmbBatchId)
      console.log(`  entity-emb: ${s.status}(${s.completed}/${s.total})`)
      if (s.status === 'completed') {
        const entResults = await downloadBatchResults(client, s.outputFileId!)
        entityEmbeddings = parseEmbeddingResults(entResults)
        entDone = true
      } else if (s.status === 'failed') throw new Error('Entity embedding batch failed')
    }
  }

  // Phase 6: Store
  console.log(`\nPhase 6: Storing to MemoryKVStore...`)
  const store = new MemoryKVStore()
  const stored = await storeResults(store, TEST_ITEMS, embeddings, entities, entityEmbeddings)

  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(`\n=== DONE (${elapsed}s) ===`)
  console.log(`  Items stored: ${stored}/${TEST_ITEMS.length}`)
  console.log(`  Entity embeddings: ${entityEmbeddings.size}`)
  console.log(`  Store item count: ${await store.getItemCount()}`)

  // Verify a stored item
  const item = await store.getItem('test-1')
  if (item) {
    console.log(`\n  Verify test-1:`)
    console.log(`    text: "${item.text.slice(0, 60)}..."`)
    console.log(`    entities: ${item.entities.length}`)
    const emb = await store.getEmbedding('test-1')
    console.log(`    embedding: ${emb ? emb.length + ' dims' : 'MISSING'}`)
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
