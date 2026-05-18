import type OpenAI from 'openai'
import type { CostTracker } from './types.js'

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

const MAX_EMBED_BATCH = 2048

export async function embedBatch(
  client: OpenAI,
  texts: string[],
  cost?: CostTracker,
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length)

  for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH) {
    const chunk = texts.slice(i, i + MAX_EMBED_BATCH)
    const response = await client.embeddings.create({
      input: chunk,
      model: 'text-embedding-3-small',
      dimensions: 256,
    })
    cost?.track({ input_tokens: response.usage.total_tokens, output_tokens: 0 })
    const sorted = response.data.sort((a, b) => a.index - b.index)
    for (let j = 0; j < sorted.length; j++) {
      results[i + j] = sorted[j].embedding
    }
  }

  return results
}

export async function embedSingle(
  client: OpenAI,
  text: string,
  cost?: CostTracker,
): Promise<number[]> {
  const [result] = await embedBatch(client, [text], cost)
  return result
}
