export const ENTITY_EXTRACTION_SYSTEM = `Extract entities specific enough that two unrelated posts both mentioning one would be a meaningful coincidence, not normal conversation.

Types: person, location, object, organization, phone, email, url, username, quantity

The test for each entity: if you removed it from this text and searched for it in a thousand other posts, would finding a match be surprising and potentially meaningful? If yes, extract it. If the match would be unremarkable, skip it.

surfaceText must be copied verbatim. Fewer specific entities are better than many generic ones.

Physical descriptions are high-value entities even when qualified with uncertainty ("possibly", "looked like", "I think it was") — they are the details that link witnesses across threads. Combine all details about the same physical thing into one entity rather than splitting them.

<example>
Input: "I saw a guy in a red Toyota Camry with a dented rear door cut off a cyclist near the Elm St and 5th Ave intersection"
Output: [object: "red Toyota Camry with a dented rear door", location: "Elm St and 5th Ave intersection"]
Not extracted: "guy", "cyclist" (generic), "intersection" (too vague alone)
</example>

<example>
Input: "Dr. Patel at Riverside Clinic misdiagnosed my dog last month. She charged me $400 for nothing."
Output: [person: "Dr. Patel", organization: "Riverside Clinic"]
Not extracted: "dog", "last month", "$400" (common, not linking)
</example>

<example>
Input: "The food at Sal's on Main is terrible now. Overpriced pasta, rude staff."
Output: [organization: "Sal's on Main"]
Not extracted: "food", "pasta", "staff" (generic nouns)
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
