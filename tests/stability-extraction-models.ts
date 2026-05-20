import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from '../src/engine/prompts.js'
import type { Entity } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const CASE_TEXT = normalize(`My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP

I don't know what else to do. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop.

Sarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out.

Cambridge PD case #2026-04891. If ANYONE has dashcam footage from Mass Ave near Prospect St Tuesday around 6pm, or if anyone saw ANYTHING, please contact Cambridge PD or DM me.

She doesn't deserve this. Someone knows something. Please.`)

const MODELS = ['gpt-5.5']
const RUNS = 5

async function extract(model: string): Promise<{ entities: Entity[]; inputTokens: number; outputTokens: number; ms: number }> {
  const start = Date.now()
  const params: any = {
    model,
    input: [
      { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM },
      { role: 'user', content: CASE_TEXT },
    ],
    text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
  }
  if (!model.includes('5.5')) params.temperature = 0
  const response = await client.responses.create(params)
  const ms = Date.now() - start
  const parsed = JSON.parse(response.output_text) as { entities: Entity[] }
  return {
    entities: parsed.entities,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    ms,
  }
}

// Pricing per 1M tokens (input/output)
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.40, output: 1.60 },
  'gpt-5.4': { input: 2.00, output: 8.00 },
  'gpt-5.5': { input: 10.00, output: 30.00 },
}

async function main() {
  console.log(`=== Extraction Model Comparison (${RUNS} runs each) ===\n`)

  for (const model of MODELS) {
    console.log(`--- ${model} ---`)
    const pricing = PRICING[model]
    let totalMs = 0
    let totalCost = 0
    let objectCount = 0
    let caseNumCount = 0
    const allEntities: string[][] = []

    for (let i = 0; i < RUNS; i++) {
      const result = await extract(model)
      const cost = (result.inputTokens / 1_000_000) * pricing.input + (result.outputTokens / 1_000_000) * pricing.output
      totalMs += result.ms
      totalCost += cost

      const hasObject = result.entities.some(e => e.type === 'object')
      const hasCaseNum = result.entities.some(e => e.surfaceText.includes('#2026') || e.surfaceText.includes('2026-04891'))
      if (hasObject) objectCount++
      if (hasCaseNum) caseNumCount++

      const entityList = result.entities.map(e => `${e.type}:"${e.surfaceText}"`)
      allEntities.push(entityList)

      console.log(`  Run ${i + 1}: ${result.entities.length} entities, ${result.ms}ms, $${cost.toFixed(5)} ${hasObject ? '✓OBJ' : '✗obj'} ${hasCaseNum ? '✓CASE#' : '✗case#'}`)
      for (const e of result.entities) {
        console.log(`       ${e.type}: "${e.surfaceText}"`)
      }
    }

    const avgMs = totalMs / RUNS
    const avgCost = totalCost / RUNS
    console.log(`\n  Summary:`)
    console.log(`    Vehicle extracted: ${objectCount}/${RUNS} (${((objectCount / RUNS) * 100).toFixed(0)}%)`)
    console.log(`    Case# extracted:   ${caseNumCount}/${RUNS} (${((caseNumCount / RUNS) * 100).toFixed(0)}%)`)
    console.log(`    Avg latency:       ${avgMs.toFixed(0)}ms`)
    console.log(`    Avg cost/call:     $${avgCost.toFixed(5)}`)
    console.log(`    Cost at 3K items:  $${(avgCost * 3000).toFixed(2)}`)
    console.log()
  }

  // Comparison table
  console.log('=== COMPARISON ===\n')
  console.log('  Model         | Vehicle | Case# | Latency | $/call    | $/3K items')
  console.log('  --------------|---------|-------|---------|-----------|----------')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
