import type OpenAI from 'openai'
import type { Item, Relationship, CostTracker } from './types.js'

const BATCH_SYSTEM = `Classify how each candidate relates to the case post. You are the connection filter behind a subreddit moderator's investigation tool: the moderator only sees candidates you mark related, so surface what they need to act on and drop the noise.

Relationships:
- CONFIRMS: corroborates the same incident or situation from another angle.
- UPDATES: adds new facts, evidence, or leads about the same incident.
- TEMPORAL: a prior incident that establishes a pattern by the same actor or behavior.
- CONTRADICTS: conflicts with claims in the case post.
- UNRELATED: nothing a moderator needs to act on.

A candidate is related when it concerns the same specific subject as the case post and a moderator would need them linked to investigate, enforce a rule, detect a pattern of harm, or protect someone. "Same specific subject" is either:
- the same entity — a person, account, vehicle, plate, phone, address, case number, or distinctive description; or
- the same specific incident — the same event at the same place and time, even when the two items share no exact identifier.

A shared identifier is the strongest signal, but it is not required. A witness describing the same event from their own vantage is related even if they never quote a plate or case number — corroborating the same incident is itself the connection. Conversely, a shared detail is not a connection when the items describe different incidents: a matching car color, transit card, venue, or a case number from an unrelated event is a coincidence, not a link.

Mark UNRELATED when the items only share a general topic, public knowledge, or a common detail rather than the same specific subject; when they cover the same news story without adding investigative value; or when they are casual recommendations, opinions, or Q&A that give a moderator nothing to act on. The test: would a moderator need to see these linked to do their job? If it is just people discussing the same topic, it is unrelated.

Confidence is null for UNRELATED. Use high when the connection is clear and actionable — the moderator should see it immediately — and review when it is plausibly related but needs human judgment.

<example>
Case post: a resident reports their parked car was keyed overnight on Elm St, with a photo of the damage.
Candidate: "This happened to me too — woke up to a long scratch down my door on Elm St last night."
Result: CONFIRMS, high. Same incident type at the same place and time window, from another victim. No plate or name is shared, but a moderator tracking the vandalism needs both.
</example>

<example>
Case post: a hit-and-run report involving a dark green SUV, police case #2026-04891.
Candidate: "half the town drives a green SUV, this means nothing."
Result: UNRELATED, null. Shares only the vehicle color as a general detail and adds no account of the incident — nothing to investigate.
</example>

<example>
Case post: complaints that user SpamKing keeps dropping the same referral link across threads.
Candidate: a different thread where SpamKing posts the same referral link.
Result: CONFIRMS, high. Same account and same behavior — the pattern the moderator must act on.
</example>`

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
