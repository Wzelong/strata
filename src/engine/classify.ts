import type OpenAI from 'openai'
import type { Item, Relationship, CostTracker } from './types.js'

const BATCH_SYSTEM = `Classify each candidate's relationship to the case post.

Relationships:
- CONFIRMS: Corroborates the same event from a different angle
- UPDATES: Adds new facts, evidence, or leads about the same situation
- TEMPORAL: Describes a prior incident that establishes a pattern
- CONTRADICTS: Conflicts with claims in the case post
- UNRELATED: No meaningful connection

Confidence (null for UNRELATED):
- high: The connection is clear — specific shared details make this obviously related. A mod can act on it immediately.
- review: Plausibly related but circumstantial — shared location or timing without a specific linking detail. A mod should read carefully before deciding.
- null: Use for UNRELATED items only.

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

const CONTRADICTION_SYSTEM = `You are checking whether the same author has posted contradictory statements across time.

For each prior item by this author, decide:
- CONTRADICTS: The prior item claims something factually incompatible with the new item. The two cannot both be true. Different topics that don't logically conflict are NOT contradictions.
- CONSISTENT: The prior item is compatible (same view, supplementary, or different topic where no logical conflict exists).

Examples:
- New: "my roommate doesn't drive, takes the Green Line" / Prior: "my roommate and I drive to bars Tuesdays" → CONTRADICTS (factual conflict about whether roommate drives)
- New: "I love this restaurant" / Prior: "this restaurant gave me food poisoning" → CONTRADICTS
- New: "Sarah is the best engineer" / Prior: "I went hiking this weekend" → CONSISTENT (unrelated topics)
- New: "Mass Ave needs bike lanes" / Prior: "Mass Ave bike infrastructure is a joke" → CONSISTENT (same view)

Confidence:
- high: The contradiction is unambiguous — a reasonable person reading both would call them inconsistent.
- review: There is tension but it could be explained (sarcasm, role-play, change of mind clearly stated).
- null: For CONSISTENT items.`

const CONTRADICTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          relationship: { type: 'string', enum: ['CONTRADICTS', 'CONSISTENT'] },
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

export type ContradictionResult = {
  id: string
  relationship: 'CONTRADICTS' | 'CONSISTENT'
  confidence: 'high' | 'review' | null
  reason: string
}

export async function classifyContradictions(
  client: OpenAI,
  newItem: Item,
  priors: Array<{ id: string; text: string; createdAt: number }>,
  cost?: CostTracker,
): Promise<ContradictionResult[]> {
  if (priors.length === 0) return []
  const priorList = priors
    .map(p => `[${p.id}] (posted ${new Date(p.createdAt).toISOString().slice(0, 10)}): "${p.text.slice(0, 500)}"`)
    .join('\n\n')
  const userPrompt = `## New item (id: ${newItem.id}, author: ${newItem.authorName})\n"${newItem.text.slice(0, 500)}"\n\n## Prior items by same author\n${priorList}\n\nClassify each prior's relationship to the new item.`

  const response = await client.responses.create({
    model: 'gpt-5.5',
    reasoning: { effort: 'low' },
    input: [
      { role: 'developer', content: CONTRADICTION_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    text: { format: { type: 'json_schema', name: 'contradiction_classification', schema: CONTRADICTION_SCHEMA, strict: true } },
  })
  cost?.track(response.usage)
  const parsed = JSON.parse(response.output_text) as { classifications: ContradictionResult[] }
  return parsed.classifications
}
