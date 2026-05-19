import OpenAI from 'openai'
import { StrataEngine, MemoryKVStore, cosine } from '../src/engine/index.js'
import type { RawItem, CostTracker } from '../src/engine/types.js'

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
// TEST DATA: Hit-and-run scenario
// ============================================================

const BACKFILL_EPOCH = Date.now() - 40 * 24 * 60 * 60 * 1000

function day(d: number): number {
  return BACKFILL_EPOCH + d * 24 * 60 * 60 * 1000
}

const FRAGMENT_1_NEARMISS: RawItem = {
  id: 't1_frag_nearmiss',
  type: 'comment',
  text: 'Honestly stay off Mass Ave near Central if you can. Last Tuesday around 6pm some asshole in a dark green Subaru Outback blew through the crosswalk at Prospect while I was mid-crossing. Had to jump back onto the curb. Didn\'t get the plate but the car had a cracked taillight and one of those "26.2" marathon stickers on the back window. Reported it to Cambridge PD non-emergency but they basically said without a plate there\'s nothing they can do.',
  authorId: 't2_thursdaycommuter',
  authorName: 'ThursdayCommuter',
  createdAt: day(8),
  threadRootId: 't3_bike_routes',
  parentId: 't1_some_parent_comment',
}

const FRAGMENT_2_DASHCAM: RawItem = {
  id: 't3_frag_dashcam',
  type: 'post',
  text: 'Dashcam caught a car jump the curb on Mass Ave near Central — should I report this?\n\nDriving home Tuesday evening around 6:15pm on Mass Ave heading toward Harvard Square. Right near the Prospect St intersection a dark green SUV (looked like a Subaru maybe Outback or Forester) swerved hard into the bike lane, clipped the curb, then accelerated away fast toward Inman. I have clear footage from my dashcam — you can see the car pretty well including what looks like a marathon bumper sticker. Wasn\'t sure if something happened or the driver was just wasted. Should I bother reporting this to Cambridge PD? I still have the footage saved.',
  authorId: 't2_dashcamdave',
  authorName: 'DashcamDave_617',
  createdAt: day(14),
  threadRootId: 't3_frag_dashcam',
  parentId: null,
}

const FRAGMENT_3_GARAGE: RawItem = {
  id: 't1_frag_garage',
  type: 'comment',
  text: 'Not exactly a rant but something that\'s been bugging me — someone on P3 of the Cambridgeside garage (near the elevator) has a dark green Subaru Outback that suddenly has gnarly front bumper damage and a cracked passenger headlight. Showed up maybe 2 weeks ago. The bumper is hanging off on one side. They park in the same spot every weekday morning. Part of me wonders if they hit something (someone?) and are just hoping nobody notices. I see it every morning when I park for work around 8:30. Am I being paranoid or should I say something?',
  authorId: 't2_cambridgeside',
  authorName: 'CambridgeSide_Resident',
  createdAt: day(20),
  threadRootId: 't3_parking_rant',
  parentId: 't3_parking_rant',
}

const FRAGMENT_4_EARWITNESS: RawItem = {
  id: 't3_frag_earwitness',
  type: 'post',
  text: 'What was that commotion on Mass Ave tonight?\n\nWas walking down Prospect toward Central around 6pm and heard a loud crash followed by tires screeching. By the time I got to Mass Ave there was a bicycle on the ground with the front wheel bent in half but no car and no person. A couple people were looking around confused. Someone said they saw the cyclist get up and stumble toward the CVS. Nobody seemed to have called 911 yet so I did. Ambulance showed up maybe 8 minutes later. The whole thing felt really wrong — like whoever hit them just floored it. If you were the cyclist I hope you\'re okay. This was right at the Prospect/Mass Ave intersection.',
  authorId: 't2_inmansq',
  authorName: 'InmanSq_Walker',
  createdAt: day(8),
  threadRootId: 't3_frag_earwitness',
  parentId: null,
}

const CASE_POST: RawItem = {
  id: 't3_case_post',
  type: 'post',
  text: 'My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP\n\nI don\'t know what else to do. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop.\n\nSarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out.\n\nCambridge PD case #2026-04891. If ANYONE has dashcam footage from Mass Ave near Prospect St Tuesday around 6pm, or if anyone saw ANYTHING, please contact Cambridge PD or DM me.\n\nShe doesn\'t deserve this. Someone knows something. Please.',
  authorId: 't2_sarahsroommate',
  authorName: 'SarahsRoommate2026',
  createdAt: day(33),
  threadRootId: 't3_case_post',
  parentId: null,
}

