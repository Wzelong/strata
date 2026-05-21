import type OpenAI from 'openai'
import type { RawItem, Entity, StoredItem } from './types.js'
import type { KVStore } from './storage/interface.js'
import { normalize } from './normalize.js'
import { quantize } from './embed.js'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA } from './prompts.js'

export type BatchPhase = 'fetching' | 'embedding' | 'extracting' | 'entity-embedding' | 'storing' | 'done' | 'error'

export type IngestStatus = {
  phase: BatchPhase
  totalItems: number
  processed: number
  embBatchId?: string
  extractBatchId?: string
  entityEmbBatchId?: string
  startedAt: number
  error?: string
}

// --- JSONL builders ---

export function buildEmbeddingJsonl(items: Array<{ id: string; text: string }>): string {
  return items.map(item => JSON.stringify({
    custom_id: item.id,
    method: 'POST',
    url: '/v1/embeddings',
    body: { model: 'text-embedding-3-small', input: item.text, dimensions: 256 },
  })).join('\n')
}

export function buildExtractionJsonl(items: Array<{ id: string; text: string }>): string {
  return items.map(item => JSON.stringify({
    custom_id: item.id,
    method: 'POST',
    url: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      temperature: 0,
      input: [
        { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM },
        { role: 'user', content: item.text },
      ],
      text: { format: { type: 'json_schema', name: 'entity_extraction', schema: ENTITY_SCHEMA, strict: true } },
    },
  })).join('\n')
}

export function buildEntityEmbeddingJsonl(entities: Array<{ id: string; text: string }>): string {
  return entities.map(e => JSON.stringify({
    custom_id: e.id,
    method: 'POST',
    url: '/v1/embeddings',
    body: { model: 'text-embedding-3-small', input: e.text, dimensions: 256 },
  })).join('\n')
}

// --- Batch lifecycle ---

export async function submitBatch(client: OpenAI, jsonl: string, endpoint: '/v1/embeddings' | '/v1/responses', filename: string): Promise<string> {
  const file = await client.files.create({
    file: new File([jsonl], filename, { type: 'application/jsonl' }),
    purpose: 'batch',
  })
  const batch = await client.batches.create({
    input_file_id: file.id,
    endpoint,
    completion_window: '24h',
  })
  return batch.id
}

export async function checkBatch(client: OpenAI, batchId: string): Promise<{ status: string; completed: number; total: number; outputFileId?: string; errorFileId?: string }> {
  const batch = await client.batches.retrieve(batchId)
  return {
    status: batch.status,
    completed: batch.request_counts?.completed ?? 0,
    total: batch.request_counts?.total ?? 0,
    outputFileId: batch.output_file_id ?? undefined,
    errorFileId: batch.error_file_id ?? undefined,
  }
}

export async function downloadBatchResults(client: OpenAI, outputFileId: string): Promise<Array<{ custom_id: string; response: any }>> {
  const content = await client.files.content(outputFileId)
  const text = await content.text()
  return text.trim().split('\n').map(line => JSON.parse(line))
}

// --- Result parsers ---

export function parseEmbeddingResults(results: Array<{ custom_id: string; response: any }>): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const r of results) {
    if (r.response?.status_code === 200) {
      const embedding = r.response.body.data[0].embedding
      map.set(r.custom_id, embedding)
    }
  }
  return map
}

export function parseExtractionResults(results: Array<{ custom_id: string; response: any }>): Map<string, Entity[]> {
  const map = new Map<string, Entity[]>()
  for (const r of results) {
    if (r.response?.status_code !== 200) continue
    const outputText = r.response.body.output_text ?? r.response.body.output?.[0]?.content?.[0]?.text ?? ''
    try {
      const parsed = JSON.parse(outputText) as { entities: Entity[] }
      map.set(r.custom_id, parsed.entities)
    } catch {
      map.set(r.custom_id, [])
    }
  }
  return map
}

// --- Store results ---

export async function storeResults(
  store: KVStore,
  rawItems: RawItem[],
  embeddings: Map<string, number[]>,
  entities: Map<string, Entity[]>,
  entityEmbeddings: Map<string, number[]>,
): Promise<number> {
  let stored = 0
  for (const raw of rawItems) {
    const emb = embeddings.get(raw.id)
    const ents = entities.get(raw.id) ?? []
    if (!emb) continue

    const fullText = raw.title ? `${raw.title}\n\n${raw.text}` : raw.text
    const item: StoredItem = {
      id: raw.id,
      type: raw.type,
      ...(raw.title && { title: raw.title }),
      text: raw.text,
      textNormalized: normalize(fullText),
      authorId: raw.authorId,
      authorName: raw.authorName,
      createdAt: raw.createdAt,
      threadRootId: raw.threadRootId,
      parentId: raw.parentId,
      entities: ents,
      decision: 'pending',
      decisionAt: null,
      decisionBy: null,
      decisionReason: null,
    }

    await store.setItem(item)
    await store.setEmbedding(raw.id, emb)
    await store.addToEntityIndex(ents, raw.id, raw.createdAt)

    const quantizedEntities: Array<{ type: string; surfaceText: string; embedding: string }> = []
    for (const e of ents) {
      const entEmb = entityEmbeddings.get(`${raw.id}:${e.surfaceText}`)
      if (entEmb) {
        quantizedEntities.push({ type: e.type, surfaceText: e.surfaceText, embedding: quantize(entEmb) })
      }
    }
    if (quantizedEntities.length > 0) {
      await store.setEntityEmbeddings(raw.id, quantizedEntities)
    }

    stored++
  }
  return stored
}
