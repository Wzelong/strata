import type OpenAI from 'openai'
import type { Item, Relationship, CostTracker } from './types.js'

const BATCH_SYSTEM = `Classify each candidate's relationship to the case post.

Relationships:
- CONFIRMS: Corroborates the same incident/situation from a different angle
- UPDATES: Adds new facts, evidence, or leads about the same incident
- TEMPORAL: Describes a prior incident that establishes a pattern of behavior
- CONTRADICTS: Conflicts with claims in the case post
- UNRELATED: No meaningful connection for moderation purposes

Confidence (null for UNRELATED):
- high: The connection is clear and actionable — a mod should see this immediately.
- review: Plausibly related but needs human judgment.
- null: Use for UNRELATED items only.

CONNECTION REQUIRES ALL OF:
1. A specific shared identifier: same person, vehicle, plate number, phone number, address, case number, username, or unique physical description.
2. Moderation relevance: the connection helps a moderator investigate an incident, enforce rules, detect patterns of harm, or protect community members.

MARK AS UNRELATED even if items share specific details when:
- The shared detail is public knowledge being discussed (library cards, transit passes, public events, song titles, restaurant names)
- Both items are casual recommendations, opinions, or Q&A — not reports of incidents
- The connection has no moderation implication (nothing to investigate, enforce, or act on)
- Items discuss the same news story without adding investigative value

The test: would a moderator NEED to see these items linked together to do their job? If it's just "people talking about the same thing" — that's UNRELATED.`

const BATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          relationship: { type: 'string', enum: ['CONFIRMS', 'CONTRADICTS', 'UPDATES', 'TEMPORAL', 'UNRELATED'] },
          confidence: { type: ['string', 'null'], enum: ['high', 'review', null] },
          reason: { type: 'string' },
        },
        required: ['id', 'relationship', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['classifications'],
  additionalProperties: false,
}

export type ClassificationResult = {
  id: string
  relationship: Relationship
  confidence: 'high' | 'review' | null
  reason: string
}

export async function classifyBatch(
  client: OpenAI,
  caseItem: Item,
  candidates: Array<{ id: string; text: string }>,
  cost?: CostTracker,
): Promise<ClassificationResult[]> {
  if (candidates.length === 0) return []

  const candidateList = candidates.map(c => `[${c.id}]: "${c.text.slice(0, 500)}"`).join('\n\n')

  const userPrompt = `## Case Post (id: ${caseItem.id})\n"${caseItem.text.slice(0, 500)}"\n\n## Candidates\n${candidateList}\n\nClassify each candidate's relationship to the case post.`

  const response = await client.responses.create({
    model: 'gpt-5.5',
    reasoning: { effort: 'low' },
    input: [
      { role: 'developer', content: BATCH_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    text: { format: { type: 'json_schema', name: 'batch_classification', schema: BATCH_SCHEMA, strict: true } },
  })
  cost?.track(response.usage)

  const parsed = JSON.parse(response.output_text) as { classifications: ClassificationResult[] }
  return parsed.classifications
}

export async function classifyRelationship(
  client: OpenAI,
  a: Item,
  b: Item,
  cost?: CostTracker,
): Promise<Relationship> {
  const results = await classifyBatch(client, a, [{ id: b.id, text: b.text }], cost)
  return results[0]?.relationship ?? 'UNRELATED'
}
