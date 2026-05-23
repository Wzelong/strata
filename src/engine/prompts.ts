// EXTRACTION DESIGN — atomize, do not combine.
// Each distinguishable feature becomes its own entity record. Multiple object
// entities per item is correct when the post describes multiple features of
// the same referent. Short atomic entities cluster well by embedding cosine
// because shared words drive similarity. Long combined strings diverge between
// posts because different witnesses notice different features.
export const ENTITY_EXTRACTION_SYSTEM = `Extract entities that could link this post to a DIFFERENT post about the same real-world referent (incident, person, place, thing).

Atomize: each distinguishing feature is its own entity. Do NOT combine multiple features into one string, even when they appear in the same sentence. A post that mentions a vehicle's color, damage, and identifying mark contributes three object entities — not one long description.

Each entity must include its head noun — the actual thing being described. Modifiers, colors, numbers, and measurements alone do not qualify. "cracked taillight" (noun: taillight) yes; "cracked" alone no. "marathon stickers" yes; "26.2" alone no. "dark green Subaru" yes; "dark green" alone no.

Use only words from the input.

A single common noun is never enough. The entity must narrow to one specific referent: "the car" never qualifies; "dark green Subaru Outback" does.

Types: person, location, object, organization, phone, email, url, username, quantity

Per type:
- object: each distinct feature gets its own entity — vehicle make/color/model is one, damage is one, identifying mark is one
- person: name preferred; otherwise role with specific affiliation
- location: specific street, intersection, landmark, garage, neighborhood
- organization: include qualifiers that narrow which one ("non-emergency", "P3 garage")
- quantity: identifiers only — case numbers, badges, license plates. Not durations, amounts, ages.
- phone, email, url, username: as written

Return an empty array when nothing qualifies. Most posts have zero linkable entities.

<example>
Input: "I saw a guy in a red Toyota Camry with a dented rear door cut off a cyclist near the Elm St and 5th Ave intersection"
Output: [object: "red Toyota Camry", object: "dented rear door", location: "Elm St and 5th Ave intersection"]
Atomized: vehicle and damage are two separate features even though adjacent in the text. "guy" and "cyclist" excluded — generic.
</example>

<example>
Input: "Someone has a dark green Subaru Outback on P3 with gnarly front bumper damage and a cracked passenger headlight. The bumper is hanging off on one side."
Output: [object: "dark green Subaru Outback", object: "gnarly front bumper damage", object: "cracked passenger headlight", object: "bumper hanging off on one side", location: "P3"]
Atomized: vehicle, three damage features, and location each become separate entities.
</example>

<example>
Input: "Some asshole in a dark green Subaru Outback blew through the crosswalk — had a cracked taillight and one of those '26.2' marathon stickers on the back window."
Output: [object: "dark green Subaru Outback", object: "cracked taillight", object: "26.2 marathon stickers on the back window"]
Head-noun rule: "26.2" alone is just a number — must include the noun it modifies ("stickers"). Same for "cracked" → "cracked taillight".
</example>

<example>
Input: "Need an auto body shop. Friend's car has significant front-passenger damage on a 2017 Subaru — cracked headlight, bumper hanging loose on the driver-side too. Closer to Inman/Cambridgeside ideally."
Output: [object: "2017 Subaru", object: "significant front-passenger damage", object: "cracked headlight", object: "bumper hanging loose on the driver-side", location: "Inman/Cambridgeside"]
Atomized across sentences: each damage feature is its own entity record.
</example>

<example>
Input: "Honestly stay off Mass Ave near Central. Some asshole in a dark green Subaru Outback blew through the crosswalk at Prospect. Reported it to Cambridge PD non-emergency."
Output: [object: "dark green Subaru Outback", location: "Mass Ave near Central", location: "Prospect", organization: "Cambridge PD non-emergency"]
"crosswalk" excluded — generic.
</example>

<example>
Input: "Hope you didn't like IPAs. I still drink them but they are the most common factor if I have a flare up."
Output: []
"IPAs" is a generic beverage category. No specific referent.
</example>

<example>
Input: "Three weeks and counting since I submitted dashcam footage to Cambridge PD for case #2026-04891."
Output: [organization: "Cambridge PD", quantity: "case #2026-04891"]
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


export const RECOMMENDATION_SYSTEM = `Given a pending item, similar precedents with their moderation decisions, and community rules, recommend a moderation action.

Actions:
- remove: Item violates a rule. You MUST specify which ruleId.
- approve: Item follows all rules and is acceptable.
- skip: Borderline or insufficient confidence.

Process:
1. Check if the item directly violates any rule (independent of precedents).
2. If similar items were removed for a rule violation and this item shows the same pattern, recommend removal citing that rule.
3. If evidence is mixed or borderline, recommend skip.`

export const RECOMMENDATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    recommendation: { type: 'string', enum: ['remove', 'approve', 'skip'] },
    rationale: { type: 'string' },
    ruleId: { type: ['string', 'null'] },
  },
  required: ['recommendation', 'rationale', 'ruleId'],
  additionalProperties: false,
}
