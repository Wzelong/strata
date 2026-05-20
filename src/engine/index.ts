import type OpenAI from 'openai'
import type { KVStore } from './storage/interface.js'
import type {
  Item, RawItem, RuleInput, Rule, Hit, Decision,
  Relationship, Recommendation, SearchFilter, CostTracker, StoredItem,
} from './types.js'
import { normalize } from './normalize.js'
import { embedBatch, embedSingle, cosine, quantize } from './embed.js'
import { extractEntities } from './extract.js'
import {
  hybridRetrieve, findSimilar, detectCampaign,
  type HybridResult, type CampaignOpts, type CampaignResult,
} from './search.js'
import { classifyRelationship, classifyBatch, type ClassificationResult } from './classify.js'
import { recommendDecision } from './recommend.js'

export class StrataEngine {
  private store: KVStore
  private client: OpenAI
  private cost?: CostTracker

  constructor(store: KVStore, client: OpenAI, cost?: CostTracker) {
    this.store = store
    this.client = client
    this.cost = cost
  }

  async ingest(raw: RawItem): Promise<Item> {
    const existing = await this.store.getItem(raw.id)
    if (existing) {
      const emb = await this.store.getEmbedding(raw.id)
      return { ...existing, embedding: emb ?? [] }
    }

    const textNormalized = normalize(raw.text)

    // Parallel: embed full text + extract entities
    const [embedding, entities] = await Promise.all([
      embedSingle(this.client, textNormalized, this.cost),
      extractEntities(this.client, textNormalized, this.cost),
    ])

    // Embed entity surfaceTexts (batch, sequential after extract)
    const entityTexts = entities.map(e => e.surfaceText)
    const entityEmbeddings = entityTexts.length > 0
      ? await embedBatch(this.client, entityTexts, this.cost)
      : []

    const stored: StoredItem = {
      id: raw.id,
      type: raw.type,
      text: raw.text,
      textNormalized,
      authorId: raw.authorId,
      authorName: raw.authorName,
      createdAt: raw.createdAt,
      threadRootId: raw.threadRootId,
      parentId: raw.parentId,
      entities,
      decision: 'pending',
      decisionAt: null,
      decisionBy: null,
      decisionReason: null,
    }

    await this.store.setItem(stored)
    await this.store.setEmbedding(raw.id, embedding)
    await this.store.addToEntityIndex(entities, raw.id, raw.createdAt)

    // Store quantized entity embeddings
    if (entityEmbeddings.length > 0) {
      const quantizedEntities = entities.map((e, i) => ({
        type: e.type,
        surfaceText: e.surfaceText,
        embedding: quantize(entityEmbeddings[i]),
      }))
      await this.store.setEntityEmbeddings(raw.id, quantizedEntities)
    }

    return { ...stored, embedding }
  }

