import OpenAI from 'openai'
import { classifyBatch } from '../src/engine/classify.js'
import { normalize } from '../src/engine/normalize.js'
import type { Item, CostTracker } from '../src/engine/types.js'
import { BACKFILL_ITEMS, LIVE_ITEMS, SURFACE_IDS } from '../dataset/signal-items.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 10.00
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 30.00
  }
}

const NOISE_ITEMS = [
  { id: 'noise_pizza', text: 'Best pizza in Somerville? Just moved here from NYC and looking for decent slices. Davis Square area preferred but willing to travel for good food.' },
  { id: 'noise_rent', text: 'Is it just me or has rent in Cambridge gone completely insane? $3200 for a 1BR in Porter Square with no laundry or parking.' },
  { id: 'noise_bikelane', text: 'The bike lanes on Mass Ave are a joke. They just painted lines and called it done. No physical barrier means cars swerve in constantly.' },
]

async function main() {
  const cost = new SimpleCost()
  console.log('=== Classifier Confidence Validation ===\n')

  const casePost = LIVE_ITEMS.find(i => i.id === 't3_strata_casepost')!
  const caseItem: Item = {
    id: casePost.id,
    type: casePost.type as 'post' | 'comment',
    text: normalize(casePost.text),
    authorId: casePost.authorId,
    authorName: casePost.authorName,
    createdAt: casePost.createdAt,
    threadRootId: casePost.threadRootId,
    parentId: casePost.parentId,
    entities: [],
    embedding: [],
    decision: 'pending',
  }

  const candidates = [
    ...BACKFILL_ITEMS.filter(i => SURFACE_IDS.has(i.id)).map(i => ({ id: i.id, text: normalize(i.text) })),
    ...NOISE_ITEMS,
  ]

  console.log(`Case post: "${caseItem.text.slice(0, 80)}..."`)
  console.log(`Candidates: ${candidates.length} (4 signals + 3 noise)\n`)

  // Run 3 times to check stability
  for (let run = 0; run < 3; run++) {
    console.log(`--- Run ${run + 1} ---`)
    const results = await classifyBatch(client, caseItem, candidates, cost)

    for (const r of results) {
      const isSignal = SURFACE_IDS.has(r.id)
      const marker = isSignal ? '★' : ' '
      console.log(`  ${marker} ${r.id.padEnd(25)} | ${r.relationship.padEnd(12)} | ${(r.confidence ?? '-').padEnd(6)} | ${r.reason}`)
    }
    console.log()
  }

  console.log(`Cost: $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
