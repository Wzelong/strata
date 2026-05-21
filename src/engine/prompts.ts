export const ENTITY_EXTRACTION_SYSTEM = `Extract only entities that could link this post to a DIFFERENT post about the same real-world incident, person, or thing.

An entity is worth extracting when it has 2+ specific details that narrow it to one real-world referent. A single common noun is never enough.

Types: person, location, object, organization, phone, email, url, username, quantity

Rules:
- Copy surfaceText verbatim from the input
- Combine related details into one entity (color + make + damage = one object)
- Return an empty array when nothing qualifies — most posts have zero extractable entities
- quantity: only extract identifiers like case numbers, badge numbers, license plates — not amounts, durations, or counts

<example>
Input: "I saw a guy in a red Toyota Camry with a dented rear door cut off a cyclist near the Elm St and 5th Ave intersection"
Output: [object: "red Toyota Camry with a dented rear door", location: "Elm St and 5th Ave intersection"]
Not extracted: "guy", "cyclist", "intersection" (single common nouns — millions of posts mention these)
</example>

<example>
Input: "Dr. Patel at Riverside Clinic misdiagnosed my dog last month. She charged me $400 for nothing."
Output: [person: "Dr. Patel", organization: "Riverside Clinic"]
Not extracted: "dog", "last month", "$400" (common — not specific to one real-world event)
</example>

<example>
Input: "Honestly stay off Mass Ave near Central if you can. Last Tuesday around 6pm some asshole in a dark green Subaru Outback blew through the crosswalk. Reported it to Cambridge PD non-emergency."
Output: [object: "dark green Subaru Outback", location: "Mass Ave near Central", organization: "Cambridge PD non-emergency"]
Not extracted: "crosswalk", "Last Tuesday", "6pm" (generic time/place words)
</example>

<example>
Input: "Hope you didn't like IPAs. I still drink them but they are the most common factor if I have a flare up."
Output: []
Reasoning: "IPAs" is a common beverage category — finding it in another post would be unremarkable.
</example>

<example>
Input: "You can tell a red shirt. The T police might show up eventually and cause more harm than good."
Output: []
Reasoning: "a red shirt" and "T police" are generic — thousands of posts could mention either without being connected.
</example>

<example>
Input: "Three weeks and counting since I submitted dashcam footage to Cambridge PD for case #2026-04891."
Output: [organization: "Cambridge PD", quantity: "#2026-04891"]
Not extracted: "Three weeks", "dashcam footage" (common nouns, not identifiers)
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
