import type OpenAI from 'openai'
import type { Entity, CostTracker } from './types.js'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from './prompts.js'

export async function extractEntities(
  client: OpenAI,
  text: string,
  registry?: Map<string, string[]>,
  cost?: CostTracker,
): Promise<Entity[]> {
  let systemPrompt = ENTITY_EXTRACTION_SYSTEM

  if (registry && registry.size > 0) {
    const lines: string[] = []
    for (const [type, canonicals] of registry) {
      if (canonicals.length > 0) {
        lines.push(`${type}: ${canonicals.slice(0, 50).join(', ')}`)
      }
    }
    if (lines.length > 0) {
      systemPrompt += `\n\nExisting canonicals in the registry (reuse these if the entity matches, do NOT create a new canonical when one of these fits):\n${lines.join('\n')}`
    }
  }

  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    temperature: 0,
    input: [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: text },
    ],
    text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
  })
  cost?.track(response.usage)
  const parsed = JSON.parse(response.output_text) as { entities: Entity[] }
  return parsed.entities
}
