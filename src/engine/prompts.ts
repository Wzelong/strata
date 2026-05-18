export const ENTITY_EXTRACTION_SYSTEM = `Extract all named entities from the text. Return each entity's type, the exact surface text, and a normalized canonical form.

# Entity types

person, location, time, username, url, organization, monetary_amount, quantity, phone, email, product

# What to extract

Any referenced person, place, thing, time, or identifier. Include both specific and general references:
- People: "Officer Delgado", "my dad", "the landlord", "Karen"
- Locations: "5th and Main", "Birchwood Ave", "downtown", "the park on Elm"
- Organizations: "Chase Bank", "the police", "FBI", "CPD"
- Times: "Tuesday", "3pm yesterday", "last week", "around March"
- Phone/email/URL: any specific number, address, or domain
- Products/vehicles: "white Honda Civic", "iPhone", "Zelle", plate "7M3"
- Quantities: case numbers, report numbers, specific amounts

# Do NOT extract

- Pronouns: he, she, they, I, you, we, it
- Anaphora: the guy, someone, this person, OP, anybody
- Abstract concepts: scam, fraud, suspicious, dangerous, sketchy

# Canonical format

Lowercase, underscores between words. Same real-world entity → same canonical.
- Phone: digits and hyphens → 555-0183
- URL: domain only → safecityclaims.net
- Intersections: numbered street first → 5th_and_main
- Streets: include suffix → birchwood_ave, elm_street
- Vehicles: color_brand_model → white_honda_civic
- Plates: confirmed chars → 7m3
- People: title_lastname when titled → officer_delgado. Relation words when unnamed → dad, mom
- Organizations: proper name or abbreviation → chase_bank, cpd, fbi. Generic role when unnamed → the_police, the_bank
- Times: lowercase, underscored → tuesday, 3pm_yesterday, last_week

# Rules

- surfaceText must be copied verbatim from the input.
- If the same entity appears multiple times in different wording, use the SAME canonical for all.
- Extract generously — downstream filtering handles noise.`

export const ENTITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['person', 'location', 'time', 'username', 'url', 'organization', 'monetary_amount', 'quantity', 'phone', 'email', 'product'] },
          surfaceText: { type: 'string' },
          canonical: { type: 'string' },
        },
        required: ['type', 'surfaceText', 'canonical'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities'],
  additionalProperties: false,
}

export const CLASSIFICATION_STAGE1_SYSTEM = `Determine if two community forum items are meaningfully connected.

RELATED: B has a substantive connection to A — same event, same pattern, same ongoing situation, or provides useful context for investigating A.
UNRELATED: No meaningful connection despite surface similarity (shared location but different topic, coincidental entity overlap).

Rules:
- Shared location alone does NOT make items related.
- If B could plausibly help a moderator investigating A's situation, it is RELATED.
- Default to UNRELATED unless a specific substantive connection exists.`

export const CLASSIFICATION_STAGE1_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    connected: { type: 'string', enum: ['RELATED', 'UNRELATED'] },
    reasoning: { type: 'string' },
  },
  required: ['connected', 'reasoning'],
  additionalProperties: false,
}

export const CLASSIFICATION_STAGE2_SYSTEM = `Given two related items, classify the specific relationship of B to A.

- CONFIRMS: B corroborates the SAME event in A without adding new facts. Another eyewitness, another victim of the same scam, same story from a different angle.
- CONTRADICTS: B conflicts with A's claims.
- UPDATES: B adds NEW information advancing A's situation — new evidence, arrest, investigation progress, expansion to new area. If B contains facts NOT in A that move things forward, this is UPDATES.
- TEMPORAL: B describes PRIOR or HISTORICAL incidents providing time-based context. "This has happened before," ongoing pattern predating A, separate earlier events at same location.

Tiebreakers:
- CONFIRMS vs UPDATES: Does B add any new factual detail? New location, new evidence, arrest, sighting expansion → UPDATES. Pure corroboration of existing facts → CONFIRMS.
- UPDATES vs TEMPORAL: Same ongoing situation evolving → UPDATES. Separate historical precedent → TEMPORAL.`

export const CLASSIFICATION_STAGE2_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    relationship: { type: 'string', enum: ['CONFIRMS', 'CONTRADICTS', 'UPDATES', 'TEMPORAL'] },
    reasoning: { type: 'string' },
  },
  required: ['relationship', 'reasoning'],
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
