import OpenAI from 'openai'
import { extractEntities } from '../src/engine/extract.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const tests = [
  // Should extract specific vehicle + location
  `Not exactly a rant but something that's been bugging me — someone on P3 of the Cambridgeside garage has a dark green Subaru Outback that suddenly has gnarly front bumper damage and a cracked passenger headlight. Showed up maybe 2 weeks ago.`,
  // Should extract specific event details
  `Was walking down Prospect toward Central around 6pm and heard a loud crash followed by tires screeching. By the time I got to Mass Ave there was a bicycle on the ground with the front wheel bent in half but no car.`,
  // Should extract nothing — generic Boston chat
  `Is it just me or has rent in Cambridge gone completely insane? $3200 for a 1BR in Porter Square with no laundry or parking.`,
  // Should extract nothing — generic food rec
  `Best pizza in Davis Square? Just moved here from NYC and looking for decent slices.`,
  // Should extract specific person/business
  `Cash-only auto body recommendations? Need discreet bumper and headlight repair on a dark green Subaru. Front driver side. My buddy doesn't want to go through insurance.`,
  // Generic transit complaint — should extract nothing or minimal
  `The bike lanes on Mass Ave are a joke. They just painted lines and called it done. No physical barrier means cars swerve in constantly.`,
  // Should extract the specific account/incident
  `East Boston resident here: built a tree pit flower box outside my apartment, caught someone dumping a trash bag in it on my front door cam. follow @keepeastieclean on instagram`,
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
