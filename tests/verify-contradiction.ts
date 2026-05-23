// Verify the contradiction-flag path against the planted FLAG-2 pair.
// flag2a posted Day 24: "my roommate drives every Tuesday, parks P3"
// flag2b posted Day 41 in the case thread: "my roommate was home Tuesday, doesn't even drive"
// Expected: ingesting flag2b triggers flag.type='contradiction' referencing flag2a.

import OpenAI from 'openai'
import { StrataEngine } from '../src/engine/index.js'
import { MemoryKVStore } from '../src/engine/storage/memory.js'
import { BACKFILL_ITEMS, LIVE_ITEMS } from '../dataset/signal-items.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function main() {
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client)

  // Ingest only TKfromCambridge's prior post (flag2a) and the case post + brigades
  const flag2a = BACKFILL_ITEMS.find(i => i.id === 't1_strata_flag2a')!
  const flag2b = LIVE_ITEMS.find(i => i.id === 't1_strata_flag2b')!
  const casepost = LIVE_ITEMS.find(i => i.id === 't3_strata_casepost')!

  console.log('Ingesting prior context (flag2a + casepost)...')
  await engine.ingest(flag2a)
  await engine.ingest(casepost)

  console.log(`\nIngesting flag2b (TKfromCambridge in case thread)...`)
  const item = await engine.ingest(flag2b)

  console.log(`\nRunning flag pipeline on flag2b...`)
  const t0 = performance.now()
  const flags = await engine.flag(item)
  console.log(`  ${flags.length} flag(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

  for (const f of flags) {
    console.log(`\n  type:        ${f.type}`)
    console.log(`  confidence:  ${f.confidence}`)
    console.log(`  reasoning:   ${f.reasoning}`)
    console.log(`  connections: ${f.connectionItems.map(c => c.id).join(', ')}`)
  }

  const contradictionFlag = flags.find(f => f.type === 'contradiction')
  if (contradictionFlag && contradictionFlag.connectionItems.some(c => c.id === 't1_strata_flag2a')) {
    console.log('\nPASS — contradiction flag fired, references flag2a')
    process.exit(0)
  }
  console.log('\nFAIL — no contradiction flag pointing to flag2a')
  process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
