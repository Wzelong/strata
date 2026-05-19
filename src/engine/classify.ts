import type OpenAI from 'openai'
import type { Item, Relationship, CostTracker } from './types.js'

const BATCH_SYSTEM = `Classify each candidate's relationship to the case post.

Relationships:
- CONFIRMS: Corroborates the same event from a different angle
- UPDATES: Adds new facts, evidence, or leads about the same situation
- TEMPORAL: Describes a prior incident that establishes a pattern
- CONTRADICTS: Conflicts with claims in the case post
- UNRELATED: No meaningful connection

Two items are connected when they share a specific identifier — the same person, vehicle, phone number, address, username, or physical description. Shared location or topic alone is not enough; shared specific details are.

A moderator investigating the case post would find a connected item useful as evidence, context, or a lead. That is the test.`

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
          reason: { type: 'string' },
        },
        required: ['id', 'relationship', 'reason'],
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
