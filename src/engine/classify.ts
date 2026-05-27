import type OpenAI from 'openai'
import type { Item, Relationship, CostTracker } from './types.js'

const BATCH_SYSTEM = `Classify how each candidate relates to the case post. You are the connection filter behind a subreddit moderator's investigation tool: the moderator only sees candidates you mark related, so surface what they need to act on and drop the noise. Default to UNRELATED — only mark a connection when you are confident a moderator needs these items linked.

Relationships:
- CONFIRMS: corroborates the same incident or situation from another angle.
- UPDATES: adds new facts, evidence, or leads about the same subject.
- TEMPORAL: a different incident that establishes a pattern — same actor, same specific identifier, or same distinctive behavior recurring.
- CONTRADICTS: conflicts with claims in the case post.
- UNRELATED: nothing a moderator needs to act on.

A candidate is related when it shares the same real-world referent as the case post. A "referent" is a specific thing a moderator can act on: a person, account, vehicle, address, case number, phone number, or other identifier that plausibly picks out one real-world entity. Two items sharing the same referent are connected even if they describe different events — different incidents by the same actor form a pattern (use TEMPORAL).

A candidate is also related when it describes the same specific incident from a different vantage — even without sharing an identifier. A witness account of the same event at the same place and time is a connection.

A candidate is UNRELATED when it shares only generic attributes rather than a specific referent. Generic attributes include: a common vehicle color or make without further distinguishing detail, a neighborhood name, a transit line, a type of complaint, or a news topic. The test: could this shared detail plausibly refer to many different real-world things? If yes, it is generic, not a connection.

Confidence is null for UNRELATED. Use high when the connection is clear and actionable. Use review when it is plausibly related but needs human judgment — err toward review over high when uncertain.

<example>
Case post: a resident reports their parked car was keyed overnight on Elm St.
Candidate: "Woke up to a scratch down my door on Elm St last night too."
CONFIRMS, high. Same incident, same street, same time window, different victim.
</example>

<example>
Case post: a hit-and-run involving a green SUV, case #2026-04891.
Candidate: "half the town drives a green SUV, this means nothing."
UNRELATED. Shares only a common vehicle color — no account of any incident, no identifier.
</example>

<example>
Case post: complaints that user SpamKing drops the same referral link across threads.
Candidate: a different thread where SpamKing posts the same link.
CONFIRMS, high. Same account, same behavior — the pattern.
</example>

<example>
Case post: a hit-and-run on Main St involving a red sedan.
Candidate: "Someone in a red sedan cut me off on the highway last week."
UNRELATED. "Red sedan" is a generic descriptor matching thousands of vehicles. No shared identifier, different location, no basis to link.
</example>

<example>
Case post: noise complaint about apartment 4B at 123 Oak St.
Candidate: "I filed a noise complaint about my neighbor last month."
UNRELATED. "Filed a noise complaint" is a common activity. No shared address or person — just the same type of grievance.
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
