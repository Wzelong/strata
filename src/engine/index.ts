import type OpenAI from 'openai'
import type { KVStore } from './storage/interface.js'
import type {
  Item, RawItem, RuleInput, Rule, Hit, Decision,
  Relationship, Recommendation, SearchFilter, CostTracker, StoredItem, FlagResult,
} from './types.js'
import { normalize } from './normalize.js'
import { embedBatch, embedSingle, cosine, quantize } from './embed.js'
import { extractEntities } from './extract.js'
import { hybridRetrieve, findSimilar, type HybridResult } from './search.js'
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

    const fullText = raw.title ? `${raw.title}\n\n${raw.text}` : raw.text
    const textNormalized = normalize(fullText)

    // Parallel: embed full text + extract entities
    const [embedding, entities] = await Promise.all([
      embedSingle(this.client, textNormalized, this.cost),
      extractEntities(this.client, textNormalized, this.cost),
    ])

    // Embed only descriptive entity types (identifiers match by string only)
    const EMBED_TYPES = new Set(['object', 'person', 'location', 'organization'])
    const embeddableEntities = entities.filter(e => EMBED_TYPES.has(e.type))
    const entityEmbeddings = embeddableEntities.length > 0
      ? await embedBatch(this.client, embeddableEntities.map(e => e.surfaceText), this.cost)
      : []

    const stored: StoredItem = {
      id: raw.id,
      type: raw.type,
      ...(raw.title && { title: raw.title }),
      text: raw.text,
      textNormalized,
      authorId: raw.authorId,
      authorName: raw.authorName,
      createdAt: raw.createdAt,
      threadRootId: raw.threadRootId,
      parentId: raw.parentId,
      ...(raw.permalink && { permalink: raw.permalink }),
      entities,
      decision: 'pending',
      decisionAt: null,
      decisionBy: null,
      decisionReason: null,
    }

    await this.store.setItem(stored)
    await this.store.setEmbedding(raw.id, embedding)
    await this.store.addToEntityIndex(entities, raw.id, raw.createdAt)

    if (entityEmbeddings.length > 0) {
      await this.store.setEntityEmbeddings(raw.id, embeddableEntities.map((e, i) => ({
        type: e.type,
        surfaceText: e.surfaceText,
        embedding: quantize(entityEmbeddings[i]),
      })))
    }

    return { ...stored, embedding }
  }

  async isNearDuplicate(embedding: number[], excludeId: string, threshold = 0.90): Promise<boolean> {
    const hits = await findSimilar(this.store, embedding, 1, { excludeIds: new Set([excludeId]) })
    return hits.length > 0 && hits[0].weight >= threshold
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
      { excludeIds: new Set([item.id]), queryThreadRootId: item.threadRootId },
    )

    return { candidates: candidates.slice(0, topK), entityMatches }
  }

  // --- Flag Pipeline ---

  async flag(item: Item): Promise<FlagResult[]> {
    const results = await Promise.all([
      this.checkRuleViolation(item),
      this.checkPatternMatch(item),
      this.checkBrigade(item),
    ])
    return results.filter((r): r is FlagResult => r !== null)
  }

  private async checkRuleViolation(item: Item): Promise<FlagResult | null> {
    const rules = await this.store.getRules()
    if (rules.length === 0) return null

    const recommendation = await recommendDecision(this.client, item, [], rules, this.cost)
    if (recommendation.recommendation !== 'remove') return null

    return {
      type: 'rule',
      confidence: 'high',
      reasoning: recommendation.rationale,
      anchorId: item.id,
      connectionItems: [],
      ruleId: recommendation.ruleId ?? undefined,
    }
  }

  private async checkPatternMatch(item: Item): Promise<FlagResult | null> {
    const precedents = await findSimilar(this.store, item.embedding, 5, {
      decision: ['removed'],
      excludeIds: new Set([item.id]),
    })
    const strong = precedents.filter(p => p.weight >= 0.5)
    console.log(`[Strata] pattern check: ${precedents.length} removed precedents, top cosine ${(precedents[0]?.weight ?? 0).toFixed(3)}, ${strong.length} ≥0.5`)
    if (strong.length === 0) return null

    const rules = await this.store.getRules()
    const recommendation = await recommendDecision(this.client, item, strong, rules, this.cost)
    if (recommendation.recommendation !== 'remove') {
      console.log(`[Strata] pattern: recommend=${recommendation.recommendation}, not firing`)
      return null
    }

    return {
      type: 'pattern',
      confidence: strong[0].weight >= 0.75 ? 'high' : 'review',
      reasoning: recommendation.rationale,
      anchorId: item.id,
      connectionItems: strong.map(h => h.item),
    }
  }

  private async checkBrigade(item: Item): Promise<FlagResult | null> {
    if (item.type !== 'comment') return null

    const threadItems = await this.getItemsInThread(item.threadRootId)
    if (threadItems.length < 4) return null

    // Sliding window: find densest cluster of comments around this item
    const WINDOW_MS = 4 * 60 * 60 * 1000
    const recentInThread = threadItems.filter(t =>
      t.id !== item.id &&
      Math.abs(t.createdAt - item.createdAt) <= WINDOW_MS
    )

    const authors = new Set(recentInThread.map(t => t.authorId))
    authors.add(item.authorId)

    // Need meaningful cluster: multiple distinct authors posting in a burst
    if (authors.size < 3 || recentInThread.length < 3) return null

    // Semantic uniformity: are they pushing the same narrative?
    const embeddings = recentInThread.slice(0, 10).map(t => t.embedding).filter(e => e.length > 0)
    if (embeddings.length < 3) return null

    let pairCount = 0, simSum = 0
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        simSum += cosine(embeddings[i], embeddings[j])
        pairCount++
      }
    }
    const avgSim = simSum / pairCount

    // Score combines density (authors/time) with uniformity (cosine)
    // A natural thread has diverse opinions (avg cosine ~0.3-0.4)
    // A brigade has coordinated messaging (avg cosine > 0.45)
    const densityScore = authors.size / (recentInThread.length + 1)
    const isBrigade = avgSim >= 0.45 && densityScore >= 0.5

    if (!isBrigade) return null

    return {
      type: 'brigade',
      confidence: avgSim >= 0.6 ? 'high' : 'review',
      reasoning: `${authors.size} distinct authors, ${recentInThread.length + 1} comments within ${WINDOW_MS / 3600000}h window, semantic uniformity ${avgSim.toFixed(2)}, density ${densityScore.toFixed(2)}`,
      anchorId: item.id,
      connectionItems: recentInThread.slice(0, 10),
    }
  }

  // --- Accessors ---

  async getItem(id: string): Promise<Item | null> {
    const stored = await this.store.getItem(id)
    if (!stored) return null
    const emb = await this.store.getEmbedding(id)
    return { ...stored, embedding: emb ?? [] }
  }

  async findSimilar(emb: number[], k?: number, filter?: SearchFilter): Promise<Hit[]> {
    return findSimilar(this.store, emb, k, filter)
  }

  async getItemsInThread(threadRootId: string): Promise<Item[]> {
    const ids = await this.store.getItemIdsByThread(threadRootId)
    const items: Item[] = []
    for (const id of ids) {
      const item = await this.getItem(id)
      if (item) items.push(item)
    }
    return items
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
export type { HybridResult } from './search.js'
export type { ClassificationResult } from './classify.js'
export type * from './types.js'