// Noise items — unrelated r/boston content
const NOISE: RawItem[] = [
  { id: 't3_noise_01', type: 'post', text: 'Best pizza in Somerville? Just moved here from NYC and looking for decent slices. Davis Square area preferred but willing to travel for good food.', authorId: 't2_n01', authorName: 'PizzaHunter', createdAt: day(1), threadRootId: 't3_noise_01', parentId: null },
  { id: 't3_noise_02', type: 'post', text: 'Red line delays again this morning. Signal problems at Park Street. Been waiting 20 minutes at Charles/MGH. Anyone know if the shuttle buses are running?', authorId: 't2_n02', authorName: 'CommuterRage', createdAt: day(2), threadRootId: 't3_noise_02', parentId: null },
  { id: 't3_noise_03', type: 'post', text: 'Found a lost dog near Jamaica Pond — brown lab mix, no collar, super friendly. Currently at my apartment in JP. Please share if you know the owner!', authorId: 't2_n03', authorName: 'DogRescuer', createdAt: day(3), threadRootId: 't3_noise_03', parentId: null },
  { id: 't3_noise_04', type: 'post', text: 'Anyone else hear the explosion in Dorchester last night around 2am? Shook my entire apartment. Cops were all over the block this morning.', authorId: 't2_n04', authorName: 'DotResident', createdAt: day(4), threadRootId: 't3_noise_04', parentId: null },
  { id: 't3_noise_05', type: 'post', text: 'Looking for a good mechanic in the Allston/Brighton area. My 2018 Civic needs brake work and I don\'t want to get ripped off at the dealer.', authorId: 't2_n05', authorName: 'AllstonDriver', createdAt: day(5), threadRootId: 't3_noise_05', parentId: null },
  { id: 't3_noise_06', type: 'post', text: 'Thinking about selling my green Subaru Outback 2019 — 45k miles, great condition. Is $22k reasonable for Boston area? Where should I list it?', authorId: 't2_n06', authorName: 'SellingMyCar', createdAt: day(6), threadRootId: 't3_noise_06', parentId: null },
  { id: 't1_noise_07', type: 'comment', text: 'The bike lanes on Mass Ave are a joke. They just painted lines and called it done. No physical barrier means cars swerve in constantly.', authorId: 't2_n07', authorName: 'BikeAdvocate', createdAt: day(7), threadRootId: 't3_bike_routes', parentId: 't3_bike_routes' },
  { id: 't1_noise_08', type: 'comment', text: 'I actually love biking through Cambridge. The separated path along the river is gorgeous in spring. Just avoid Harvard Square at rush hour.', authorId: 't2_n08', authorName: 'RiverBiker', createdAt: day(7), threadRootId: 't3_bike_routes', parentId: 't3_bike_routes' },
  { id: 't3_noise_09', type: 'post', text: 'Monthly parking rant thread — January edition. Share your horror stories. I\'ll start: someone double parked me in on Newbury for 3 hours yesterday.', authorId: 't2_n09', authorName: 'ParkingMod', createdAt: day(9), threadRootId: 't3_parking_rant', parentId: null },
  { id: 't1_noise_10', type: 'comment', text: 'The meters in the Seaport are criminal. $4.50/hour and they ticket you at 5:01. I got two tickets in one week just trying to grab lunch.', authorId: 't2_n10', authorName: 'SeaportWorker', createdAt: day(10), threadRootId: 't3_parking_rant', parentId: 't3_parking_rant' },
  { id: 't1_noise_11', type: 'comment', text: 'My neighbor keeps taking my spot in our building garage. I\'ve left three notes. Next step is talking to the landlord I guess.', authorId: 't2_n11', authorName: 'FrustratedParker', createdAt: day(11), threadRootId: 't3_parking_rant', parentId: 't3_parking_rant' },
  { id: 't3_noise_12', type: 'post', text: 'Any recommendations for a good dermatologist accepting new patients? Preferably near the Longwood medical area. Insurance is Blue Cross.', authorId: 't2_n12', authorName: 'SkinCareQ', createdAt: day(12), threadRootId: 't3_noise_12', parentId: null },
  { id: 't3_noise_13', type: 'post', text: 'Saw a coyote in my backyard in West Roxbury this morning. Should I be worried about my cats? Who do I call about this?', authorId: 't2_n13', authorName: 'WestRoxCat', createdAt: day(13), threadRootId: 't3_noise_13', parentId: null },
  { id: 't3_noise_14', type: 'post', text: 'Power outage in Back Bay — anyone else? Eversource says estimated restore at 4pm but my fridge full of groceries says otherwise.', authorId: 't2_n14', authorName: 'BackBayDark', createdAt: day(15), threadRootId: 't3_noise_14', parentId: null },
  { id: 't3_noise_15', type: 'post', text: 'Is it just me or has rent in Cambridge gone completely insane? $3200 for a 1BR in Porter Square with no laundry or parking. This is unsustainable.', authorId: 't2_n15', authorName: 'RentCrisis', createdAt: day(16), threadRootId: 't3_noise_15', parentId: null },
  { id: 't1_noise_16', type: 'comment', text: 'The Orange Line has been surprisingly reliable this week. Don\'t jinx it but I\'ve been on time every day. Something must be wrong.', authorId: 't2_n16', authorName: 'MBTAfan', createdAt: day(17), threadRootId: 't3_noise_02', parentId: 't3_noise_02' },
  { id: 't3_noise_17', type: 'post', text: 'Road rage incident on Storrow Drive — some guy in a pickup cut across three lanes and brake checked me. I have dashcam footage. Worth reporting?', authorId: 't2_n17', authorName: 'StorrowSurvivor', createdAt: day(18), threadRootId: 't3_noise_17', parentId: null },
  { id: 't3_noise_18', type: 'post', text: 'Anyone know why there were 6 cop cars on Cambridge St in Inman Square tonight? Looked serious but can\'t find anything on the news.', authorId: 't2_n18', authorName: 'InmanCurious', createdAt: day(19), threadRootId: 't3_noise_18', parentId: null },
  { id: 't3_noise_19', type: 'post', text: 'Best coffee shops to work from in Central Square? Need reliable wifi and outlets. Don\'t mind buying multiple drinks to camp out.', authorId: 't2_n19', authorName: 'RemoteWorker', createdAt: day(21), threadRootId: 't3_noise_19', parentId: null },
  { id: 't3_noise_20', type: 'post', text: 'Hit a pothole on Comm Ave near BU and blew out my tire. The crater is easily 8 inches deep. Reported to 311 but how long does that actually take?', authorId: 't2_n20', authorName: 'PotholeVictim', createdAt: day(22), threadRootId: 't3_noise_20', parentId: null },
]