  async ingestBatch(raws: RawItem[]): Promise<Item[]> {
    const normalized = raws.map(raw => ({
      raw,
      textNormalized: normalize(raw.text),
    }))

    // Batch embed all texts
    const embeddings = await embedBatch(
      this.client,
      normalized.map(n => n.textNormalized),
      this.cost,
    )

    // Extract entities concurrently
    const CONCURRENCY = 100
    const allEntities: Array<import('./types.js').Entity[]> = new Array(normalized.length)

    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const batch = normalized.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(n => extractEntities(this.client, n.textNormalized, this.cost))
      )
      for (let j = 0; j < results.length; j++) {
        allEntities[i + j] = results[j]
      }
    }

    // Batch embed all entity surfaceTexts
    const entityMeta: Array<{ itemIdx: number; entityIdx: number }> = []
    const entityTexts: string[] = []
    for (let i = 0; i < allEntities.length; i++) {
      for (let j = 0; j < allEntities[i].length; j++) {
        entityMeta.push({ itemIdx: i, entityIdx: j })
        entityTexts.push(allEntities[i][j].surfaceText)
      }
    }
    const entityEmbeddings = entityTexts.length > 0
      ? await embedBatch(this.client, entityTexts, this.cost)
      : []

    // Store everything
    const items: Item[] = []
    for (let i = 0; i < normalized.length; i++) {
      const { raw, textNormalized } = normalized[i]
      const entities = allEntities[i]
      const embedding = embeddings[i]

      const stored: StoredItem = {
        id: raw.id,
        type: raw.type,
        text: raw.text,
        textNormalized,
        authorId: raw.authorId,
        authorName: raw.authorName,
        createdAt: raw.createdAt,
        threadRootId: raw.threadRootId,
        parentId: raw.parentId,
        entities,
        decision: 'pending',
        decisionAt: null,
        decisionBy: null,
        decisionReason: null,
      }

      await this.store.setItem(stored)
      await this.store.setEmbedding(raw.id, embedding)
      await this.store.addToEntityIndex(entities, raw.id, raw.createdAt)

      // Store quantized entity embeddings
      const itemEntityEmbs = entityMeta
        .map((m, idx) => ({ ...m, idx }))
        .filter(m => m.itemIdx === i)
      if (itemEntityEmbs.length > 0) {
        const quantizedEntities = itemEntityEmbs.map(m => ({
          type: entities[m.entityIdx].type,
          surfaceText: entities[m.entityIdx].surfaceText,
          embedding: quantize(entityEmbeddings[m.idx]),
        }))
        await this.store.setEntityEmbeddings(raw.id, quantizedEntities)
      }

      items.push({ ...stored, embedding })
    }

    return items
  }

  async surface(item: Item, opts?: { topK?: number }): Promise<{ candidates: Hit[]; entityMatches: Map<string, string[]> }> {
    const topK = opts?.topK ?? 15

    const entityTexts = item.entities.map(e => e.surfaceText)
    const entityEmbeddings = entityTexts.length > 0
      ? await embedBatch(this.client, entityTexts, this.cost)
      : []

    const queryEntityEmbeddings = item.entities.map((e, i) => ({
      type: e.type,
      surfaceText: e.surfaceText,
      embedding: entityEmbeddings[i],
    }))

    const { candidates, entityMatches } = await hybridRetrieve(
      this.store,
      item.embedding,
      queryEntityEmbeddings,
      { excludeIds: new Set([item.id]) },
    )

    return { candidates: candidates.slice(0, topK), entityMatches }
  }

  // --- Accessors ---

  async getItem(id: string): Promise<Item | null> {
    const stored = await this.store.getItem(id)
    if (!stored) return null
    const emb = await this.store.getEmbedding(id)
    return { ...stored, embedding: emb ?? [] }
  }

  async getItems(ids: string[]): Promise<Item[]> {
    const items: Item[] = []
    for (const id of ids) {
      const item = await this.getItem(id)
      if (item) items.push(item)
    }
    return items
  }

  async findSimilar(emb: number[], k?: number, filter?: SearchFilter): Promise<Hit[]> {
    return findSimilar(this.store, emb, k, filter)
  }

  async detectCampaign(type: string, surfaceText: string, opts?: CampaignOpts): Promise<CampaignResult> {
    return detectCampaign(this.store, type, surfaceText, opts)
  }

  async getItemsByDecision(d: Decision, timeRange?: [number, number]): Promise<Item[]> {
    const ids = await this.store.getItemIdsByDecision(d, timeRange)
    return this.getItems(ids)
  }

  async getItemsByAuthor(authorId: string, timeRange?: [number, number]): Promise<Item[]> {
    const ids = await this.store.getItemIdsByAuthor(authorId, timeRange)
    return this.getItems(ids)
  }

  async getItemsByEntity(type: string, surfaceText: string, timeRange?: [number, number]): Promise<Item[]> {
    const ids = await this.store.getItemIdsByEntity(type, surfaceText, timeRange)
    return this.getItems(ids)
  }

  async getItemsInThread(threadRootId: string): Promise<Item[]> {
    const ids = await this.store.getItemIdsByThread(threadRootId)
    return this.getItems(ids)
  }

  async classifyRelationship(a: Item, b: Item): Promise<Relationship> {
    return classifyRelationship(this.client, a, b, this.cost)
  }

  async classifyBatch(caseItem: Item, candidates: Item[]): Promise<ClassificationResult[]> {
    return classifyBatch(this.client, caseItem, candidates.map(c => ({ id: c.id, text: c.text })), this.cost)
  }

  async recommendDecision(item: Item, precedents: Hit[], rules: Rule[]): Promise<Recommendation> {
    return recommendDecision(this.client, item, precedents, rules, this.cost)
  }

  async recordDecision(itemId: string, decision: Decision, by: string, reason?: string): Promise<void> {
    const item = await this.store.getItem(itemId)
    if (!item) return
    const now = Date.now()
    await this.store.moveDecision(itemId, item.decision, decision, now)
    const updated: StoredItem = { ...item, decision, decisionAt: now, decisionBy: by, decisionReason: reason ?? null }
    await this.store.setItem(updated)
  }

  async flagAsCase(itemId: string): Promise<void> {
    await this.store.addCase(itemId, Date.now())
  }

  async getCases(timeRange?: [number, number]): Promise<Item[]> {
    const ids = await this.store.getCases(timeRange)
    return this.getItems(ids)
  }

  async loadRules(inputs: RuleInput[]): Promise<void> {
    const texts = inputs.map(r => `${r.shortName}: ${r.description}`)
    const embeddings = await embedBatch(this.client, texts, this.cost)
    const rules = inputs.map((r, i) => ({ ...r, embedding: embeddings[i] }))
    await this.store.setRules(rules)
  }

  async getRules(): Promise<Rule[]> {
    return this.store.getRules()
  }
}

export { normalize } from './normalize.js'
export { cosine, quantize, dequantize } from './embed.js'
export { MemoryKVStore } from './storage/memory.js'
export { MemoryAlertStore } from './storage/memory-alert-store.js'
export type { KVStore } from './storage/interface.js'
export type { AlertStore } from './storage/alert-store.js'
export type { HybridResult, CampaignOpts, CampaignResult } from './search.js'
export type { ClassificationResult } from './classify.js'
export type * from './types.js'
