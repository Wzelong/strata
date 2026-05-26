import type OpenAI from 'openai'
import type { Entity, CostTracker } from './types.js'

export const ENTITY_EXTRACTION_SYSTEM = `Extract entities that could link this post to a DIFFERENT post about the same real-world referent — a specific person, place, business, product, object, or event.

Atomize: each distinguishing feature is its own entity. Do not combine multiple features into one string, even when they appear in the same sentence. An item plus a notable marking plus damage is three object entities, not one long description.

Each entity must include its head noun — the actual thing named. Modifiers, colors, numbers, and measurements alone never qualify: "cracked screen" yes, "cracked" no; "model 3047" yes, "3047" no.

A single common noun is never enough; the entity must narrow to one referent. "the store" never qualifies; "Harvard Coop on Mass Ave" does. Use only words from the input.

Types: person, location, object, organization, phone, email, url, username, quantity
- object: each distinct physical feature is its own entity — the item, a marking, damage
- person: name preferred; otherwise a role with a specific affiliation
- location: specific street, intersection, landmark, address, or neighborhood
- organization: include qualifiers that narrow which one ("non-emergency line", "South Station branch")
- quantity: identifiers only — case/order/reference numbers, license plates, badges. Not durations, amounts, or ages.
- phone, email, url, username: as written

Return an empty array when nothing qualifies. Most posts have zero linkable entities.

<example>
Input: "Selling a matte black Trek hardtail, has a cracked left pedal and a faded UMass sticker on the down tube."
Output: [object: "matte black Trek hardtail", object: "cracked left pedal", object: "faded UMass sticker"]
Atomized: the bike, the damage, and the marking are separate. "cracked" alone would not qualify — head noun "pedal" included.
</example>

<example>
Input: "Filed a complaint with the Cambridge License Commission about The Plough on Mass Ave, reference #2026-1187."
Output: [organization: "Cambridge License Commission", organization: "The Plough", location: "Mass Ave", quantity: "reference #2026-1187"]
</example>

<example>
Input: "Got scammed reselling a concert ticket to u/fastflip_deals — their Venmo is @flipdeals22."
Output: [username: "u/fastflip_deals", username: "@flipdeals22"]
"concert ticket" excluded — generic, narrows to no specific referent.
</example>

<example>
Input: "Honestly the coffee scene around here has gotten so much better in the last few years."
Output: []
Generic topic, no specific referent.
</example>`

export const ENTITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity'] },
          surfaceText: { type: 'string' },
        },
        required: ['type', 'surfaceText'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities'],
  additionalProperties: false,
}

export async function extractEntities(
  client: OpenAI,
  text: string,
  cost?: CostTracker,
): Promise<Entity[]> {
  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM },
      { role: 'user', content: text },
    ],
    text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
  })
  cost?.track(response.usage)
  const parsed = JSON.parse(response.output_text) as { entities: Entity[] }
  return parsed.entities
}
