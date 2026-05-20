import type OpenAI from 'openai'
import type { Entity, CostTracker } from './types.js'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from './prompts.js'

export async function extractEntities(
  client: OpenAI,
  text: string,
  cost?: CostTracker,
): Promise<Entity[]> {
  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM },
      { role: 'user', content: text },
    ],
    text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
  })
  cost?.track(response.usage)
  const parsed = JSON.parse(response.output_text) as { entities: Entity[] }
  return parsed.entities
}
