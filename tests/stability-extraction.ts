import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const CASE_TEXT = normalize(`My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP

I don't know what else to do. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop.

Sarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out.

Cambridge PD case #2026-04891. If ANYONE has dashcam footage from Mass Ave near Prospect St Tuesday around 6pm, or if anyone saw ANYTHING, please contact Cambridge PD or DM me.

She doesn't deserve this. Someone knows something. Please.`)

const RUNS = 10

async function main() {
  console.log(`=== Extraction Stability (${RUNS} runs on case post) ===\n`)
  console.log(`Text: "${CASE_TEXT.slice(0, 80)}..."\n`)

  const allResults: Array<Array<{ type: string; surfaceText: string }>> = []

  for (let i = 0; i < RUNS; i++) {
    const entities = await extractEntities(client, CASE_TEXT)
    allResults.push(entities)
    const hasObject = entities.some(e => e.type === 'object')
    const hasQuantity = entities.some(e => e.surfaceText.includes('#2026'))
    console.log(`Run ${String(i + 1).padStart(2)}: ${entities.length} entities ${hasObject ? '✓ OBJECT' : '✗ no object'} ${hasQuantity ? '✓ CASE#' : '✗ no case#'}`)
    for (const e of entities) {
      console.log(`        ${e.type}: "${e.surfaceText}"`)
    }
    console.log()
  }

  // Stability analysis
  console.log('=== STABILITY ANALYSIS ===\n')

  const entityFreq = new Map<string, number>()
  for (const run of allResults) {
    for (const e of run) {
      const key = `${e.type}:"${e.surfaceText}"`
      entityFreq.set(key, (entityFreq.get(key) ?? 0) + 1)
    }
  }

  const sorted = [...entityFreq.entries()].sort((a, b) => b[1] - a[1])
  console.log('Entity frequency across runs:')
  for (const [key, count] of sorted) {
    const pct = ((count / RUNS) * 100).toFixed(0)
    const bar = '█'.repeat(count) + '░'.repeat(RUNS - count)
    console.log(`  ${bar} ${pct}% (${count}/${RUNS}) ${key}`)
  }

  console.log()
  const objectRuns = allResults.filter(r => r.some(e => e.type === 'object')).length
  const caseNumRuns = allResults.filter(r => r.some(e => e.surfaceText.includes('#2026'))).length
  console.log(`Vehicle/object extracted: ${objectRuns}/${RUNS} (${((objectRuns / RUNS) * 100).toFixed(0)}%)`)
  console.log(`Case number extracted:    ${caseNumRuns}/${RUNS} (${((caseNumRuns / RUNS) * 100).toFixed(0)}%)`)
  console.log(`Avg entities per run:     ${(allResults.reduce((s, r) => s + r.length, 0) / RUNS).toFixed(1)}`)

  if (objectRuns < RUNS * 0.8) {
    console.log('\n⚠️  UNSTABLE: Vehicle entity extracted < 80% of runs. Prompt needs work.')
  } else {
    console.log('\n✓ STABLE: Vehicle entity reliably extracted.')
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
