import type OpenAI from 'openai'
import type { CostTracker } from './types.js'

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

// --- Int8 scalar quantization ---

export function quantize(embedding: number[]): string {
  let min = Infinity, max = -Infinity
  for (const v of embedding) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min || 1
  const bytes = new Uint8Array(embedding.length)
  for (let i = 0; i < embedding.length; i++) {
    bytes[i] = Math.round(((embedding[i] - min) / range) * 255)
  }
  return `${min.toExponential(6)},${max.toExponential(6)},${Buffer.from(bytes).toString('base64')}`
}

export function dequantize(encoded: string): number[] {
  const firstComma = encoded.indexOf(',')
  const secondComma = encoded.indexOf(',', firstComma + 1)
  const min = parseFloat(encoded.slice(0, firstComma))
  const max = parseFloat(encoded.slice(firstComma + 1, secondComma))
  const bytes = new Uint8Array(Buffer.from(encoded.slice(secondComma + 1), 'base64'))
  const range = max - min
  const result = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    result[i] = (bytes[i] / 255) * range + min
  }
  return result
}

// --- Embedding API ---

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
