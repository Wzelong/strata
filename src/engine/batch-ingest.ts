import type OpenAI from 'openai'
import type { RawItem, Entity, StoredItem } from './types.js'
import type { KVStore } from './storage/interface.js'
import { normalize } from './normalize.js'
import { quantize, embedBatch } from './embed.js'
import { ENTITY_EXTRACTION_SYSTEM, ENTITY_SCHEMA, extractEntities } from './extract.js'

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

// --- Real-time ingest (non-batch) ---

const MULTI_ENTITY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['person', 'location', 'object', 'organization', 'phone', 'email', 'url', 'username', 'quantity'] },
                surfaceText: { type: 'string' },
              },
              required: ['type', 'surfaceText'],
              additionalProperties: false,
            },
          },
        },
        required: ['index', 'entities'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

const ITEMS_PER_CALL = 5
const PARALLEL_CALLS = 100

async function extractEntitiesBatched(
  client: OpenAI,
  items: Array<{ id: string; text: string }>,
  usage?: { extractInputTokens: number; extractOutputTokens: number; extractCalls: number },
): Promise<Map<string, Entity[]>> {
  const entities = new Map<string, Entity[]>()
  if (items.length === 0) return entities

  const groups: Array<Array<{ id: string; text: string }>> = []
  for (let i = 0; i < items.length; i += ITEMS_PER_CALL) {
    groups.push(items.slice(i, i + ITEMS_PER_CALL))
  }

  for (let i = 0; i < groups.length; i += PARALLEL_CALLS) {
    const parallelBatch = groups.slice(i, i + PARALLEL_CALLS)
    const results = await Promise.all(parallelBatch.map(async (group) => {
      try {
        const input = group.map((item, idx) => `[Item ${idx}]\n${item.text}`).join('\n\n---\n\n')
        const response = await client.responses.create({
          model: 'gpt-5.4-mini',
          temperature: 0,
          input: [
            { role: 'developer', content: ENTITY_EXTRACTION_SYSTEM + '\n\nYou will receive multiple items separated by ---. Extract entities from EACH item independently. Return results as an array with the index of each item.' },
            { role: 'user', content: input },
          ],
          text: { format: { type: 'json_schema', name: 'multi_entity_extraction', schema: MULTI_ENTITY_SCHEMA, strict: true } },
        })
        if (usage) {
          usage.extractInputTokens += response.usage?.input_tokens ?? 0
          usage.extractOutputTokens += response.usage?.output_tokens ?? 0
          usage.extractCalls++
        }
        const parsed = JSON.parse(response.output_text) as { results: Array<{ index: number; entities: Entity[] }> }
        return { group, parsed: parsed.results }
      } catch {
        return { group, parsed: group.map((_, idx) => ({ index: idx, entities: [] as Entity[] })) }
      }
    }))

    for (const { group, parsed } of results) {
      for (const r of parsed) {
        if (r.index >= 0 && r.index < group.length) {
          entities.set(group[r.index].id, r.entities)
        }
      }
      for (let j = 0; j < group.length; j++) {
        if (!entities.has(group[j].id)) entities.set(group[j].id, [])
      }
    }
  }

  return entities
}

export interface IngestChunkResult {
  stored: number
  usage: { embedInputTokens: number; extractInputTokens: number; extractOutputTokens: number; extractCalls: number }
}

export async function ingestChunkRealTime(
  client: OpenAI,
  redis: BulkRedis,
  items: RawItem[],
): Promise<IngestChunkResult> {
  if (items.length === 0) return { stored: 0, usage: { embedInputTokens: 0, extractInputTokens: 0, extractOutputTokens: 0, extractCalls: 0 } }

  const usage = { embedInputTokens: 0, extractInputTokens: 0, extractOutputTokens: 0, extractCalls: 0 }

  const normalized = items.map(r => ({
    id: r.id,
    text: normalize(r.title ? `${r.title}\n\n${r.text}` : r.text),
  }))

  const embeddingArrays = await embedBatch(client, normalized.map(i => i.text))
  const embeddings = new Map<string, number[]>()
  for (let i = 0; i < items.length; i++) embeddings.set(items[i].id, embeddingArrays[i])
  usage.embedInputTokens += normalized.reduce((s, it) => s + Math.ceil(it.text.length / 4), 0)

  const entities = await extractEntitiesBatched(client, normalized, usage)

  const entityItems: Array<{ id: string; text: string }> = []
  for (const [itemId, ents] of entities) {
    for (const e of ents) entityItems.push({ id: `${itemId}:${e.surfaceText}`, text: e.surfaceText })
  }

  const entityEmbeddings = new Map<string, number[]>()
  if (entityItems.length > 0) {
    const entEmbs = await embedBatch(client, entityItems.map(e => e.text))
    for (let i = 0; i < entityItems.length; i++) entityEmbeddings.set(entityItems[i].id, entEmbs[i])
    usage.embedInputTokens += entityItems.reduce((s, it) => s + Math.ceil(it.text.length / 4), 0)
  }

  const stored = await storeResultsBulk(redis, items, embeddings, entities, entityEmbeddings)
  return { stored, usage }
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
      ...(raw.permalink && { permalink: raw.permalink }),
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

export interface BulkRedis {
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>
  zAdd(key: string, ...members: Array<{ member: string; score: number }>): Promise<number>
  hIncrBy(key: string, field: string, value: number): Promise<number>
}

export async function storeResultsBulk(
  redis: BulkRedis,
  rawItems: RawItem[],
  embeddings: Map<string, number[]>,
  entities: Map<string, Entity[]>,
  entityEmbeddings: Map<string, number[]>,
): Promise<number> {
  const itemFields: Record<string, string> = {}
  const embFields: Record<string, string> = {}
  const timeMembers: Array<{ member: string; score: number }> = []
  const decisionMembers: Array<{ member: string; score: number }> = []
  const authorBuckets = new Map<string, Array<{ member: string; score: number }>>()
  const threadBuckets = new Map<string, Array<{ member: string; score: number }>>()
  const entityEmbBuckets = new Map<string, Record<string, string>>()
  const entityIdxOps: Array<{ key: string; member: string; score: number }> = []
  const entitySurfaceOps = new Map<string, Record<string, string>>()
  const entityHubOps: Array<{ field: string }> = []

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
      ...(raw.permalink && { permalink: raw.permalink }),
      entities: ents,
      decision: 'pending',
      decisionAt: null,
      decisionBy: null,
      decisionReason: null,
    }

    itemFields[raw.id] = JSON.stringify(item)
    embFields[raw.id] = JSON.stringify(emb)
    timeMembers.push({ member: raw.id, score: raw.createdAt })
    decisionMembers.push({ member: raw.id, score: raw.createdAt })

    const authorKey = raw.authorId
    if (!authorBuckets.has(authorKey)) authorBuckets.set(authorKey, [])
    authorBuckets.get(authorKey)!.push({ member: raw.id, score: raw.createdAt })

    const threadKey = raw.threadRootId
    if (!threadBuckets.has(threadKey)) threadBuckets.set(threadKey, [])
    threadBuckets.get(threadKey)!.push({ member: raw.id, score: raw.createdAt })

    for (const e of ents) {
      entityIdxOps.push({ key: `strata:idx:entity:${e.type}:${e.surfaceText}`, member: raw.id, score: raw.createdAt })
      const surfKey = `strata:idx:entity-surfaces:${e.type}`
      if (!entitySurfaceOps.has(surfKey)) entitySurfaceOps.set(surfKey, {})
      entitySurfaceOps.get(surfKey)![e.surfaceText] = '1'
      entityHubOps.push({ field: `${e.type}:${e.surfaceText.toLowerCase()}` })

      const entEmb = entityEmbeddings.get(`${raw.id}:${e.surfaceText}`)
      if (entEmb) {
        const embKey = `strata:entity-emb:${e.type}`
        if (!entityEmbBuckets.has(embKey)) entityEmbBuckets.set(embKey, {})
        entityEmbBuckets.get(embKey)![`${raw.id}:${e.surfaceText}`] = quantize(entEmb)
      }
    }

    stored++
  }

  if (stored === 0) return 0

  const ZADD_CHUNK = 100
  async function chunkedZAdd(key: string, members: Array<{ member: string; score: number }>) {
    for (let i = 0; i < members.length; i += ZADD_CHUNK) {
      await redis.zAdd(key, ...members.slice(i, i + ZADD_CHUNK))
    }
  }

  await redis.hSet('strata:items', itemFields)
  await redis.hSet('strata:embeddings', embFields)
  await chunkedZAdd('strata:idx:time', timeMembers)
  await chunkedZAdd('strata:idx:decision:pending', decisionMembers)

  for (const [authorId, members] of authorBuckets) {
    await chunkedZAdd(`strata:idx:author:${authorId}`, members)
  }
  for (const [threadId, members] of threadBuckets) {
    await chunkedZAdd(`strata:idx:thread:${threadId}`, members)
  }

  const entityIdxGrouped = new Map<string, Array<{ member: string; score: number }>>()
  for (const op of entityIdxOps) {
    if (!entityIdxGrouped.has(op.key)) entityIdxGrouped.set(op.key, [])
    entityIdxGrouped.get(op.key)!.push({ member: op.member, score: op.score })
  }
  for (const [key, members] of entityIdxGrouped) {
    await chunkedZAdd(key, members)
  }

  for (const [key, fields] of entitySurfaceOps) {
    await redis.hSet(key, fields)
  }


  for (const [key, fields] of entityEmbBuckets) {
    await redis.hSet(key, fields)
  }

  return stored
}
