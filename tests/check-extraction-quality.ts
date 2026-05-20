import OpenAI from 'openai'
import { normalize } from '../src/engine/normalize.js'
import { extractEntities } from '../src/engine/extract.js'
import type { CostTracker } from '../src/engine/types.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

class SimpleCost implements CostTracker {
  total = 0
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined) {
    if (!usage) return
    this.total += ((usage.input_tokens ?? 0) / 1_000_000) * 0.40
    this.total += ((usage.output_tokens ?? 0) / 1_000_000) * 1.60
  }
}

const TEXTS = [
  {
    label: 'CASE POST',
    text: `My roommate was hit on Mass Ave Tuesday night — driver fled — PLEASE HELP. My roommate Sarah was biking home on Mass Ave near the Prospect St intersection in Central Square around 6pm Tuesday. A car ran the light and hit her. The driver did not stop. Sarah is in the ICU at MGH with a broken pelvis, broken collarbone, and internal bleeding. She is 28 years old. She remembers the car was a dark green SUV, possibly a Subaru, and she thinks she saw a sticker on the back window before she blacked out. Cambridge PD case #2026-04891.`,
  },
  {
    label: 'SIGNAL: near-miss (cycling safety thread)',
    text: `Cycling safety thread: what's your worst near-miss? Mine was last Tuesday around 6pm — some SUV blew through the crosswalk at Prospect while I was mid-crossing on my bike. Had to bail onto the curb. Dark green, looked like one of those Subaru wagons. Cracked taillight on the rear. Reported it to Cambridge PD non-emergency but they said without a plate there's nothing they can do.`,
  },
  {
    label: 'SIGNAL: garage parking rant',
    text: `Monthly garage rant — who else is sick of P3 at Cambridgeside? Every morning the same green Outback with a marathon sticker takes two spots because the front bumper is dangling off one side. Been like that for weeks. Management won't do anything. At this point I'm leaving a note on the windshield.`,
  },
  {
    label: 'SIGNAL: body shop request',
    text: `Cash-only auto body recommendations? Need discreet bumper/headlight repair on a dark green Subaru. Front driver side. My buddy doesn't want to go through insurance — long story. Needs it done fast, like this week. Prefer a shop that doesn't ask too many questions. DM me.`,
  },
  {
    label: 'SIGNAL: earwitness (pure narrative)',
    text: `Did anyone else hear that horrible screeching sound around dinnertime? I was eating at the Thai place on the corner and we all froze. Then someone ran in saying a person was lying in the road and someone drove off. By the time I got outside there were already people helping. Scary stuff.`,
  },
  {
    label: 'NOISE: pizza recommendation',
    text: `Best pizza in Somerville? Just moved here from NYC and looking for decent slices. Davis Square area preferred but willing to travel for good food. Budget is like $4-5 a slice max.`,
  },
  {
    label: 'NOISE: rent complaint',
    text: `Is it just me or has rent in Cambridge gone completely insane? $3200 for a 1BR in Porter Square with no laundry or parking. This is unsustainable. We need rent control.`,
  },
  {
    label: 'NOISE: generic transit complaint',
    text: `The bike lanes on Mass Ave are a joke. They just painted lines and called it done. No physical barrier means cars swerve in constantly. Someone is going to get killed.`,
  },
]

async function main() {
  const cost = new SimpleCost()
  console.log('=== Extraction Quality Check (selective prompt) ===\n')

  for (const { label, text } of TEXTS) {
    const entities = await extractEntities(client, normalize(text), cost)
    console.log(`${label}:`)
    console.log(`  ${entities.length} entities extracted`)
    for (const e of entities) {
      console.log(`    ${e.type}: "${e.surfaceText}"`)
    }
    console.log()
  }

  console.log(`Cost: $${cost.total.toFixed(4)}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
