import OpenAI from 'openai'
import { extractEntities } from '../src/engine/extract.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const tests = [
  `Hope you didn't like IPAs....I still drink them but they are easily the most common factor if I have a flare up`,
  `Agreed BUT isn't it more worth the effort the more time you get with A/C? The pay off is better the sooner you do it, and come September, you won't feel like it was worth the hassle.`,
  `You can tell a red shirt. The T police might show up eventually and cause more harm than good. Eventually you realize it's pointless and don't bother.`,
  `OP to help clarify more, Paper passes can additionally be purchased at the North Station, South Station and Back Bay ticket booths in-person.`,
  `Around 7:30PM yesterday I was driving on Boylston Street when I saw a city bus whose route indicator was flashing a sign saying "Call Police, 617-222-1212"`,
  `Three weeks and counting since I submitted dashcam footage to Cambridge PD for case #2026-04891. They told me a detective would follow up within 48 hours. Never heard back.`,
]

for (const text of tests) {
  console.log('Input:', text.slice(0, 100))
  const entities = await extractEntities(client, text)
  if (entities.length === 0) {
    console.log('  (none)')
  } else {
    for (const e of entities) console.log(`  ${e.type}: ${e.surfaceText}`)
  }
  console.log('')
}
