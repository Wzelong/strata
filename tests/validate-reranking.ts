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
// REDESIGNED DEMO FRAGMENTS
//
// Key design constraint: fragments that entity filter MUST find
// but full-text cosine CANNOT rank highly.
//
// Strategy: bury the connecting entity in a post about a
// completely different topic. Minimize shared vocabulary with
// the case post.
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
    id: 'frag_garage_parking',
    text: `Monthly garage rant — who else is sick of P3 at Cambridgeside? Every morning the same green Outback with a marathon sticker takes two spots because the front bumper is dangling off one side. Been like that for weeks. Management won't do anything. At this point I'm leaving a note on the windshield.`,
    design: 'Entity-only: "green Outback" + "marathon sticker" + "front bumper dangling". Topic is PARKING COMPLAINTS. Zero overlap with hit-and-run narrative.',
  },
  {
    id: 'frag_body_shop',
    text: `Cash-only auto body recommendations? Need discreet bumper/headlight repair on a dark green Subaru. Front driver side. My buddy doesn't want to go through insurance — long story. Needs it done fast, like this week. Prefer a shop that doesn't ask too many questions. DM me.`,
    design: "Entity-only: dark green Subaru + bumper/headlight repair + no insurance. Topic is AUTO REPAIR REQUEST.",
  },
  {
    id: 'frag_running_club',
    text: `Tuesday evening running club recap — great turnout this week! 12 of us did the loop around the river. Afterwards a few of us grabbed beers at Night Shift. TK gave us all a ride home in his Outback (green, impossible to miss in a parking lot lol). He was complaining about hitting a pothole last week that messed up his front end. Dude needs to get that fixed, the bumper is held on with zip ties at this point.`,
    design: 'Entity-only: "Outback (green)" + "messed up his front end" + "bumper held on with zip ties" + "Tuesday evening". Topic is RUNNING CLUB SOCIAL RECAP.',
  },
  {
    id: 'frag_earwitness',
    text: `Did anyone else hear that horrible screeching sound around dinnertime? I was eating at the Thai place on the corner and we all froze. Then someone ran in saying a person was lying in the road and someone drove off. By the time I got outside there were already people helping. Scary stuff. Hope whoever it was is ok.`,
    design: 'Safety-net-only: Zero identifiable objects matching the case. Pure narrative of witnessing aftermath. No location names, no vehicle description.',
  },
  {
    id: 'frag_dashcam_forum',
    text: `Dashcam question — do Cambridge police actually follow up on footage submissions? I captured something sketchy last Tuesday around 6:15pm near Central. A dark green SUV running a red and swerving into a bike lane. Have clear video of the rear — there's a marathon sticker on the back window. Worth the hassle of going to the station?`,
    design: 'Both pathways: Strong entity overlap ("dark green SUV" + "marathon sticker" + "dashcam") AND moderate narrative overlap (police, footage, Tuesday). Should be easy for both methods.',
  },
  {
    id: 'frag_insurance_fraud',
    text: `Is it normal for someone to refuse to file an insurance claim after major body damage? My neighbor's dark green Subaru Outback showed up two weeks ago with the entire front end smashed — bumper hanging off, headlight shattered. He parks it in our shared garage and hasn't fixed it. When I asked what happened he got super defensive and said it was "just a curb." That's not curb damage. Starting to think something else happened.`,
    design: 'Entity-only: "dark green Subaru Outback" + "front end smashed" + "bumper hanging off" + "headlight shattered". Topic is NEIGHBOR DRAMA / INSURANCE. No traffic, cycling, or accident scene vocabulary.',
  },
]

const SIGNAL_IDS = new Set(FRAGMENTS.map(f => f.id))
const ENTITY_DEPENDENT = new Set(['frag_garage_parking', 'frag_body_shop', 'frag_running_club', 'frag_insurance_fraud'])
const SAFETY_DEPENDENT = new Set(['frag_earwitness'])

