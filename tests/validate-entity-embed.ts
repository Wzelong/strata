import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'
import { embedBatch, embedSingle, cosine } from '../src/engine/embed.js'
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
// THE NEW PIPELINE:
// 1. Extract entities (no registry, no canonicalization pressure)
// 2. Embed each entity's surfaceText (or type:surfaceText)
// 3. For a new item: embed its entities, rank against ALL stored entity embeddings
// 4. Top entity matches → retrieve parent items
// 5. Rank those items by full-text embedding similarity
// 6. Final candidates → LLM classification
// ============================================================

type StoredEntity = {
  entity: Entity
  embedding: number[]
  itemId: string
}

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
  // NOISE
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

async function main() {
  const cost = new SimpleCost()

  console.log('=== Entity-Embedding Pipeline Validation ===\n')

  // Step 1: Extract entities from all items (NO registry — raw extraction)
  console.log('Step 1: Extracting entities (no registry)...')
  const itemEntities = new Map<string, Entity[]>()

  for (const item of [...ITEMS, CASE_POST]) {
    const entities = await extractEntities(client, normalize(item.text), undefined, cost)
    itemEntities.set(item.id, entities)
  }

  console.log('  Entities extracted:')
  for (const [id, entities] of itemEntities) {
    const summary = entities.map(e => `${e.type}:"${e.surfaceText}"`).join(', ')
    console.log(`    ${id}: ${summary.slice(0, 120)}${summary.length > 120 ? '...' : ''}`)
  }

  // Step 2: Embed each entity (using "type: surfaceText" as the embedding input)
  console.log('\nStep 2: Embedding entities...')
  const allEntityTexts: string[] = []
  const entityMeta: Array<{ itemId: string; entity: Entity; embIdx: number }> = []

  for (const [itemId, entities] of itemEntities) {
    if (itemId === 'case_post') continue // case post entities handled separately
    for (const entity of entities) {
      const embText = `${entity.type}: ${entity.surfaceText}`
      entityMeta.push({ itemId, entity, embIdx: allEntityTexts.length })
      allEntityTexts.push(embText)
    }
  }

  const entityEmbeddings = await embedBatch(client, allEntityTexts, cost)
  console.log(`  Embedded ${entityEmbeddings.length} stored entities`)

  // Step 3: Embed case post entities and rank against stored entity embeddings
  console.log('\nStep 3: Ranking case post entities against stored entities...')
  const caseEntities = itemEntities.get('case_post')!
  const caseEntityTexts = caseEntities.map(e => `${e.type}: ${e.surfaceText}`)
  const caseEntityEmbeddings = await embedBatch(client, caseEntityTexts, cost)

  // For each case post entity, find top matches in the stored entities
  type EntityMatch = { caseEntity: Entity; storedEntity: Entity; storedItemId: string; score: number }
  const allMatches: EntityMatch[] = []

  for (let ci = 0; ci < caseEntities.length; ci++) {
    const caseEmb = caseEntityEmbeddings[ci]
    for (let si = 0; si < entityMeta.length; si++) {
      const score = cosine(caseEmb, entityEmbeddings[si])
      allMatches.push({
        caseEntity: caseEntities[ci],
        storedEntity: entityMeta[si].entity,
        storedItemId: entityMeta[si].itemId,
        score,
      })
    }
  }

  allMatches.sort((a, b) => b.score - a.score)

  console.log('  Top 20 entity-to-entity matches:')
  for (const m of allMatches.slice(0, 20)) {
    const isSignal = SIGNAL_IDS.has(m.storedItemId)
    console.log(`    ${isSignal ? '★' : ' '} ${m.score.toFixed(4)} | case:"${m.caseEntity.surfaceText}" ↔ stored:"${m.storedEntity.surfaceText}" [${m.storedItemId}]`)
  }

  // Step 4: Aggregate by item — which items have the most/strongest entity matches?
  console.log('\nStep 4: Aggregating entity matches by item...')
  const itemScores = new Map<string, { maxScore: number; matchCount: number; totalScore: number }>()

  const ENTITY_THRESHOLD = 0.80

  for (const m of allMatches) {
    if (m.score < ENTITY_THRESHOLD) continue
    const existing = itemScores.get(m.storedItemId) ?? { maxScore: 0, matchCount: 0, totalScore: 0 }
    existing.maxScore = Math.max(existing.maxScore, m.score)
    existing.matchCount++
    existing.totalScore += m.score
    itemScores.set(m.storedItemId, existing)
  }

  const rankedItems = [...itemScores.entries()]
    .map(([id, scores]) => ({ id, ...scores }))
    .sort((a, b) => b.totalScore - a.totalScore)

  console.log(`  Items with entity matches above ${ENTITY_THRESHOLD}:`)
  for (const item of rankedItems) {
    const isSignal = SIGNAL_IDS.has(item.id)
    console.log(`    ${isSignal ? '★' : ' '} ${item.id}: ${item.matchCount} matches, max=${item.maxScore.toFixed(4)}, total=${item.totalScore.toFixed(4)}`)
  }

  // Step 5: For the top candidate items, also compute full-text embedding similarity
  console.log('\nStep 5: Full-text embedding similarity for top candidates...')
  const candidateIds = rankedItems.slice(0, 10).map(r => r.id)
  const allItemTexts = [...ITEMS, CASE_POST].map(i => normalize(i.text))
  const allItemEmbeddings = await embedBatch(client, allItemTexts, cost)
  const itemEmbMap = new Map<string, number[]>()
  const allIds = [...ITEMS, CASE_POST].map(i => i.id)
  for (let i = 0; i < allIds.length; i++) {
    itemEmbMap.set(allIds[i], allItemEmbeddings[i])
  }

  const caseEmb = itemEmbMap.get('case_post')!
  const candidateScores: Array<{ id: string; entityScore: number; embScore: number; combined: number }> = []

  for (const id of candidateIds) {
    const emb = itemEmbMap.get(id)
    if (!emb) continue
    const embScore = cosine(caseEmb, emb)
    const entityScore = itemScores.get(id)?.totalScore ?? 0
    candidateScores.push({ id, entityScore, embScore, combined: entityScore + embScore })
  }

  candidateScores.sort((a, b) => b.combined - a.combined)

  console.log('  Candidates ranked by entity_score + embedding_score:')
  for (const c of candidateScores) {
    const isSignal = SIGNAL_IDS.has(c.id)
    console.log(`    ${isSignal ? '★' : ' '} ${c.id}: entity=${c.entityScore.toFixed(3)}, emb=${c.embScore.toFixed(3)}, combined=${c.combined.toFixed(3)}`)
  }

  // ============================================================
  // EVALUATION
  // ============================================================
  console.log('\n=== EVALUATION ===')

  // H1: Do entity embeddings catch "dark green SUV possibly Subaru" ↔ "dark green Subaru Outback"?
  const vehicleMatches = allMatches.filter(m =>
    (m.caseEntity.surfaceText.toLowerCase().includes('subaru') || m.caseEntity.surfaceText.toLowerCase().includes('suv') || m.caseEntity.surfaceText.toLowerCase().includes('green')) &&
    (m.storedEntity.surfaceText.toLowerCase().includes('subaru') || m.storedEntity.surfaceText.toLowerCase().includes('outback') || m.storedEntity.surfaceText.toLowerCase().includes('green'))
  ).slice(0, 5)

  console.log('\n  H1: Vehicle entity embedding similarity (cross-phrasing)')
  for (const m of vehicleMatches) {
    console.log(`    ${m.score.toFixed(4)} | "${m.caseEntity.surfaceText}" ↔ "${m.storedEntity.surfaceText}" [${m.storedItemId}]`)
  }
  const bestVehicleMatch = vehicleMatches[0]?.score ?? 0
  const h1Pass = bestVehicleMatch > 0.85
  console.log(`  Best vehicle cross-match: ${bestVehicleMatch.toFixed(4)}`)
  console.log(`  H1: ${h1Pass ? 'PASS ✓' : 'FAIL ✗'} (need > 0.85)`)

  // H2: Do all 4 signal items appear in the entity-aggregated candidates?
  const signalInCandidates = rankedItems.filter(r => SIGNAL_IDS.has(r.id))
  const h2Pass = signalInCandidates.length >= 3
  console.log(`\n  H2: Signal items in entity-ranked candidates: ${signalInCandidates.length}/4`)
  console.log(`  H2: ${h2Pass ? 'PASS ✓' : 'FAIL ✗'} (need >= 3)`)

  // H3: Does "selling my Subaru" rank BELOW real signals?
  const sellingRank = rankedItems.findIndex(r => r.id === 'noise_selling_subaru')
  const signalRanks = rankedItems.map((r, i) => SIGNAL_IDS.has(r.id) ? i : -1).filter(i => i >= 0)
  const bestSignalRank = Math.min(...signalRanks)
  const h3Pass = sellingRank === -1 || sellingRank > bestSignalRank
  console.log(`\n  H3: "Selling Subaru" rank: ${sellingRank === -1 ? 'not in list (good)' : `#${sellingRank + 1}`}`)
  console.log(`  Best signal rank: #${bestSignalRank + 1}`)
  console.log(`  H3: ${h3Pass ? 'PASS ✓' : 'FAIL ✗'} (selling should rank below signals)`)

  // H4: After combining entity + embedding, are all 4 signals in top 5?
  const top5Combined = candidateScores.slice(0, 5).map(c => c.id)
  const signalInTop5 = top5Combined.filter(id => SIGNAL_IDS.has(id))
  const h4Pass = signalInTop5.length >= 3
  console.log(`\n  H4: Signal items in top-5 combined: ${signalInTop5.length}/4`)
  console.log(`  H4: ${h4Pass ? 'PASS ✓' : 'FAIL ✗'} (need >= 3 in top 5)`)

  // Summary
  const results = [
    { id: 'H1', name: 'Entity embedding catches cross-phrasing', pass: h1Pass },
    { id: 'H2', name: 'Signal items in entity candidates', pass: h2Pass },
    { id: 'H3', name: 'Selling Subaru ranked below signals', pass: h3Pass },
    { id: 'H4', name: 'Signals in top-5 combined', pass: h4Pass },
  ]

  console.log('\n=== RESULTS ===')
  for (const r of results) {
    console.log(`  ${r.id} (${r.name}): ${r.pass ? 'PASS ✓' : 'FAIL ✗'}`)
  }
  const passCount = results.filter(r => r.pass).length
  console.log(`\n  ${passCount}/${results.length} passed`)
  console.log(`  Total cost: $${cost.total.toFixed(4)}`)
  console.log(`\n  Verdict: ${passCount >= 3 ? 'ENTITY-EMBEDDING PIPELINE WORKS' : 'NEEDS ITERATION'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
