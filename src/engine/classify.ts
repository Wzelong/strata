import type OpenAI from 'openai'
import type { Item, Relationship, CostTracker } from './types.js'
import {
  CLASSIFICATION_STAGE1_SYSTEM,
  CLASSIFICATION_STAGE1_SCHEMA,
  CLASSIFICATION_STAGE2_SYSTEM,
  CLASSIFICATION_STAGE2_SCHEMA,
} from './prompts.js'

export async function classifyRelationship(
  client: OpenAI,
  a: Item,
  b: Item,
  cost?: CostTracker,
): Promise<Relationship> {
  const pairPrompt = `Item A (id: ${a.id}):\n"${a.text}"\n\nItem B (id: ${b.id}):\n"${b.text}"`

  const stage1 = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: CLASSIFICATION_STAGE1_SYSTEM },
      { role: 'user', content: pairPrompt + '\n\nIs B meaningfully connected to A?' },
    ],
    text: { format: { type: 'json_schema', name: 'classification_stage1', schema: CLASSIFICATION_STAGE1_SCHEMA, strict: true } },
  })
  cost?.track(stage1.usage)
  const s1 = JSON.parse(stage1.output_text) as { connected: string }

  if (s1.connected === 'UNRELATED') return 'UNRELATED'

  const stage2 = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: CLASSIFICATION_STAGE2_SYSTEM },
      { role: 'user', content: pairPrompt + '\n\nThese items are confirmed to be related. What is the specific relationship of B to A?' },
    ],
    text: { format: { type: 'json_schema', name: 'classification_stage2', schema: CLASSIFICATION_STAGE2_SCHEMA, strict: true } },
  })
  cost?.track(stage2.usage)
  const s2 = JSON.parse(stage2.output_text) as { relationship: string }
  return s2.relationship as Relationship
}
