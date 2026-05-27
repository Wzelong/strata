import type { KVStore } from './interface.js'
import type { Entity, StoredItem, StoredRule } from '../types.js'

type ZEntry = { member: string; score: number }

function filterByRange(entries: ZEntry[], range?: [number, number]): string[] {
  if (!range) return entries.map(e => e.member)
  const [start, end] = range
  return entries.filter(e => e.score >= start && e.score <= end).map(e => e.member)
}

export class MemoryKVStore implements KVStore {
  private items = new Map<string, StoredItem>()
  private embeddings = new Map<string, number[]>()
  private timeline: ZEntry[] = []
  private entityIndex = new Map<string, ZEntry[]>()
  private entityEmbeddings = new Map<string, Array<{ itemId: string; surfaceText: string; embedding: string }>>()
  private entityHubCounts = new Map<string, number>()
  private decisionIndex = new Map<string, ZEntry[]>()
  private authorIndex = new Map<string, ZEntry[]>()
  private threadIndex = new Map<string, ZEntry[]>()
  private cases: ZEntry[] = []
  private rules: StoredRule[] = []

  async getItem(id: string): Promise<StoredItem | null> {
    return this.items.get(id) ?? null
  }

  async setItem(item: StoredItem): Promise<void> {
    this.items.set(item.id, item)
    this.timeline.push({ member: item.id, score: item.createdAt })

    if (!this.decisionIndex.has(item.decision)) this.decisionIndex.set(item.decision, [])
    this.decisionIndex.get(item.decision)!.push({
      member: item.id,
      score: item.decisionAt ?? item.createdAt,
    })

    const authorKey = item.authorId
    if (!this.authorIndex.has(authorKey)) this.authorIndex.set(authorKey, [])
    this.authorIndex.get(authorKey)!.push({ member: item.id, score: item.createdAt })

    const threadKey = item.threadRootId
    if (!this.threadIndex.has(threadKey)) this.threadIndex.set(threadKey, [])
    this.threadIndex.get(threadKey)!.push({ member: item.id, score: item.createdAt })
  }

  async getItemIds(opts?: { timeRange?: [number, number] }): Promise<string[]> {
    return filterByRange(this.timeline, opts?.timeRange)
  }

  async getEmbedding(id: string): Promise<number[] | null> {
    return this.embeddings.get(id) ?? null
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    this.embeddings.set(id, embedding)
  }

  async getEmbeddings(ids: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>()
    for (const id of ids) {
      const emb = this.embeddings.get(id)
      if (emb) result.set(id, emb)
    }
    return result
  }

  async getAllEmbeddings(): Promise<Map<string, number[]>> {
    return new Map(this.embeddings)
  }

  async addToEntityIndex(entities: Entity[], itemId: string, createdAt: number): Promise<void> {
    for (const e of entities) {
      const key = `${e.type}:${e.surfaceText}`
      if (!this.entityIndex.has(key)) this.entityIndex.set(key, [])
      this.entityIndex.get(key)!.push({ member: itemId, score: createdAt })
      const hubKey = `${e.type}:${e.surfaceText.toLowerCase()}`
      this.entityHubCounts.set(hubKey, (this.entityHubCounts.get(hubKey) ?? 0) + 1)
    }
  }

  async getItemIdsByEntity(type: string, surfaceText: string, timeRange?: [number, number]): Promise<string[]> {
    const key = `${type}:${surfaceText}`
    return filterByRange(this.entityIndex.get(key) ?? [], timeRange)
  }

  async getEntityIndexEntries(type: string): Promise<string[]> {
    const prefix = `${type}:`
    const result: string[] = []
    for (const key of this.entityIndex.keys()) {
      if (key.startsWith(prefix)) result.push(key.slice(prefix.length))
    }
    return result
  }

  async setEntityEmbeddings(itemId: string, entities: Array<{ type: string; surfaceText: string; embedding: string }>): Promise<void> {
    for (const e of entities) {
      if (!this.entityEmbeddings.has(e.type)) this.entityEmbeddings.set(e.type, [])
      this.entityEmbeddings.get(e.type)!.push({ itemId, surfaceText: e.surfaceText, embedding: e.embedding })
    }
  }

  async getEntityEmbeddingsByType(type: string): Promise<Array<{ itemId: string; surfaceText: string; embedding: string }>> {
    return this.entityEmbeddings.get(type) ?? []
  }

  async getEntityHubCounts(): Promise<Map<string, number>> {
    return new Map(this.entityHubCounts)
  }

  async incrEntityHubCount(key: string): Promise<void> {
    this.entityHubCounts.set(key, (this.entityHubCounts.get(key) ?? 0) + 1)
  }

  async getItemIdsByDecision(decision: string, timeRange?: [number, number]): Promise<string[]> {
    return filterByRange(this.decisionIndex.get(decision) ?? [], timeRange)
  }

  async moveDecision(itemId: string, from: string, to: string, at: number): Promise<void> {
    const fromList = this.decisionIndex.get(from)
    if (fromList) {
      const idx = fromList.findIndex(e => e.member === itemId)
      if (idx !== -1) fromList.splice(idx, 1)
    }
    if (!this.decisionIndex.has(to)) this.decisionIndex.set(to, [])
    this.decisionIndex.get(to)!.push({ member: itemId, score: at })
  }

  async getItemIdsByAuthor(authorId: string, timeRange?: [number, number]): Promise<string[]> {
    return filterByRange(this.authorIndex.get(authorId) ?? [], timeRange)
  }

  async getItemIdsByThread(threadRootId: string): Promise<string[]> {
    return filterByRange(this.threadIndex.get(threadRootId) ?? [])
  }

  async addCase(itemId: string, at: number): Promise<void> {
    this.cases.push({ member: itemId, score: at })
  }

  async getCases(timeRange?: [number, number]): Promise<string[]> {
    return filterByRange(this.cases, timeRange)
  }

  async getRules(): Promise<StoredRule[]> {
    return this.rules
  }

  async setRules(rules: StoredRule[]): Promise<void> {
    this.rules = rules
  }

  async getItemCount(): Promise<number> {
    return this.items.size
  }

  async getOldestItemIds(n: number): Promise<string[]> {
    const sorted = [...this.timeline].sort((a, b) => a.score - b.score)
    return sorted.slice(0, n).map(e => e.member)
  }

  async deleteItems(ids: string[]): Promise<void> {
    const idSet = new Set(ids)
    for (const id of ids) {
      const item = this.items.get(id)
      for (const e of item?.entities ?? []) {
        const key = `${e.type}:${e.surfaceText}`
        const arr = this.entityIndex.get(key)?.filter(x => x.member !== id)
        if (!arr || arr.length === 0) this.entityIndex.delete(key)
        else this.entityIndex.set(key, arr)
        const hubKey = `${e.type}:${e.surfaceText.toLowerCase()}`
        const c = (this.entityHubCounts.get(hubKey) ?? 0) - 1
        if (c <= 0) this.entityHubCounts.delete(hubKey)
        else this.entityHubCounts.set(hubKey, c)
      }
      this.items.delete(id)
      this.embeddings.delete(id)
    }
    this.timeline = this.timeline.filter(e => !idSet.has(e.member))
    for (const [type, arr] of this.entityEmbeddings) {
      const next = arr.filter(x => !idSet.has(x.itemId))
      if (next.length === 0) this.entityEmbeddings.delete(type)
      else this.entityEmbeddings.set(type, next)
    }
  }
}