// Deliberately tricky noise:
// - noise_06: someone SELLING a green Subaru Outback (entity match but UNRELATED)
// - noise_07: about Mass Ave bike lanes (location overlap but no incident)
// - noise_17: dashcam + road rage (similar theme but different location/vehicle)

const SIGNAL_IDS = new Set([
  't1_frag_nearmiss',
  't3_frag_dashcam',
  't1_frag_garage',
  't3_frag_earwitness',
])

// ============================================================
// HYPOTHESES
// ============================================================

const HYPOTHESES = [
  {
    id: 'H1',
    name: 'Entity canonical convergence',
    description: 'The registry causes "dark green SUV (Subaru maybe Outback)" to map to the same canonical as "dark green Subaru Outback"',
    criteria: 'Fragment 1, 2, and 3 share at least one vehicle entity canonical. Case post also maps to it.',
  },
  {
    id: 'H2',
    name: 'findByIdentifier retrieves fragments by entity',
    description: 'Entity index lookup from the case post finds at least 2 of the 3 entity-bearing fragments',
    criteria: 'findByIdentifier(casePost) returns at least 2 of [frag_nearmiss, frag_dashcam, frag_garage]',
  },
  {
    id: 'H3',
    name: 'findSimilar ranks signal above noise',
    description: 'Embedding similarity ranks signal fragments higher than noise (including tricky noise)',
    criteria: 'In top-10 of findSimilar(casePost), at least 3 of the 4 signal fragments appear. noise_06 (selling Subaru) is NOT in top-5.',
  },
  {
    id: 'H4',
    name: 'findConnections finds all 4 fragments',
    description: 'The merged retrieval (entity + embedding) returns all 4 signal fragments in top-10',
    criteria: 'All 4 signal IDs appear in findConnections(casePost, 10)',
  },
  {
    id: 'H5',
    name: 'Classification produces meaningful relationships',
    description: 'LLM classifies the signal pairs as related (not UNRELATED)',
    criteria: 'classifyRelationship(casePost, fragment) returns CONFIRMS|UPDATES|TEMPORAL for at least 3 of 4 fragments. Returns UNRELATED for noise_06 (selling Subaru).',
  },
]

