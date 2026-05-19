import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'
import { embedBatch, cosine } from '../src/engine/embed.js'
import type { Entity, CostTracker } from '../src/engine/types.js'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

// ============================================================
// PIPELINE: Type-isolated entity embedding search
//
// 1. Extract entities from all items (raw, no canonicalization)
// 2. Embed each entity's surfaceText
// 3. Store in type-bucketed index: Map<type, Array<{emb, surfaceText, itemId}>>
// 4. For a new item: extract + embed its entities
// 5. For each query entity, search ONLY within its type bucket
// 6. Aggregate: which items have the most/strongest cross-type matches?
// 7. Final candidates → full-text embedding rerank → LLM classify
// ============================================================

const ITEMS = [
  {
    id: 'frag_nearmiss',
    text: 'Honestly stay off Mass Ave near Central if you can. Last Tuesday around 6pm some asshole in a dark green Subaru Outback blew through the crosswalk at Prospect while I was mid-crossing. Had to jump back onto the curb. Didn\'t get the plate but the car had a cracked taillight and one of those "26.2" marathon stickers on the back window.',
  },
  {
    id: 'frag_dashcam',
    text: 'Dashcam caught a car jump the curb on Mass Ave near Central — should I report this? Driving home Tuesday evening around 6:15pm on Mass Ave heading toward Harvard Square. Right near the Prospect St intersection a dark green SUV (looked like a Subaru maybe Outback or Forester) swerved hard into the bike lane, clipped the curb, then accelerated away fast toward Inman. I have clear footage from my dashcam — you can see the car pretty well including what looks like a marathon bumper sticker.',
  },
  {
    id: 'frag_garage',
    text: 'Not exactly a rant but something that\'s been bugging me — someone on P3 of the Cambridgeside garage (near the elevator) has a dark green Subaru Outback that suddenly has gnarly front bumper damage and a cracked passenger headlight. Showed up maybe 2 weeks ago. The bumper is hanging off on one side. They park in the same spot every weekday morning.',
  },
  {
    id: 'frag_earwitness',
    text: 'Was walking down Prospect toward Central around 6pm and heard a loud crash followed by tires screeching. By the time I got to Mass Ave there was a bicycle on the ground with the front wheel bent in half but no car and no person. A couple people were looking around confused. Someone said they saw the cyclist get up and stumble toward the CVS.',
  },
  {
    id: 'noise_selling_subaru',
    text: 'Thinking about selling my green Subaru Outback 2019 — 45k miles, great condition. Is $22k reasonable for Boston area? Where should I list it?',
  },
  {
    id: 'noise_pizza',
    text: 'Best pizza in Somerville? Just moved here from NYC and looking for decent slices. Davis Square area preferred but willing to travel for good food.',
  },
  {
    id: 'noise_road_rage',
    text: 'Road rage incident on Storrow Drive — some guy in a pickup cut across three lanes and brake checked me. I have dashcam footage. Worth reporting?',
  },
  {
    id: 'noise_bike_lanes',
    text: 'The bike lanes on Mass Ave are a joke. They just painted lines and called it done. No physical barrier means cars swerve in constantly.',
  },
  {
    id: 'noise_pothole',
    text: 'Hit a pothole on Comm Ave near BU and blew out my tire. The crater is easily 8 inches deep. Reported to 311 but how long does that actually take?',
  },
  {
    id: 'noise_parking',
    text: 'The meters in the Seaport are criminal. $4.50/hour and they ticket you at 5:01. I got two tickets in one week just trying to grab lunch.',
  },
]

const CASE_POST = {
  id: 'case_post',
  text: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop. Sarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out. Cambridge PD case #2026-04891. If ANYONE has dashcam footage from Mass Ave near Prospect St Tuesday around 6pm, or if anyone saw ANYTHING, please contact Cambridge PD or DM me.',
}

const SIGNAL_IDS = new Set(['frag_nearmiss', 'frag_dashcam', 'frag_garage', 'frag_earwitness'])

type IndexEntry = { surfaceText: string; embedding: number[]; itemId: string }
type TypeIndex = Map<string, IndexEntry[]>

