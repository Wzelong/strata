import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'
import { embedBatch, cosine } from '../src/engine/embed.js'
import type { Entity, CostTracker } from '../src/engine/types.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = resolve(__dirname, '..', 'dataset', 'seed.json')

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

// ============================================================
// DEMO ITEMS — designed to showcase hybrid retrieval
//
// Case post: Hit-and-run on Mass Ave, cyclist hit by dark green SUV
//
// Each fragment is BURIED in a completely different context.
// A human skimming wouldn't connect them. The architecture should.
//
// Design principle: each fragment tests a different retrieval pathway.
// ============================================================

const CASE_POST = {
  id: 'case_post',
  text: `My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP

I don't know what else to do. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop.

Sarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out.

Cambridge PD case #2026-04891. If ANYONE has dashcam footage from Mass Ave near Prospect St Tuesday around 6pm, or if anyone saw ANYTHING, please contact Cambridge PD or DM me.

She doesn't deserve this. Someone knows something. Please.`,
}

const FRAGMENTS = [
  {
    id: 'frag_parking_rant',
    text: `Monthly parking rant thread — February edition. Here's mine: whoever parks the dark green Subaru Outback on P3 of the Cambridgeside garage every morning, your front bumper is literally hanging off on one side and your headlight is cracked. It's been like that for two weeks now. You're scraping the pillar next to you every time you pull in. Fix your car or park somewhere else. Also it has one of those marathon "26.2" stickers on the back window — I see you running in the mornings, you clearly have your life together otherwise, so what happened?`,
    expected_pathway: 'ENTITY FILTER — "dark green Subaru Outback" + "bumper hanging off" + "26.2 sticker" are strong object entities. But the post is about PARKING, not a hit-and-run. Full-text cosine to case post should be low.',
    should_beat_baseline: true,
  },
  {
    id: 'frag_dashcam_advice',
    text: `Should I bother reporting dashcam footage to Cambridge PD?

Driving home Tuesday evening around 6:15pm on Mass Ave heading toward Harvard Square. Near Prospect St a dark green SUV swerved hard into the bike lane, clipped the curb, then accelerated away toward Inman. My dashcam caught the whole thing pretty clearly including what looks like a bumper sticker on the rear window. Wasn't sure if anything actually happened or if the driver was just drunk. Is it worth the hassle of calling it in? I still have the footage.`,
    expected_pathway: 'BOTH — strong entity overlap ("dark green SUV", "dashcam") AND strong narrative overlap (Mass Ave, Tuesday, Prospect St, reporting to police). This should be easy for both methods.',
    should_beat_baseline: false,
  },
  {
    id: 'frag_near_miss',
    text: `Cycling safety thread: what's your worst near-miss?

Mine was last Tuesday around 6pm — some SUV blew through the crosswalk at Prospect while I was mid-crossing on my bike. Had to bail onto the curb. Dark green, looked like one of those Subaru wagons. Cracked taillight on the rear. Reported it to Cambridge PD non-emergency but they said without a plate there's nothing they can do. Honestly I'm just glad I wasn't in the bike lane when it happened or I'd probably be in the hospital.`,
    expected_pathway: 'BOTH — entity overlap ("dark green" + "Subaru" + "cracked taillight") AND narrative overlap (cycling safety, near-miss, Tuesday 6pm). Baseline should find this too.',
    should_beat_baseline: false,
  },
  {
    id: 'frag_commotion',
    text: `What was that commotion on Mass Ave tonight?

Was walking toward Central around 6pm and heard a loud crash followed by tires screeching. By the time I got to the intersection there was a bicycle on the ground with the front wheel bent and a couple people standing around looking confused. Someone said the cyclist stumbled toward the CVS. Nobody seemed to have called 911 yet so I did. Ambulance showed up maybe 8 minutes later. The whole thing felt wrong — like whoever hit them just floored it.`,
    expected_pathway: 'SAFETY NET — no vehicle description, no object entities of value. Pure narrative overlap with the case post (crash, cyclist, Mass Ave, 6pm, fled). Entity filter will MISS this.',
    should_beat_baseline: false,
  },
  {
    id: 'frag_night_shift',
    text: `Night Shift Brewing recommendation thread:

Great taproom, walkable from Lechmere. My roommate TK and I usually hit it on Tuesdays after his shift. We park on P3 at Cambridgeside — never had issues finding a spot in the evening. He drives a green Outback so we always joke about finding it in the sea of white Teslas. Last week he came home late saying he "hit something in the road" and now there's damage on his front end that he won't explain. Starting to wonder if I should be concerned.`,
    expected_pathway: 'ENTITY FILTER — "green Outback" + "P3 at Cambridgeside" + "damage on his front end" are object/location entities. But the post is about a BREWERY RECOMMENDATION. Full-text cosine to a hit-and-run plea should be low.',
    should_beat_baseline: true,
  },
  {
    id: 'frag_auto_body',
    text: `Anyone know a discreet auto body shop in Cambridge?

Asking for a friend (yes really). He needs front bumper work done on his Subaru — the whole driver side is scraped up and the headlight housing is cracked. He's being weird about not wanting to go through insurance. Said something about "not wanting a record of it." The car is dark green if that matters for paint matching. Trying to get it done ASAP, like within the week. Cash preferred. DM me if you know a place that won't ask questions.`,
    expected_pathway: 'ENTITY FILTER — "front bumper work" + "Subaru" + "dark green" + "headlight cracked" + "not wanting a record" are strong object entities matching the suspect vehicle. Topic is AUTO REPAIR, not a crime. Full-text cosine should be moderate at best.',
    should_beat_baseline: true,
  },
]