// ============================================================
// RUN
// ============================================================

async function main() {
  const cost = new SimpleCost()
  const store = new MemoryKVStore()
  const engine = new StrataEngine(store, client, cost)

  console.log('=== Strata Hit-and-Run Validation ===\n')
  console.log('Hypotheses:')
  for (const h of HYPOTHESES) {
    console.log(`  ${h.id}: ${h.name}`)
    console.log(`      ${h.criteria}\n`)
  }

  // --- Ingest backfill (noise + fragments) ---
  const backfillItems = [...NOISE, FRAGMENT_1_NEARMISS, FRAGMENT_2_DASHCAM, FRAGMENT_3_GARAGE, FRAGMENT_4_EARWITNESS]
  console.log(`\nIngesting ${backfillItems.length} backfill items...`)
  await engine.ingestBatch(backfillItems)
  console.log(`  Done. Cost so far: $${cost.total.toFixed(4)}`)

  // --- Ingest case post (live, uses existing registry) ---
  console.log(`\nIngesting case post (live mode)...`)
  const caseItem = await engine.ingest(CASE_POST)
  console.log(`  Done. Cost so far: $${cost.total.toFixed(4)}`)

  // ============================================================
  // H1: Entity canonical convergence
  // ============================================================
  console.log('\n--- H1: Entity canonical convergence ---')
  const frag1 = await engine.getItem(FRAGMENT_1_NEARMISS.id)
  const frag2 = await engine.getItem(FRAGMENT_2_DASHCAM.id)
  const frag3 = await engine.getItem(FRAGMENT_3_GARAGE.id)
  const frag4 = await engine.getItem(FRAGMENT_4_EARWITNESS.id)

  const vehicleCanonicals = new Map<string, string[]>()
  for (const [label, item] of [['frag1', frag1], ['frag2', frag2], ['frag3', frag3], ['case', caseItem]] as const) {
    if (!item) continue
    const vehicles = item.entities.filter(e => e.type === 'vehicle' || e.type === 'product')
    vehicleCanonicals.set(label, vehicles.map(v => v.canonical))
    console.log(`  ${label} vehicle entities: ${vehicles.map(v => `${v.type}:${v.canonical}`).join(', ') || '(none)'}`)
  }

  const allCanonicals = [...vehicleCanonicals.values()].flat()
  const canonicalCounts = new Map<string, number>()
  for (const c of allCanonicals) {
    canonicalCounts.set(c, (canonicalCounts.get(c) ?? 0) + 1)
  }
  const sharedCanonical = [...canonicalCounts.entries()].find(([_, count]) => count >= 3)
  const h1Pass = !!sharedCanonical
  console.log(`  Shared canonical (3+ items): ${sharedCanonical ? `${sharedCanonical[0]} (${sharedCanonical[1]} items)` : 'NONE'}`)
  console.log(`  H1: ${h1Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // H2: findByIdentifier retrieves fragments
  // ============================================================
  console.log('\n--- H2: findByIdentifier retrieves fragments ---')
  const identifierHits = await engine.findByIdentifier(caseItem)
  const identifierIds = identifierHits.map(h => h.item.id)
  console.log(`  Hits: ${identifierHits.length}`)
  for (const hit of identifierHits.slice(0, 10)) {
    const isSignal = SIGNAL_IDS.has(hit.item.id)
    console.log(`    ${isSignal ? '★' : ' '} ${hit.item.id} — matched: ${hit.matchedEntity.type}:${hit.matchedEntity.canonical}`)
  }
  const h2SignalHits = identifierIds.filter(id => id === FRAGMENT_1_NEARMISS.id || id === FRAGMENT_2_DASHCAM.id || id === FRAGMENT_3_GARAGE.id)
  const h2Pass = h2SignalHits.length >= 2
  console.log(`  Signal fragments found: ${h2SignalHits.length}/3`)
  console.log(`  H2: ${h2Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // H3: findSimilar ranks signal above noise
  // ============================================================
  console.log('\n--- H3: findSimilar ranks signal above noise ---')
  const similarHits = await engine.findSimilar(caseItem.embedding, 10, { excludeIds: new Set([CASE_POST.id]) })
  console.log(`  Top 10 by embedding similarity:`)
  for (let i = 0; i < similarHits.length; i++) {
    const hit = similarHits[i]
    const isSignal = SIGNAL_IDS.has(hit.item.id)
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} ${hit.item.id} (${hit.weight.toFixed(4)})`)
  }
  const top10Ids = similarHits.map(h => h.item.id)
  const signalInTop10 = [...SIGNAL_IDS].filter(id => top10Ids.includes(id))
  const sellingSubaruInTop5 = similarHits.slice(0, 5).some(h => h.item.id === 't3_noise_06')
  const h3Pass = signalInTop10.length >= 3 && !sellingSubaruInTop5
  console.log(`  Signal in top-10: ${signalInTop10.length}/4`)
  console.log(`  "Selling Subaru" in top-5: ${sellingSubaruInTop5 ? 'YES (bad)' : 'NO (good)'}`)
  console.log(`  H3: ${h3Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // H4: findConnections finds all 4 fragments
  // ============================================================
  console.log('\n--- H4: findConnections finds all 4 ---')
  const connections = await engine.findConnections(caseItem, 10)
  console.log(`  Connections returned: ${connections.length}`)
  for (let i = 0; i < connections.length; i++) {
    const conn = connections[i]
    const isSignal = SIGNAL_IDS.has(conn.item.id)
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} ${conn.item.id} — mode: ${conn.mode}, weight: ${conn.weight.toFixed(4)}${conn.matchedEntity ? `, entity: ${conn.matchedEntity.type}:${conn.matchedEntity.canonical}` : ''}`)
  }
  const connectionIds = connections.map(c => c.item.id)
  const allSignalFound = [...SIGNAL_IDS].every(id => connectionIds.includes(id))
  const h4Pass = allSignalFound
  console.log(`  All 4 signal fragments in results: ${allSignalFound}`)
  console.log(`  H4: ${h4Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // H5: Classification produces meaningful relationships
  // ============================================================
  console.log('\n--- H5: Classification ---')
  const classifyTargets = [
    { label: 'near-miss', item: frag1 },
    { label: 'dashcam', item: frag2 },
    { label: 'garage', item: frag3 },
    { label: 'earwitness', item: frag4 },
    { label: 'selling-subaru (should be UNRELATED)', item: await engine.getItem('t3_noise_06') },
  ]

  let relatedCount = 0
  let sellingSubaruUnrelated = false

  for (const { label, item } of classifyTargets) {
    if (!item) { console.log(`    ${label}: SKIP (not found)`); continue }
    const rel = await engine.classifyRelationship(caseItem, item)
    const isRelated = rel !== 'UNRELATED'
    if (label.includes('selling')) {
      sellingSubaruUnrelated = !isRelated
    } else if (isRelated) {
      relatedCount++
    }
    console.log(`    ${label}: ${rel} ${isRelated && !label.includes('selling') ? '✓' : !isRelated && label.includes('selling') ? '✓' : '✗'}`)
  }

  const h5Pass = relatedCount >= 3 && sellingSubaruUnrelated
  console.log(`  Related signal fragments: ${relatedCount}/4`)
  console.log(`  "Selling Subaru" classified UNRELATED: ${sellingSubaruUnrelated}`)
  console.log(`  H5: ${h5Pass ? 'PASS ✓' : 'FAIL ✗'}`)

  // ============================================================
  // SUMMARY
  // ============================================================
  const results = [
    { id: 'H1', pass: h1Pass },
    { id: 'H2', pass: h2Pass },
    { id: 'H3', pass: h3Pass },
    { id: 'H4', pass: h4Pass },
    { id: 'H5', pass: h5Pass },
  ]

  console.log('\n=== RESULTS ===')
  for (const r of results) {
    console.log(`  ${r.id}: ${r.pass ? 'PASS ✓' : 'FAIL ✗'}`)
  }
  const passCount = results.filter(r => r.pass).length
  console.log(`\n  ${passCount}/${results.length} passed`)
  console.log(`  Total cost: $${cost.total.toFixed(4)}`)
  console.log(`  Verdict: ${passCount >= 4 ? 'ARCHITECTURE VALIDATED' : passCount >= 3 ? 'MOSTLY WORKS — review failures' : 'NEEDS REWORK'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
