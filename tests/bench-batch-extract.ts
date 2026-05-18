import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import OpenAI from 'openai'
import type { Entity, CostTracker } from '../src/engine/types.js'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from '../src/engine/prompts.js'
import { extractEntities } from '../src/engine/extract.js'
import { normalize } from '../src/engine/normalize.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

class SimpleCostTracker implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

const BATCH_ENTITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemIndex: { type: 'integer' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['person', 'location', 'time', 'username', 'url', 'organization', 'monetary_amount', 'quantity', 'phone', 'email', 'product'] },
                surfaceText: { type: 'string' },
                canonical: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                sourceSpan: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
              },
              required: ['type', 'surfaceText', 'canonical', 'confidence', 'sourceSpan'],
              additionalProperties: false,
            },
          },
        },
        required: ['itemIndex', 'entities'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

async function extractBatch(
  client: OpenAI,
  texts: string[],
  cost: SimpleCostTracker,
): Promise<Entity[][]> {
  const numbered = texts.map((t, i) => `[Item ${i}]\n${t}`).join('\n\n---\n\n')
  const systemPrompt = ENTITY_EXTRACTION_SYSTEM + `\n\nYou will receive multiple items separated by "---". Extract entities for EACH item independently. Return results grouped by itemIndex (0-based). Do not cross-reference entities between items.`

  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: numbered },
    ],
    text: { format: { type: 'json_schema', name: 'batch_entity_extraction', schema: BATCH_ENTITY_SCHEMA, strict: true } },
  })
  cost.track(response.usage)
  const parsed = JSON.parse(response.output_text) as { items: Array<{ itemIndex: number; entities: Entity[] }> }

  const results: Entity[][] = new Array(texts.length).fill(null).map(() => [])
  for (const item of parsed.items) {
    if (item.itemIndex >= 0 && item.itemIndex < texts.length) {
      results[item.itemIndex] = item.entities
    }
  }
  return results
}

function compareEntities(baseline: Entity[][], batched: Entity[][]): { matchRate: number; details: string[] } {
  let matches = 0
  let total = 0
  const details: string[] = []

  for (let i = 0; i < baseline.length; i++) {
    const baseCanonicals = new Set(baseline[i].map(e => `${e.type}:${e.canonical}`))
    const batchCanonicals = new Set(batched[i].map(e => `${e.type}:${e.canonical}`))

    for (const c of baseCanonicals) {
      total++
      if (batchCanonicals.has(c)) matches++
      else details.push(`  Item ${i}: missing ${c}`)
    }
    for (const c of batchCanonicals) {
      if (!baseCanonicals.has(c)) {
        details.push(`  Item ${i}: extra ${c}`)
      }
    }
  }

  return { matchRate: total > 0 ? matches / total : 1, details }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  // Load 20 items from the scams data
  const dataFile = resolve(__dirname, 'real-data', 'r_scams_posts.jsonl')
  const lines = readFileSync(dataFile, 'utf8').split('\n').filter(l => l.trim())
  const texts: string[] = []

  for (const line of lines) {
    if (texts.length >= 20) break
    const obj = JSON.parse(line)
    const text = obj.title && obj.selftext ? `${obj.title}\n\n${obj.selftext}` : (obj.selftext || obj.body || '')
    const normalized = normalize(text)
    if (normalized.length >= 50 && normalized.length <= 2000 && !normalized.includes('[removed]') && !normalized.includes('[deleted]')) {
      texts.push(normalized)
    }
  }

  console.log(`Loaded ${texts.length} items for benchmarking\n`)

  // --- gpt-5.4-mini baseline ---
  console.log('=== gpt-5.4-mini (1 item per call) ===')
  const miniCost = new SimpleCostTracker()
  const miniStart = Date.now()
  const miniResults: Entity[][] = []
  for (const text of texts) {
    const entities = await extractEntities(client, text, undefined, miniCost)
    miniResults.push(entities)
  }
  const miniTime = Date.now() - miniStart
  const miniEntityCount = miniResults.reduce((sum, e) => sum + e.length, 0)
  console.log(`  Time: ${(miniTime / 1000).toFixed(1)}s`)
  console.log(`  Cost: $${miniCost.total.toFixed(4)}`)
  console.log(`  Entities found: ${miniEntityCount}`)

  // --- gpt-5.4-nano ---
  console.log('\n=== gpt-5.4-nano (1 item per call) ===')
  const nanoCost = new SimpleCostTracker()
  const nanoStart = Date.now()
  const nanoResults: Entity[][] = []
  for (const text of texts) {
    const response = await client.responses.create({
      model: 'gpt-5.4-nano',
      temperature: 0,
      input: [
        { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM },
        { role: 'user', content: text },
      ],
      text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
    })
    nanoCost.track(response.usage)
    const parsed = JSON.parse(response.output_text) as { entities: Entity[] }
    nanoResults.push(parsed.entities)
  }
  const nanoTime = Date.now() - nanoStart
  const nanoEntityCount = nanoResults.reduce((sum, e) => sum + e.length, 0)
  const { matchRate: nanoMatch, details: nanoDetails } = compareEntities(miniResults, nanoResults)
  console.log(`  Time: ${(nanoTime / 1000).toFixed(1)}s`)
  console.log(`  Cost: $${nanoCost.total.toFixed(4)}`)
  console.log(`  Entities found: ${nanoEntityCount}`)
  console.log(`  Match rate vs mini: ${(nanoMatch * 100).toFixed(1)}%`)
  if (nanoDetails.length > 0) {
    for (const d of nanoDetails.slice(0, 10)) console.log(d)
    if (nanoDetails.length > 10) console.log(`  ... and ${nanoDetails.length - 10} more differences`)
  }

  console.log('\n=== Summary ===')
  console.log(`| Model | Time | Cost | Entities | Match vs mini |`)
  console.log(`|---|---|---|---|---|`)
  console.log(`| gpt-5.4-mini | ${(miniTime/1000).toFixed(1)}s | $${miniCost.total.toFixed(4)} | ${miniEntityCount} | — |`)
  console.log(`| gpt-5.4-nano | ${(nanoTime/1000).toFixed(1)}s | $${nanoCost.total.toFixed(4)} | ${nanoEntityCount} | ${(nanoMatch*100).toFixed(1)}% |`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
