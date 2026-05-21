import OpenAI from 'openai'
import { cosine } from '../src/engine/embed.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const tests: [string, string, string][] = [
  // PERSON: same vs different
  ['person', 'Dr. Patel', 'Dr. Patel at Riverside'],
  ['person', 'Dr. Patel', 'Dr. Martinez'],
  ['person', 'Mark Wahlberg', 'Wahlberg'],
  ['person', 'Mark Wahlberg', 'Matt Damon'],
  ['person', 'Fred Laskey', 'Fred Laskey from MWRA'],

  // ORGANIZATION: same vs different
  ['organization', 'Cambridge PD', 'Cambridge Police Department'],
  ['organization', 'Cambridge PD', 'Boston PD'],
  ['organization', 'Cambridge PD', 'Somerville Police'],
  ['organization', 'MGH', 'Massachusetts General Hospital'],
  ['organization', 'MGH', 'Brigham and Women\'s'],
  ['organization', 'TD Garden', 'the Garden'],
  ['organization', 'TD Garden', 'Fenway Park'],

  // OBJECT: same vs different
  ['object', 'dark green Subaru Outback', 'dark green SUV, possibly a Subaru'],
  ['object', 'dark green Subaru Outback', 'red Toyota Camry'],
  ['object', 'dark green Subaru Outback', 'dark blue Subaru Forester'],
  ['object', 'cracked taillight', 'cracked passenger headlight'],
  ['object', 'cracked taillight', 'dented rear door'],
  ['object', '"26.2" marathon stickers', 'marathon sticker on back window'],
  ['object', '"26.2" marathon stickers', 'bumper sticker'],

  // LOCATION: same vs different
  ['location', 'Mass Ave near Central', 'Massachusetts Avenue near Central Square'],
  ['location', 'Mass Ave near Central', 'Dorchester Ave'],
  ['location', 'Mass Ave near Central', 'Fenway area'],
  ['location', 'P3 of the Cambridgeside garage', 'Cambridgeside garage level 3'],
  ['location', 'P3 of the Cambridgeside garage', 'Alewife parking garage'],
  ['location', 'Inman Square', 'Central Square'],

  // QUANTITY: same vs different
  ['quantity', 'case #2026-04891', '#2026-04891'],
  ['quantity', 'case #2026-04891', 'case #2026-05123'],
  ['quantity', '28 years old', '28 year old'],
  ['quantity', '28 years old', '35 years old'],
  ['quantity', '$3200', '$3,200/month'],
  ['quantity', '$3200', '$4500'],

  // URL: same vs different
  ['url', 'https://zillow.com/homedetails/5-garden-ct', 'https://zillow.com/homedetails/5-garden-ct-apt-1'],
  ['url', 'https://zillow.com/homedetails/5-garden-ct', 'https://zillow.com/homedetails/100-main-st'],

  // USERNAME: same vs different
  ['username', 'DashcamDave_617', 'DashcamDave617'],
  ['username', 'DashcamDave_617', 'BikerBoston42'],
]

const texts = [...new Set(tests.map(t => t[1]).concat(tests.map(t => t[2])))]
const resp = await client.embeddings.create({ input: texts, model: 'text-embedding-3-small', dimensions: 256 })
const embMap = new Map(resp.data.map((d, i) => [texts[i], d.embedding]))

let currentType = ''
for (const [type, a, b] of tests) {
  if (type !== currentType) {
    currentType = type
    console.log(`\n${type.toUpperCase()}:`)
  }
  const sim = cosine(embMap.get(a)!, embMap.get(b)!)
  console.log(`  ${sim.toFixed(4)}  "${a}"  <->  "${b}"`)
}
