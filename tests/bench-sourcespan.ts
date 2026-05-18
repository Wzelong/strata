import OpenAI from 'openai'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from '../src/engine/prompts.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

const TEXTS = [
  `I got a call from (555) 234-5678 claiming to be from Chase Bank. They said my account was compromised and needed my SSN to verify. The caller ID showed a New York number.`,
  `Saw a white Honda Civic with partial plate 7M3 run a red light at 5th and Main around 3pm yesterday. Officer Delgado took my report, case number 2024-04871.`,
  `Warning: safecityclaims.net is a phishing site. Got a text from 800-555-1234 directing me there. Looks like a legit city website but it's harvesting SSNs.`,
]

async function main() {
  console.log('=== sourceSpan Accuracy Test ===\n')

  let totalEntities = 0
  let exactMatches = 0
  let offByFew = 0

  for (let t = 0; t < TEXTS.length; t++) {
    const text = TEXTS[t]
    const response = await client.responses.create({
      model: 'gpt-5.4-mini',
      temperature: 0,
      input: [
        { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM },
        { role: 'user', content: text },
      ],
      text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
    })
    const result = JSON.parse(response.output_text) as { entities: Array<{ type: string; surfaceText: string; canonical: string; sourceSpan: [number, number] }> }

    console.log(`Text ${t}: "${text.slice(0, 60)}..."`)
    for (const e of result.entities) {
      totalEntities++
      const [start, end] = e.sourceSpan
      const actual = text.slice(start, end)
      const exact = actual === e.surfaceText
      if (exact) exactMatches++

      // Check if surfaceText exists somewhere in text
      const realIdx = text.indexOf(e.surfaceText)
      const existsInText = realIdx !== -1
      const offsetError = existsInText ? Math.abs(realIdx - start) : -1

      if (!exact && existsInText && offsetError <= 5) offByFew++

      const status = exact ? 'EXACT' : (existsInText ? `OFF_BY_${offsetError}` : 'HALLUCINATED')
      console.log(`  ${status} | ${e.type}:${e.canonical} | surface="${e.surfaceText}" | span=[${start},${end}] | got="${actual}"`)
    }
    console.log('')
  }

  console.log('=== Summary ===')
  console.log(`Total entities: ${totalEntities}`)
  console.log(`Exact span match: ${exactMatches}/${totalEntities} (${(exactMatches/totalEntities*100).toFixed(0)}%)`)
  console.log(`Off by ≤5 chars: ${offByFew}/${totalEntities}`)
  console.log(`Hallucinated/wrong: ${totalEntities - exactMatches - offByFew}/${totalEntities}`)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