// ============================================================
// RERANKING HYPOTHESES
//
// H1: Pure full-text cosine (current baseline)
// H2: Entity score as tiebreaker (full-text first, entity breaks ties within 0.05)
// H3: Max of (full-text, entity-score) — whichever pathway found it better
// H4: Weighted blend: 0.6 * full_text + 0.4 * entity_score (for entity-found items)
// H5: Two-tier: entity-found items get minimum rank guarantee (floor at position 15)
// ============================================================

async function main() {
  const cost = new SimpleCost()
  console.log('=== Reranking Strategy Validation ===\n')

  const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
    items: Array<{ id: string; text: string; entities: Entity[] }>
    embeddings: Record<string, number[]>
  }
  const seedEmbById = new Map<string, number[]>(Object.entries(seed.embeddings))
  console.log(`  ${seed.items.length} noise items`)

  // Embed + extract
  console.log('Embedding + extracting...')
  const allTexts = [normalize(CASE_POST.text), ...FRAGMENTS.map(f => normalize(f.text))]
  const allEmbs = await embedBatch(client, allTexts, cost)
  const caseEmb = allEmbs[0]
  const fragEmbs = new Map<string, number[]>()
  for (let i = 0; i < FRAGMENTS.length; i++) fragEmbs.set(FRAGMENTS[i].id, allEmbs[i + 1])

  const caseEntities = await extractEntities(client, normalize(CASE_POST.text), cost)
  const fragEntities = new Map<string, Entity[]>()
  for (const frag of FRAGMENTS) {
    fragEntities.set(frag.id, await extractEntities(client, normalize(frag.text), cost))
  }

  const caseEntityEmbs = await embedBatch(client, caseEntities.map(e => e.surfaceText), cost)

  // Build entity index
  console.log('Building entity index...')
  type Entry = { surfaceText: string; embedding: number[]; itemId: string }
  const typeIndex = new Map<string, Entry[]>()

  const allEntityTexts: string[] = []
  const allEntityMeta: Array<{ type: string; surfaceText: string; itemId: string }> = []
  for (const frag of FRAGMENTS) {
    for (const e of fragEntities.get(frag.id)!) {
      allEntityTexts.push(e.surfaceText)
      allEntityMeta.push({ type: e.type, surfaceText: e.surfaceText, itemId: frag.id })
    }
  }
  for (const item of seed.items) {
    for (const e of item.entities) {
      allEntityTexts.push(e.surfaceText)
      allEntityMeta.push({ type: e.type, surfaceText: e.surfaceText, itemId: item.id })
    }
  }
  const entityEmbs = await embedBatch(client, allEntityTexts, cost)
  for (let i = 0; i < allEntityMeta.length; i++) {
    const { type, surfaceText, itemId } = allEntityMeta[i]
    if (!typeIndex.has(type)) typeIndex.set(type, [])
    typeIndex.get(type)!.push({ surfaceText, embedding: entityEmbs[i], itemId })
  }

  // Hub detection
  const entityItemCount = new Map<string, Set<string>>()
  for (const [type, entries] of typeIndex) {
    for (const entry of entries) {
      const key = `${type}:${entry.surfaceText.toLowerCase()}`
      if (!entityItemCount.has(key)) entityItemCount.set(key, new Set())
      entityItemCount.get(key)!.add(entry.itemId)
    }
  }
  const itemsPerType = new Map<string, number>()
  for (const [type, entries] of typeIndex) itemsPerType.set(type, new Set(entries.map(e => e.itemId)).size)
  const hubEntities = new Set<string>()
  for (const [key, items] of entityItemCount) {
    const type = key.split(':')[0]
    if (items.size / (itemsPerType.get(type) ?? 1) > 0.03 && items.size >= 10) hubEntities.add(key)
  }
  function isHub(type: string, surfaceText: string): boolean {
    return hubEntities.has(`${type}:${surfaceText.toLowerCase()}`)
  }

  // --- RETRIEVAL ---
  const STRONG_TYPES = new Set(['object', 'username', 'phone', 'email', 'url'])
  const allItemIds = [...fragEmbs.keys(), ...seedEmbById.keys()]

  // Entity filter
  const entityCandidates = new Set<string>()
  const entityScoreMap = new Map<string, number>() // best entity sim per item

  for (let ci = 0; ci < caseEntities.length; ci++) {
    const ce = caseEntities[ci]
    if (!STRONG_TYPES.has(ce.type)) continue
    if (isHub(ce.type, ce.surfaceText)) continue
    const bucket = typeIndex.get(ce.type)
    if (!bucket) continue

    for (const entry of bucket) {
      if (isHub(ce.type, entry.surfaceText)) continue
      const sim = cosine(caseEntityEmbs[ci], entry.embedding)
      const current = entityScoreMap.get(entry.itemId) ?? 0
      if (sim > current) entityScoreMap.set(entry.itemId, sim)
    }
  }

  // Take top-30 per entity type (simplified: just take top items by entity score)
  const entitySorted = [...entityScoreMap.entries()].sort((a, b) => b[1] - a[1])
  for (const [id] of entitySorted.slice(0, 200)) entityCandidates.add(id)

  // Safety net (full-text top-20)
  const fullTextScores = new Map<string, number>()
  for (const id of allItemIds) {
    fullTextScores.set(id, cosine(caseEmb, fragEmbs.get(id) ?? seedEmbById.get(id)!))
  }
  const safetyNet = [...fullTextScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  const safetyNetIds = new Set(safetyNet.map(([id]) => id))

  // Union
  const hybridPool = new Set([...entityCandidates, ...safetyNetIds])

  console.log(`\n  Entity candidates: ${entityCandidates.size}`)
  console.log(`  Safety net: ${safetyNetIds.size}`)
  console.log(`  Hybrid pool: ${hybridPool.size}`)
  console.log(`  Signal in entity candidates: ${[...SIGNAL_IDS].filter(id => entityCandidates.has(id)).join(', ')}`)
  console.log(`  Signal in safety net: ${[...SIGNAL_IDS].filter(id => safetyNetIds.has(id)).join(', ')}`)

  // --- RERANKING STRATEGIES ---
  type Scored = { id: string; score: number }

  function rank(scored: Scored[]): string[] {
    return [...scored].sort((a, b) => b.score - a.score).map(s => s.id)
  }

  const poolItems = [...hybridPool]

  // H1: Pure full-text cosine
  const h1 = rank(poolItems.map(id => ({ id, score: fullTextScores.get(id)! })))

  // H2: Full-text + entity tiebreaker (within 0.05 band, sort by entity score)
  const h2 = rank(poolItems.map(id => {
    const ft = fullTextScores.get(id)!
    const es = entityScoreMap.get(id) ?? 0
    return { id, score: ft + es * 0.001 } // tiny entity nudge for ties
  }))

  // H3: Max of (full-text, entity_score * 0.7)
  const h3 = rank(poolItems.map(id => {
    const ft = fullTextScores.get(id)!
    const es = entityScoreMap.get(id) ?? 0
    return { id, score: Math.max(ft, es * 0.7) }
  }))

  // H4: Weighted blend for entity-found items
  const h4 = rank(poolItems.map(id => {
    const ft = fullTextScores.get(id)!
    const es = entityScoreMap.get(id) ?? 0
    if (entityCandidates.has(id) && es > 0.5) {
      return { id, score: 0.5 * ft + 0.5 * es }
    }
    return { id, score: ft }
  }))

  // H5: RRF (Reciprocal Rank Fusion) — combine entity rank + full-text rank
  const entityRank = [...entityScoreMap.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const ftRank = [...fullTextScores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const K = 60
  const h5 = rank(poolItems.map(id => {
    const eRank = entityRank.indexOf(id)
    const fRank = ftRank.indexOf(id)
    const eRRF = eRank >= 0 ? 1 / (K + eRank) : 0
    const fRRF = fRank >= 0 ? 1 / (K + fRank) : 0
    return { id, score: eRRF + fRRF }
  }))

  // --- EVALUATION ---
  console.log('\n=== RESULTS ===\n')

  const strategies = [
    { name: 'H1: Full-text cosine', ranking: h1 },
    { name: 'H2: Full-text + entity tiebreaker', ranking: h2 },
    { name: 'H3: Max(full-text, entity*0.7)', ranking: h3 },
    { name: 'H4: Weighted blend (0.5/0.5)', ranking: h4 },
    { name: 'H5: Reciprocal Rank Fusion', ranking: h5 },
  ]

  // Also include baseline (full corpus, no filter)
  const baselineRanking = [...fullTextScores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)

  console.log('  Fragment positions (lower = better):')
  console.log('  Fragment            | Baseline | H1   | H2   | H3   | H4   | H5')
  console.log('  --------------------|----------|------|------|------|------|-----')
  for (const frag of FRAGMENTS) {
    const bRank = baselineRanking.indexOf(frag.id) + 1
    const ranks = strategies.map(s => {
      const r = s.ranking.indexOf(frag.id) + 1
      return r ? String(r).padStart(4) : '   -'
    })
    console.log(`  ${frag.id.padEnd(20)}| ${String(bRank).padStart(8)} | ${ranks.join(' | ')}`)
  }

  console.log('\n  Metrics (top-10 of hybrid pool):')
  console.log('  Strategy                        | P@5  | P@10 | R@10 | Avg signal rank')
  console.log('  --------------------------------|------|------|------|----------------')

  const baseR10 = baselineRanking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / SIGNAL_IDS.size
  const baseP5 = baselineRanking.slice(0, 5).filter(id => SIGNAL_IDS.has(id)).length / 5
  const baseAvg = [...SIGNAL_IDS].reduce((sum, id) => sum + baselineRanking.indexOf(id), 0) / SIGNAL_IDS.size
  console.log(`  Baseline (full corpus, no filter)| ${baseP5.toFixed(2)} | ${(baselineRanking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / 10).toFixed(2)} | ${baseR10.toFixed(2)} | ${baseAvg.toFixed(1)}`)

  for (const s of strategies) {
    const p5 = s.ranking.slice(0, 5).filter(id => SIGNAL_IDS.has(id)).length / 5
    const p10 = s.ranking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / 10
    const r10 = s.ranking.slice(0, 10).filter(id => SIGNAL_IDS.has(id)).length / SIGNAL_IDS.size
    const avgRank = [...SIGNAL_IDS].reduce((sum, id) => {
      const r = s.ranking.indexOf(id)
      return sum + (r >= 0 ? r : 999)
    }, 0) / SIGNAL_IDS.size
    console.log(`  ${s.name.padEnd(32)}| ${p5.toFixed(2)} | ${p10.toFixed(2)} | ${r10.toFixed(2)} | ${avgRank.toFixed(1)}`)
  }

  // Entity-dependent items specifically
  console.log('\n  Entity-dependent fragments (4 items that baseline struggles with):')
  console.log('  Strategy                        | Found in top-10 | Avg rank')
  console.log('  --------------------------------|-----------------|----------')
  const baseEntDepAvg = [...ENTITY_DEPENDENT].reduce((s, id) => s + baselineRanking.indexOf(id), 0) / ENTITY_DEPENDENT.size
  const baseEntDep10 = [...ENTITY_DEPENDENT].filter(id => baselineRanking.indexOf(id) < 10).length
  console.log(`  Baseline                        | ${baseEntDep10}/4             | ${baseEntDepAvg.toFixed(1)}`)

  for (const s of strategies) {
    const found = [...ENTITY_DEPENDENT].filter(id => s.ranking.indexOf(id) < 10).length
    const avg = [...ENTITY_DEPENDENT].reduce((sum, id) => {
      const r = s.ranking.indexOf(id)
      return sum + (r >= 0 ? r : 999)
    }, 0) / ENTITY_DEPENDENT.size
    console.log(`  ${s.name.padEnd(32)}| ${found}/4             | ${avg.toFixed(1)}`)
  }

  console.log(`\n  Cost: $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
