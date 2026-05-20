import OpenAI from 'openai'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from '../src/engine/prompts.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const TEST_TEXTS = [
  'I saw a dark green Subaru Outback blow through the crosswalk at Prospect St around 6pm Tuesday.',
  'Three weeks since I submitted dashcam footage to Cambridge PD for case #2026-04891. Never heard back.',
  'Best pizza in Davis Square? Looking for NY-style slices under $5.',
]

async function main() {
  console.log('=== Batch API E2E Validation ===\n')

  // --- Phase 1: Embeddings Batch ---
  console.log('--- Phase 1: Embeddings Batch ---')

  const embLines = TEST_TEXTS.map((text, i) => JSON.stringify({
    custom_id: `emb-${i}`,
    method: 'POST',
    url: '/v1/embeddings',
    body: { model: 'text-embedding-3-small', input: text, dimensions: 256 },
  }))
  const embJsonl = embLines.join('\n')
  console.log(`  Built JSONL: ${embLines.length} lines, ${embJsonl.length} bytes`)

  // Upload file
  const embFile = await client.files.create({
    file: new File([embJsonl], 'emb-batch.jsonl', { type: 'application/jsonl' }),
    purpose: 'batch',
  })
  console.log(`  Uploaded: ${embFile.id}`)

  // Create batch
  const embBatch = await client.batches.create({
    input_file_id: embFile.id,
    endpoint: '/v1/embeddings',
    completion_window: '24h',
  })
  console.log(`  Batch created: ${embBatch.id}, status: ${embBatch.status}`)

  // Poll for completion
  let embResult = embBatch
  const embStart = Date.now()
  while (embResult.status !== 'completed' && embResult.status !== 'failed' && embResult.status !== 'expired') {
    await new Promise(r => setTimeout(r, 3000))
    embResult = await client.batches.retrieve(embBatch.id)
    const elapsed = ((Date.now() - embStart) / 1000).toFixed(0)
    console.log(`  [${elapsed}s] Status: ${embResult.status} (${embResult.request_counts?.completed ?? 0}/${embResult.request_counts?.total ?? 0})`)
  }

  if (embResult.status !== 'completed') {
    console.error(`  FAILED: ${embResult.status}`)
    if (embResult.error_file_id) {
      const errContent = await client.files.content(embResult.error_file_id)
      console.error('  Errors:', await errContent.text())
    }
    process.exit(1)
  }

  // Download results
  const embOutput = await client.files.content(embResult.output_file_id!)
  const embOutputText = await embOutput.text()
  const embResults = embOutputText.trim().split('\n').map(line => JSON.parse(line))
  console.log(`  Results: ${embResults.length} responses`)
  for (const r of embResults) {
    const dim = r.response?.body?.data?.[0]?.embedding?.length ?? 0
    console.log(`    ${r.custom_id}: ${r.response?.status_code} — ${dim} dimensions`)
  }
  console.log()

  // --- Phase 2: Entity Extraction Batch ---
  console.log('--- Phase 2: Entity Extraction Batch (gpt-5.4-mini) ---')

  const extractLines = TEST_TEXTS.map((text, i) => JSON.stringify({
    custom_id: `extract-${i}`,
    method: 'POST',
    url: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      temperature: 0,
      input: [
        { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM },
        { role: 'user', content: text },
      ],
      text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
    },
  }))
  const extractJsonl = extractLines.join('\n')
  console.log(`  Built JSONL: ${extractLines.length} lines, ${extractJsonl.length} bytes`)

  const extractFile = await client.files.create({
    file: new File([extractJsonl], 'extract-batch.jsonl', { type: 'application/jsonl' }),
    purpose: 'batch',
  })
  console.log(`  Uploaded: ${extractFile.id}`)

  const extractBatch = await client.batches.create({
    input_file_id: extractFile.id,
    endpoint: '/v1/responses',
    completion_window: '24h',
  })
  console.log(`  Batch created: ${extractBatch.id}, status: ${extractBatch.status}`)

  let extractResult = extractBatch
  const extractStart = Date.now()
  while (extractResult.status !== 'completed' && extractResult.status !== 'failed' && extractResult.status !== 'expired') {
    await new Promise(r => setTimeout(r, 3000))
    extractResult = await client.batches.retrieve(extractBatch.id)
    const elapsed = ((Date.now() - extractStart) / 1000).toFixed(0)
    console.log(`  [${elapsed}s] Status: ${extractResult.status} (${extractResult.request_counts?.completed ?? 0}/${extractResult.request_counts?.total ?? 0})`)
  }

  if (extractResult.status !== 'completed') {
    console.error(`  FAILED: ${extractResult.status}`)
    if (extractResult.error_file_id) {
      const errContent = await client.files.content(extractResult.error_file_id)
      console.error('  Errors:', await errContent.text())
    }
    process.exit(1)
  }

  const extractOutput = await client.files.content(extractResult.output_file_id!)
  const extractOutputText = await extractOutput.text()
  const extractResults = extractOutputText.trim().split('\n').map(line => JSON.parse(line))
  console.log(`  Results: ${extractResults.length} responses`)
  for (const r of extractResults) {
    const outputText = r.response?.body?.output_text ?? r.response?.body?.output?.[0]?.content?.[0]?.text ?? ''
    try {
      const parsed = JSON.parse(outputText)
      console.log(`    ${r.custom_id}: ${r.response?.status_code} — ${parsed.entities?.length ?? 0} entities`)
      for (const e of (parsed.entities ?? [])) {
        console.log(`      ${e.type}: "${e.surfaceText}"`)
      }
    } catch {
      console.log(`    ${r.custom_id}: ${r.response?.status_code} — parse error: ${outputText.slice(0, 100)}`)
    }
  }

  console.log('\n=== DONE ===')
  console.log(`  Embedding batch: ${((Date.now() - embStart) / 1000).toFixed(0)}s total`)
  console.log(`  Extraction batch: ${((Date.now() - extractStart) / 1000).toFixed(0)}s total`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
