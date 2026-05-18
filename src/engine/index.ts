import type OpenAI from 'openai'
import type { KVStore } from './storage/interface.js'
import type {
  Item, RawItem, RuleInput, Rule, Hit, Decision,
  Relationship, Recommendation, SearchFilter, CostTracker, StoredItem,
} from './types.js'
import { normalize } from './normalize.js'
import { embedBatch, embedSingle, cosine } from './embed.js'
import { extractEntities } from './extract.js'
import {
  findByIdentifier, findSimilar, findConnections, detectCampaign,
  type IdentifierHit, type Connection, type CampaignOpts, type CampaignResult,
} from './search.js'
import { classifyRelationship } from './classify.js'
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
    const registry = await this.store.getCanonicals()
    const [embedding, entities] = await Promise.all([
      embedSingle(this.client, textNormalized, this.cost),
      extractEntities(this.client, textNormalized, registry, this.cost),
    ])

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
    await this.store.addCanonicals(entities)

    return { ...stored, embedding }
  }

  async ingestBatch(raws: RawItem[]): Promise<Item[]> {
    const normalized = raws.map(raw => ({
      raw,
      textNormalized: normalize(raw.text),
    }))

    const embeddings = await embedBatch(
      this.client,
      normalized.map(n => n.textNormalized),
      this.cost,
    )

    const CONCURRENCY = 100
    const allEntities: Array<import('./types.js').Entity[]> = new Array(normalized.length)

    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const batch = normalized.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(n => extractEntities(this.client, n.textNormalized, undefined, this.cost))
      )
      for (let j = 0; j < results.length; j++) {
        allEntities[i + j] = results[j]
      }
    }

    const registry = new Map<string, string[]>()
    for (const entityList of allEntities) {
      for (const e of entityList) {
        if (!registry.has(e.type)) registry.set(e.type, [])
        const list = registry.get(e.type)!
        if (!list.includes(e.canonical)) list.push(e.canonical)
      }
    }

    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const batch = normalized.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(n => extractEntities(this.client, n.textNormalized, registry, this.cost))
      )
      for (let j = 0; j < results.length; j++) {
        allEntities[i + j] = results[j]
      }
    }

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
      await this.store.addCanonicals(entities)

      items.push({ ...stored, embedding })
    }

    return items
  }

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

  async findByIdentifier(item: Item): Promise<IdentifierHit[]> {
    return findByIdentifier(this.store, item)
  }

  async findSimilar(emb: number[], k?: number, filter?: SearchFilter): Promise<Hit[]> {
    return findSimilar(this.store, emb, k, filter)
  }

  async detectCampaign(type: string, canonical: string, opts?: CampaignOpts): Promise<CampaignResult> {
    return detectCampaign(this.store, type, canonical, opts)
  }

  async findConnections(item: Item, k?: number): Promise<Connection[]> {
    return findConnections(this.store, item, k)
  }

  async getItemsByDecision(d: Decision, timeRange?: [number, number]): Promise<Item[]> {
    const ids = await this.store.getItemIdsByDecision(d, timeRange)
    return this.getItems(ids)
  }

  async getItemsByAuthor(authorId: string, timeRange?: [number, number]): Promise<Item[]> {
    const ids = await this.store.getItemIdsByAuthor(authorId, timeRange)
    return this.getItems(ids)
  }

  async getItemsByEntity(type: string, canonical: string, timeRange?: [number, number]): Promise<Item[]> {
    const ids = await this.store.getItemIdsByEntity(type, canonical, timeRange)
    return this.getItems(ids)
  }

  async getItemsInThread(threadRootId: string): Promise<Item[]> {
    const ids = await this.store.getItemIdsByThread(threadRootId)
    return this.getItems(ids)
  }

  async classifyRelationship(a: Item, b: Item): Promise<Relationship> {
    return classifyRelationship(this.client, a, b, this.cost)
  }

  async recommendDecision(item: Item, precedents: Hit[], rules: Rule[]): Promise<Recommendation> {
    return recommendDecision(this.client, item, precedents, rules, this.cost)
  }

  async recordDecision(itemId: string, decision: Decision, by: string, reason?: string): Promise<void> {
    const item = await this.store.getItem(itemId)
    if (!item) return

    const now = Date.now()
    await this.store.moveDecision(itemId, item.decision, decision, now)

    const updated: StoredItem = {
      ...item,
      decision,
      decisionAt: now,
      decisionBy: by,
      decisionReason: reason ?? null,
    }
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
    const rules = inputs.map((r, i) => ({
      ...r,
      embedding: embeddings[i],
    }))
    await this.store.setRules(rules)
  }

  async getRules(): Promise<Rule[]> {
    return this.store.getRules()
  }
}

export { normalize } from './normalize.js'
export { cosine } from './embed.js'
export { isGlobal, isHub, computeHubScores } from './scope.js'
export { MemoryKVStore } from './storage/memory.js'
export type { KVStore } from './storage/interface.js'
export type { IdentifierHit, Connection, CampaignOpts, CampaignResult } from './search.js'
export type * from './types.js'
