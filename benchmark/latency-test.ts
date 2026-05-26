import OpenAI from 'openai'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from '../src/engine/extract.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const texts = [
  'A silver Toyota Camry with plate 4ABC123 was seen speeding near the intersection of Mass Ave and Harvard St around 11pm. The driver appeared to be a male in his 30s wearing a Red Sox cap.',
  'Just saw someone break into a blue Honda Civic on Tremont St near the Boylston T stop. Called 911 but they drove off toward Chinatown.',
  'My neighbor John Doe at 45 Elm Street has been running some kind of unlicensed auto repair. Oil everywhere, cars at all hours.',
  'Lost dog near Franklin Park — golden retriever, red collar, name tag says "Buddy". Contact Sarah at 617-555-0142.',
  'The new dispensary on Washington St (Green Leaf Co) has been getting noise complaints from residents at 120 Washington.',
]

const MULTI_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity'] },
                surfaceText: { type: 'string' },
              },
              required: ['type', 'surfaceText'],
              additionalProperties: false,
            },
          },
        },
        required: ['index', 'entities'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

async function main() {
  // Warm up
  await client.responses.create({ model: 'gpt-5.4-mini', temperature: 0, input: [{ role: 'developer', content: ENTITY_EXTRACTION_SYSTEM }, { role: 'user', content: 'test' }], text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } } })

  // 1 item per call × 5 sequential
  let s = Date.now()
  for (const t of texts) {
    await client.responses.create({ model: 'gpt-5.4-mini', temperature: 0, input: [{ role: 'developer', content: ENTITY_EXTRACTION_SYSTEM }, { role: 'user', content: t }], text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } } })
  }
  console.log(`5 × 1-item sequential: ${Date.now() - s}ms`)

  // 1 item per call × 5 parallel
  s = Date.now()
  await Promise.all(texts.map(t => client.responses.create({ model: 'gpt-5.4-mini', temperature: 0, input: [{ role: 'developer', content: ENTITY_EXTRACTION_SYSTEM }, { role: 'user', content: t }], text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } } })))
  console.log(`5 × 1-item parallel: ${Date.now() - s}ms`)

  // 5 items in 1 call (batched prompt)
  const batchedInput = texts.map((t, i) => `[Item ${i}]\n${t}`).join('\n\n---\n\n')
  s = Date.now()
  const r = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM + '\n\nYou will receive multiple items separated by ---. Extract entities from EACH item independently. Return results as an array with the index of each item.' },
      { role: 'user', content: batchedInput },
    ],
    text: { format: { type: 'json_schema', name: 'multi_entity_extraction', schema: MULTI_SCHEMA, strict: true } },
  })
  console.log(`1 call × 5 items batched: ${Date.now() - s}ms`)
  const parsed = JSON.parse(r.output_text)
  console.log(`  returned ${parsed.results.length} results, entities: ${parsed.results.map((r: any) => r.entities.length).join(', ')}`)

  // 50 × 1-item parallel
  const fiftyTexts = Array.from({ length: 50 }, (_, i) => texts[i % texts.length])
  s = Date.now()
  await Promise.all(fiftyTexts.map(t => client.responses.create({ model: 'gpt-5.4-mini', temperature: 0, input: [{ role: 'developer', content: ENTITY_EXTRACTION_SYSTEM }, { role: 'user', content: t }], text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } } })))
  console.log(`50 × 1-item parallel: ${Date.now() - s}ms`)

  // 10 calls × 5 items each parallel
  const tenBatches = Array.from({ length: 10 }, (_, i) => {
    const batch = fiftyTexts.slice(i * 5, (i + 1) * 5)
    return batch.map((t, j) => `[Item ${j}]\n${t}`).join('\n\n---\n\n')
  })
  s = Date.now()
  await Promise.all(tenBatches.map(input => client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM + '\n\nYou will receive multiple items separated by ---. Extract entities from EACH item independently. Return results as an array with the index of each item.' },
      { role: 'user', content: input },
    ],
    text: { format: { type: 'json_schema', name: 'multi_entity_extraction', schema: MULTI_SCHEMA, strict: true } },
  })))
  console.log(`10 calls × 5 items batched parallel: ${Date.now() - s}ms`)
}

main().catch(console.error)