async function main() {
  const cost = new SimpleCost()
  console.log('=== Entity-Embedding V2: Type-Isolated Search ===\n')

  // Step 1: Extract entities from all items
  console.log('Step 1: Extracting entities...')
  const itemEntities = new Map<string, Entity[]>()
  for (const item of [...ITEMS, CASE_POST]) {
    const entities = await extractEntities(client, normalize(item.text), undefined, cost)
    itemEntities.set(item.id, entities)
  }

  // Step 2: Build type-bucketed index (embed entities grouped by type)
  console.log('\nStep 2: Building type-bucketed entity index...')
  const typeIndex: TypeIndex = new Map()
  const toEmbed: Array<{ type: string; surfaceText: string; itemId: string }> = []

  for (const [itemId, entities] of itemEntities) {
    if (itemId === 'case_post') continue
    for (const e of entities) {
      toEmbed.push({ type: e.type, surfaceText: e.surfaceText, itemId })
    }
  }

  const embTexts = toEmbed.map(e => e.surfaceText)
  const embeddings = await embedBatch(client, embTexts, cost)

  for (let i = 0; i < toEmbed.length; i++) {
    const { type, surfaceText, itemId } = toEmbed[i]
    if (!typeIndex.has(type)) typeIndex.set(type, [])
    typeIndex.get(type)!.push({ surfaceText, embedding: embeddings[i], itemId })
  }

  console.log('  Type buckets:')
  for (const [type, entries] of typeIndex) {
    console.log(`    ${type}: ${entries.length} entities`)
  }

  // Step 3: Extract + embed case post entities
  console.log('\nStep 3: Embedding case post entities...')
  const caseEntities = itemEntities.get('case_post')!
  const caseEmbTexts = caseEntities.map(e => e.surfaceText)
  const caseEmbeddings = await embedBatch(client, caseEmbTexts, cost)

  console.log('  Case post entities:')
  for (const e of caseEntities) {
    console.log(`    ${e.type}: "${e.surfaceText}"`)
  }

  // Step 4: Type-isolated search — for each case entity, search only within its type
  console.log('\nStep 4: Type-isolated entity search...')

  type Match = { caseEntity: Entity; storedSurface: string; storedItemId: string; score: number }
  const matchesByType = new Map<string, Match[]>()

  for (let ci = 0; ci < caseEntities.length; ci++) {
    const caseEntity = caseEntities[ci]
    const caseEmb = caseEmbeddings[ci]
    const bucket = typeIndex.get(caseEntity.type)
    if (!bucket || bucket.length === 0) continue

    const matches: Match[] = []
    for (const entry of bucket) {
      const score = cosine(caseEmb, entry.embedding)
      matches.push({ caseEntity, storedSurface: entry.surfaceText, storedItemId: entry.itemId, score })
    }
    matches.sort((a, b) => b.score - a.score)

    if (!matchesByType.has(caseEntity.type)) matchesByType.set(caseEntity.type, [])
    matchesByType.get(caseEntity.type)!.push(...matches)
  }

  // Print top matches per type
  for (const [type, matches] of matchesByType) {
    const seen = new Set<string>()
    const deduped = matches.filter(m => {
      const key = `${m.storedItemId}:${m.storedSurface}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    deduped.sort((a, b) => b.score - a.score)
    console.log(`\n  [${type}] Top matches:`)
    for (const m of deduped.slice(0, 8)) {
      const isSignal = SIGNAL_IDS.has(m.storedItemId)
      console.log(`    ${isSignal ? '★' : ' '} ${m.score.toFixed(4)} | "${m.caseEntity.surfaceText}" ↔ "${m.storedSurface}" [${m.storedItemId}]`)
    }
  }

  // Step 5: Aggregate — score each item by its best match per type
  console.log('\n\nStep 5: Aggregate item scores (best match per type)...')

  // For each item: count how many TYPES it has a match above threshold, and sum best-per-type scores
  const THRESHOLD = 0.80
  const itemTypeMatches = new Map<string, Map<string, number>>() // itemId → Map<type, bestScore>

  for (const [type, matches] of matchesByType) {
    for (const m of matches) {
      if (m.score < THRESHOLD) continue
      if (!itemTypeMatches.has(m.storedItemId)) itemTypeMatches.set(m.storedItemId, new Map())
      const typeMap = itemTypeMatches.get(m.storedItemId)!
      typeMap.set(type, Math.max(typeMap.get(type) ?? 0, m.score))
    }
  }

  const itemRanking = [...itemTypeMatches.entries()].map(([itemId, typeMap]) => ({
    itemId,
    typesMatched: typeMap.size,
    bestScores: Object.fromEntries(typeMap),
    totalScore: [...typeMap.values()].reduce((a, b) => a + b, 0),
  }))
  itemRanking.sort((a, b) => b.typesMatched - a.typesMatched || b.totalScore - a.totalScore)

  console.log(`  Items with entity matches above ${THRESHOLD} (ranked by types matched):`)
  for (const item of itemRanking) {
    const isSignal = SIGNAL_IDS.has(item.itemId)
    const types = Object.entries(item.bestScores).map(([t, s]) => `${t}:${(s as number).toFixed(3)}`).join(', ')
    console.log(`    ${isSignal ? '★' : ' '} ${item.itemId}: ${item.typesMatched} types matched, total=${item.totalScore.toFixed(3)} [${types}]`)
  }

  // ============================================================
  // EVALUATION
  // ============================================================
  console.log('\n=== EVALUATION ===')

  // H1: Vehicle/product entity embedding catches cross-phrasing
  const productMatches = matchesByType.get('product') ?? []
  const vehicleMatches = productMatches.filter(m =>
    m.caseEntity.surfaceText.toLowerCase().includes('subaru') ||
    m.caseEntity.surfaceText.toLowerCase().includes('suv') ||
    m.caseEntity.surfaceText.toLowerCase().includes('green')
  ).filter(m =>
    m.storedSurface.toLowerCase().includes('subaru') ||
    m.storedSurface.toLowerCase().includes('outback') ||
    m.storedSurface.toLowerCase().includes('green')
  )
  vehicleMatches.sort((a, b) => b.score - a.score)

  console.log('\n  H1: Vehicle cross-phrasing (product type only)')
  for (const m of vehicleMatches.slice(0, 5)) {
    const isSignal = SIGNAL_IDS.has(m.storedItemId)
    console.log(`    ${isSignal ? '★' : ' '} ${m.score.toFixed(4)} | "${m.caseEntity.surfaceText}" ↔ "${m.storedSurface}" [${m.storedItemId}]`)
  }
  const bestVehicle = vehicleMatches[0]?.score ?? 0
  const h1Pass = bestVehicle > 0.85
  console.log(`  Best: ${bestVehicle.toFixed(4)} (need > 0.85)`)
  console.log(`  H1: ${h1Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // H2: Signal items found through type-isolated entity search
  const signalInRanking = itemRanking.filter(r => SIGNAL_IDS.has(r.itemId))
  const h2Pass = signalInRanking.length >= 3
  console.log(`\n  H2: Signal items in entity-ranked results: ${signalInRanking.length}/4`)
  console.log(`  H2: ${h2Pass ? 'PASS ✓' : 'FAIL ✗'} (need >= 3)`)

  // H3: Selling Subaru — does it show up but with fewer type matches?
  const sellingEntry = itemRanking.find(r => r.itemId === 'noise_selling_subaru')
  const signalTypeCounts = signalInRanking.map(r => r.typesMatched)
  const minSignalTypes = Math.min(...signalTypeCounts)
  const sellingTypes = sellingEntry?.typesMatched ?? 0
  console.log(`\n  H3: Selling Subaru types matched: ${sellingTypes}`)
  console.log(`  Minimum signal types matched: ${minSignalTypes}`)
  const h3Pass = !sellingEntry || sellingTypes < minSignalTypes
  console.log(`  H3: ${h3Pass ? 'PASS ✓' : 'FAIL ✗'} (selling should have fewer type matches than signals)`)

  // H4: Does multi-type matching surface the right items at top?
  const top3 = itemRanking.slice(0, 3).map(r => r.itemId)
  const signalInTop3 = top3.filter(id => SIGNAL_IDS.has(id))
  const h4Pass = signalInTop3.length >= 2
  console.log(`\n  H4: Signal items in top 3: ${signalInTop3.length}/3`)
  console.log(`  Top 3: ${top3.join(', ')}`)
  console.log(`  H4: ${h4Pass ? 'PASS ✓' : 'FAIL ✗'} (need >= 2 signals in top 3)`)

  // H5: Earwitness found? (has location+time but no product match)
  const earwitnessEntry = itemRanking.find(r => r.itemId === 'frag_earwitness')
  const h5Pass = !!earwitnessEntry
  console.log(`\n  H5: Earwitness found in results: ${h5Pass ? 'YES' : 'NO'}`)
  if (earwitnessEntry) {
    console.log(`  Types matched: ${earwitnessEntry.typesMatched} [${Object.keys(earwitnessEntry.bestScores).join(', ')}]`)
  }
  console.log(`  H5: ${h5Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // Summary
  const results = [
    { id: 'H1', name: 'Vehicle embedding catches cross-phrasing', pass: h1Pass },
    { id: 'H2', name: 'Signal items found via entity search', pass: h2Pass },
    { id: 'H3', name: 'Selling Subaru separated from signals', pass: h3Pass },
    { id: 'H4', name: 'Signals dominate top rankings', pass: h4Pass },
    { id: 'H5', name: 'Earwitness found (location+time, no vehicle)', pass: h5Pass },
  ]

  console.log('\n=== RESULTS ===')
  for (const r of results) {
    console.log(`  ${r.id} (${r.name}): ${r.pass ? 'PASS ✓' : 'FAIL ✗'}`)
  }
  const passCount = results.filter(r => r.pass).length
  console.log(`\n  ${passCount}/${results.length} passed`)
  console.log(`  Total cost: $${cost.total.toFixed(4)}`)
  console.log(`  Verdict: ${passCount >= 4 ? 'TYPE-ISOLATED ENTITY-EMBEDDING WORKS' : passCount >= 3 ? 'MOSTLY WORKS' : 'NEEDS REWORK'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