const SIGNAL_IDS = new Set(FRAGMENTS.map(f => f.id))
const ENTITY_ONLY_IDS = new Set(FRAGMENTS.filter(f => f.should_beat_baseline).map(f => f.id))

async function main() {
  const cost = new SimpleCost()
  console.log('=== Demo Items Validation: Baseline vs Hybrid ===\n')

  // Load 3K seed for realistic noise
  console.log('Loading seed.json for noise corpus...')
  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: Array<{ id: string; text: string; entities: Entity[] }>
    embeddings: Record<string, number[]>
  }
  const seedEmbById = new Map<string, number[]>(Object.entries(seed.embeddings))
  console.log(`  ${seed.items.length} noise items loaded`)

  // Embed everything
  console.log('\nEmbedding case post + fragments...')
  const allTexts = [normalize(CASE_POST.text), ...FRAGMENTS.map(f => normalize(f.text))]
  const allEmbs = await embedBatch(client, allTexts, cost)
  const caseEmb = allEmbs[0]
  const fragEmbs = new Map<string, number[]>()
  for (let i = 0; i < FRAGMENTS.length; i++) {
    fragEmbs.set(FRAGMENTS[i].id, allEmbs[i + 1])
  }

  // Extract entities from case post + fragments
  console.log('Extracting entities...')
  const caseEntities = await extractEntities(client, normalize(CASE_POST.text), cost)
  const fragEntities = new Map<string, Entity[]>()
  for (const frag of FRAGMENTS) {
    const ents = await extractEntities(client, normalize(frag.text), cost)
    fragEntities.set(frag.id, ents)
  }

  console.log(`\n  Case post entities (${caseEntities.length}):`)
  for (const e of caseEntities) console.log(`    ${e.type}: "${e.surfaceText}"`)

  // Embed case entity surfaceTexts
  const caseEntityTexts = caseEntities.map(e => e.surfaceText)
  const caseEntityEmbs = await embedBatch(client, caseEntityTexts, cost)

  // Build entity index from fragments + seed
  console.log('\nBuilding entity embedding index...')
  type Entry = { surfaceText: string; embedding: number[]; itemId: string }
  const typeIndex = new Map<string, Entry[]>()

  // Fragment entities
  const fragEntityTexts: string[] = []
  const fragEntityMeta: Array<{ type: string; surfaceText: string; itemId: string }> = []
  for (const frag of FRAGMENTS) {
    for (const e of fragEntities.get(frag.id)!) {
      fragEntityTexts.push(e.surfaceText)
      fragEntityMeta.push({ type: e.type, surfaceText: e.surfaceText, itemId: frag.id })
    }
  }
  // Seed entities
  for (const item of seed.items) {
    for (const e of item.entities) {
      fragEntityTexts.push(e.surfaceText)
      fragEntityMeta.push({ type: e.type, surfaceText: e.surfaceText, itemId: item.id })
    }
  }

  const entityEmbs = await embedBatch(client, fragEntityTexts, cost)
  for (let i = 0; i < fragEntityMeta.length; i++) {
    const { type, surfaceText, itemId } = fragEntityMeta[i]
    if (!typeIndex.has(type)) typeIndex.set(type, [])
    typeIndex.get(type)!.push({ surfaceText, embedding: entityEmbs[i], itemId })
  }

  // Hub detection (per-type)
  const entityItemCount = new Map<string, Set<string>>()
  for (const [type, entries] of typeIndex) {
    for (const entry of entries) {
      const key = `${type}:${entry.surfaceText.toLowerCase()}`
      if (!entityItemCount.has(key)) entityItemCount.set(key, new Set())
      entityItemCount.get(key)!.add(entry.itemId)
    }
  }
  const itemsPerType = new Map<string, number>()
  for (const [type, entries] of typeIndex) {
    itemsPerType.set(type, new Set(entries.map(e => e.itemId)).size)
  }
  const hubEntities = new Set<string>()
  for (const [key, items] of entityItemCount) {
    const type = key.split(':')[0]
    const typeTotal = itemsPerType.get(type) ?? 1
    if (items.size / typeTotal > 0.03 && items.size >= 10) hubEntities.add(key)
  }
  function isHub(type: string, surfaceText: string): boolean {
    return hubEntities.has(`${type}:${surfaceText.toLowerCase()}`)
  }
  console.log(`  ${hubEntities.size} hub entities suppressed`)

  // ============================================================
  // BASELINE: Full-text cosine (scan all items)
  // ============================================================
  console.log('\n=== BASELINE: Full-text cosine ===\n')
  const allItemIds = [...fragEmbs.keys(), ...seedEmbById.keys()]
  const baselineScores = allItemIds.map(id => ({
    id,
    score: cosine(caseEmb, fragEmbs.get(id) ?? seedEmbById.get(id)!),
  }))
  baselineScores.sort((a, b) => b.score - a.score)
  const baselineRanking = baselineScores.map(s => s.id)

  console.log('  Top 15:')
  for (let i = 0; i < 15; i++) {
    const s = baselineScores[i]
    const isSignal = SIGNAL_IDS.has(s.id)
    const frag = FRAGMENTS.find(f => f.id === s.id)
    const label = frag ? frag.id : seed.items.find(it => it.id === s.id)?.text.slice(0, 50) ?? s.id
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} (${s.score.toFixed(4)}) ${label}`)
  }

  // ============================================================
  // HYBRID: Entity filter (strong types, top-30) + safety net (top-20)
  // ============================================================
  console.log('\n=== HYBRID: Entity filter + safety net ===\n')

  const STRONG_TYPES = new Set(['object', 'username', 'phone', 'email', 'url'])
  const FILTER_K = 30
  const SAFETY_K = 20

  // Entity filter
  const entityCandidates = new Set<string>()
  for (let ci = 0; ci < caseEntities.length; ci++) {
    const ce = caseEntities[ci]
    if (!STRONG_TYPES.has(ce.type)) continue
    if (isHub(ce.type, ce.surfaceText)) continue
    const bucket = typeIndex.get(ce.type)
    if (!bucket) continue

    const scored = bucket
      .filter(e => !isHub(ce.type, e.surfaceText))
      .map(e => ({ itemId: e.itemId, sim: cosine(caseEntityEmbs[ci], e.embedding) }))
    scored.sort((a, b) => b.sim - a.sim)
    for (const s of scored.slice(0, FILTER_K)) entityCandidates.add(s.itemId)
  }

  // Safety net
  const safetyScores = allItemIds.map(id => ({
    id,
    score: cosine(caseEmb, fragEmbs.get(id) ?? seedEmbById.get(id)!),
  }))
  safetyScores.sort((a, b) => b.score - a.score)
  const safetyNetIds = new Set(safetyScores.slice(0, SAFETY_K).map(s => s.id))

  // Union
  const hybridCandidates = new Set([...entityCandidates, ...safetyNetIds])

  // Rerank by full-text cosine
  const hybridScores = [...hybridCandidates].map(id => ({
    id,
    score: cosine(caseEmb, fragEmbs.get(id) ?? seedEmbById.get(id)!),
    via: entityCandidates.has(id) && safetyNetIds.has(id) ? 'both' :
         entityCandidates.has(id) ? 'entity' : 'safety',
  }))
  hybridScores.sort((a, b) => b.score - a.score)
  const hybridRanking = hybridScores.map(s => s.id)

  console.log('  Top 15:')
  for (let i = 0; i < 15; i++) {
    const s = hybridScores[i]
    const isSignal = SIGNAL_IDS.has(s.id)
    const frag = FRAGMENTS.find(f => f.id === s.id)
    const label = frag ? frag.id : seed.items.find(it => it.id === s.id)?.text.slice(0, 50) ?? s.id
    console.log(`    ${i + 1}. ${isSignal ? '★' : ' '} (${s.score.toFixed(4)}, ${s.via}) ${label}`)
  }

  // ============================================================
  // EVALUATION
  // ============================================================
  console.log('\n=== EVALUATION ===\n')

  console.log('  Fragment rankings:')
  console.log('  Fragment            | Baseline | Hybrid | Entity? | Safety? | Expected pathway')
  console.log('  --------------------|----------|--------|---------|---------|------------------')
  for (const frag of FRAGMENTS) {
    const bRank = baselineRanking.indexOf(frag.id) + 1
    const hRank = hybridRanking.indexOf(frag.id) + 1 || '-'
    const inEntity = entityCandidates.has(frag.id) ? 'Y' : 'N'
    const inSafety = safetyNetIds.has(frag.id) ? 'Y' : 'N'
    const pathway = frag.expected_pathway.split(' — ')[0]
    console.log(`  ${frag.id.padEnd(20)}| ${String(bRank).padStart(8)} | ${String(hRank).padStart(6)} | ${inEntity.padStart(7)} | ${inSafety.padStart(7)} | ${pathway}`)
  }

  // Key metrics
  const baseP5 = baselineRanking.slice(0, 5).filter(id => SIGNAL_IDS.has(id)).length / 5
  const baseP10 = baselineRanking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / 10
  const baseR10 = baselineRanking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / SIGNAL_IDS.size

  const hybridP5 = hybridRanking.slice(0, 5).filter(id => SIGNAL_IDS.has(id)).length / 5
  const hybridP10 = hybridRanking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / 10
  const hybridR10 = hybridRanking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / SIGNAL_IDS.size

  console.log('\n  Metrics:')
  console.log(`                | Baseline | Hybrid`)
  console.log(`  P@5           | ${baseP5.toFixed(2)}     | ${hybridP5.toFixed(2)}`)
  console.log(`  P@10          | ${baseP10.toFixed(2)}     | ${hybridP10.toFixed(2)}`)
  console.log(`  R@10          | ${baseR10.toFixed(2)}     | ${hybridR10.toFixed(2)}`)
  console.log(`  Candidates    | ${allItemIds.length}     | ${hybridCandidates.size} (${((hybridCandidates.size / allItemIds.length) * 100).toFixed(1)}%)`)

  // Did entity-only items get found that baseline missed in top-10?
  const entityOnlyInBaseline10 = [...ENTITY_ONLY_IDS].filter(id => baselineRanking.indexOf(id) < 10)
  const entityOnlyInHybrid10 = [...ENTITY_ONLY_IDS].filter(id => hybridRanking.indexOf(id) < 10)

  console.log(`\n  Entity-dependent fragments (should_beat_baseline=true):`)
  console.log(`    Found in baseline top-10: ${entityOnlyInBaseline10.length}/${ENTITY_ONLY_IDS.size}`)
  console.log(`    Found in hybrid top-10: ${entityOnlyInHybrid10.length}/${ENTITY_ONLY_IDS.size}`)

  // Success conditions
  const c1 = hybridR10 >= baseR10
  const c2 = hybridP5 >= baseP5
  const c3 = entityOnlyInHybrid10.length > entityOnlyInBaseline10.length
  const c4 = hybridCandidates.size / allItemIds.length < 0.15

  console.log('\n  Conditions:')
  console.log(`  C1 (hybrid R@10 >= baseline): ${c1 ? 'PASS' : 'FAIL'}`)
  console.log(`  C2 (hybrid P@5 >= baseline): ${c2 ? 'PASS' : 'FAIL'}`)
  console.log(`  C3 (hybrid finds more entity-dependent frags in top-10): ${c3 ? 'PASS' : 'FAIL'}`)
  console.log(`  C4 (candidate set < 15% of corpus): ${c4 ? 'PASS' : 'FAIL'}`)

  const passCount = [c1, c2, c3, c4].filter(Boolean).length
  console.log(`\n  ${passCount}/4 passed`)
  console.log(`  Cost: $${cost.total.toFixed(4)}`)
  console.log(`  Verdict: ${passCount >= 4 ? 'DEMO ITEMS VALIDATED' : passCount >= 3 ? 'MOSTLY WORKS' : 'RETHINK ITEMS'}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
