import type { KVStore } from './interface.js'
import type { Entity, StoredItem, StoredRule } from '../types.js'

export type RedisClient = {
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>
  hGet(key: string, field: string): Promise<string | undefined>
  hGetAll(key: string): Promise<Record<string, string>>
  hIncrBy(key: string, field: string, value: number): Promise<number>
  hScan(key: string, cursor: number, pattern?: string | undefined, count?: number): Promise<{ cursor: number; fieldValues: Record<string, string> | Array<{ field: string; value: string }> }>
  hDel(key: string, fields: string[]): Promise<number>
  zAdd(key: string, ...members: Array<{ member: string; score: number }>): Promise<number>
  zRange(key: string, start: number | string, stop: number | string, options?: { by?: 'score'; reverse?: boolean; limit?: { offset: number; count: number } }): Promise<Array<{ member: string; score: number }>>
  zRem(key: string, members: string[]): Promise<number>
  zCard(key: string): Promise<number>
  del(key: string): Promise<void>
}

export class RedisKVStore implements KVStore {
  private redis: RedisClient

  constructor(redis: RedisClient) {
    this.redis = redis
  }

  async getItem(id: string): Promise<StoredItem | null> {
    const raw = await this.redis.hGet('strata:items', id)
    if (!raw) return null
    return JSON.parse(raw) as StoredItem
  }

  async setItem(item: StoredItem): Promise<void> {
    await this.redis.hSet('strata:items', { [item.id]: JSON.stringify(item) })
    await this.redis.zAdd('strata:idx:time', { member: item.id, score: item.createdAt })
    await this.redis.zAdd(`strata:idx:author:${item.authorId}`, { member: item.id, score: item.createdAt })
    await this.redis.zAdd(`strata:idx:thread:${item.threadRootId}`, { member: item.id, score: item.createdAt })
    await this.redis.zAdd(`strata:idx:decision:${item.decision}`, {
      member: item.id,
      score: item.decisionAt ?? item.createdAt,
    })
  }

  async getItemIds(opts?: { timeRange?: [number, number] }): Promise<string[]> {
    if (opts?.timeRange) {
      const entries = await this.redis.zRange('strata:idx:time', opts.timeRange[0], opts.timeRange[1], { by: 'score' })
      return entries.map(e => e.member)
    }
    const entries = await this.redis.zRange('strata:idx:time', 0, -1)
    return entries.map(e => e.member)
  }

  async getEmbedding(id: string): Promise<number[] | null> {
    const raw = await this.redis.hGet('strata:embeddings', id)
    if (!raw) return null
    return JSON.parse(raw) as number[]
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.redis.hSet('strata:embeddings', { [id]: JSON.stringify(embedding) })
  }

  async getEmbeddings(ids: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>()
    for (const id of ids) {
      const emb = await this.getEmbedding(id)
      if (emb) result.set(id, emb)
    }
    return result
  }

  async getAllEmbeddings(): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>()
    let cursor = 0
    do {
      const scan = await this.redis.hScan('strata:embeddings', cursor, undefined, 500)
      cursor = scan.cursor
      const entries = scan.fieldValues as any
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          result.set(entry.field, typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value)
        }
      } else {
        for (const [field, value] of Object.entries(entries)) {
          result.set(field, typeof value === 'string' ? JSON.parse(value as string) : value as number[])
        }
      }
    } while (cursor !== 0)
    return result
  }

  async addToEntityIndex(entities: Entity[], itemId: string, createdAt: number): Promise<void> {
    for (const e of entities) {
      const key = `strata:idx:entity:${e.type}:${e.surfaceText}`
      await this.redis.zAdd(key, { member: itemId, score: createdAt })
      await this.redis.hSet(`strata:idx:entity-surfaces:${e.type}`, { [e.surfaceText]: '1' })
      await this.redis.hIncrBy('strata:entity-hub-counts', `${e.type}:${e.surfaceText.toLowerCase()}`, 1)
    }
  }

  async getItemIdsByEntity(type: string, surfaceText: string, timeRange?: [number, number]): Promise<string[]> {
    const key = `strata:idx:entity:${type}:${surfaceText}`
    if (timeRange) {
      const entries = await this.redis.zRange(key, timeRange[0], timeRange[1], { by: 'score' })
      return entries.map(e => e.member)
    }
    const entries = await this.redis.zRange(key, 0, -1)
    return entries.map(e => e.member)
  }

  async getEntityIndexEntries(type: string): Promise<string[]> {
    const all = await this.redis.hGetAll(`strata:idx:entity-surfaces:${type}`)
    return Object.keys(all)
  }

  async setEntityEmbeddings(itemId: string, entities: Array<{ type: string; surfaceText: string; embedding: string }>): Promise<void> {
    for (const e of entities) {
      const key = `strata:entity-emb:${e.type}`
      await this.redis.hSet(key, { [`${itemId}:${e.surfaceText}`]: e.embedding })
    }
  }

  async getEntityEmbeddingsByType(type: string): Promise<Array<{ itemId: string; surfaceText: string; embedding: string }>> {
    const key = `strata:entity-emb:${type}`
    const all = await this.redis.hGetAll(key)
    const results: Array<{ itemId: string; surfaceText: string; embedding: string }> = []
    for (const [field, value] of Object.entries(all)) {
      const colonIdx = field.indexOf(':')
      const itemId = field.slice(0, colonIdx)
      const surfaceText = field.slice(colonIdx + 1)
      results.push({ itemId, surfaceText, embedding: value })
    }
    return results
  }

  async getEntityHubCounts(): Promise<Map<string, number>> {
    const all = await this.redis.hGetAll('strata:entity-hub-counts')
    const result = new Map<string, number>()
    for (const [key, val] of Object.entries(all)) {
      result.set(key, parseInt(val, 10))
    }
    return result
  }

  async incrEntityHubCount(key: string): Promise<void> {
    await this.redis.hIncrBy('strata:entity-hub-counts', key, 1)
  }

  async getItemIdsByDecision(decision: string, timeRange?: [number, number]): Promise<string[]> {
    const key = `strata:idx:decision:${decision}`
    if (timeRange) {
      const entries = await this.redis.zRange(key, timeRange[0], timeRange[1], { by: 'score' })
      return entries.map(e => e.member)
    }
    const entries = await this.redis.zRange(key, 0, -1)
    return entries.map(e => e.member)
  }

  async moveDecision(itemId: string, from: string, to: string, at: number): Promise<void> {
    await this.redis.zRem(`strata:idx:decision:${from}`, [itemId])
    await this.redis.zAdd(`strata:idx:decision:${to}`, { member: itemId, score: at })
  }

  async getItemIdsByAuthor(authorId: string, timeRange?: [number, number]): Promise<string[]> {
    const key = `strata:idx:author:${authorId}`
    if (timeRange) {
      const entries = await this.redis.zRange(key, timeRange[0], timeRange[1], { by: 'score' })
      return entries.map(e => e.member)
    }
    const entries = await this.redis.zRange(key, 0, -1)
    return entries.map(e => e.member)
  }

  async getItemIdsByThread(threadRootId: string): Promise<string[]> {
    const key = `strata:idx:thread:${threadRootId}`
    const entries = await this.redis.zRange(key, 0, -1)
    return entries.map(e => e.member)
  }

  async addCase(itemId: string, at: number): Promise<void> {
    await this.redis.zAdd('strata:cases', { member: itemId, score: at })
  }

  async getCases(timeRange?: [number, number]): Promise<string[]> {
    if (timeRange) {
      const entries = await this.redis.zRange('strata:cases', timeRange[0], timeRange[1], { by: 'score' })
      return entries.map(e => e.member)
    }
    const entries = await this.redis.zRange('strata:cases', 0, -1)
    return entries.map(e => e.member)
  }

  async getRules(): Promise<StoredRule[]> {
    const raw = await this.redis.hGetAll('strata:rules')
    return Object.values(raw).map(v => JSON.parse(v) as StoredRule)
  }

  async setRules(rules: StoredRule[]): Promise<void> {
    const fields: Record<string, string> = {}
    for (const r of rules) {
      fields[r.id] = JSON.stringify(r)
    }
    if (Object.keys(fields).length > 0) {
      await this.redis.hSet('strata:rules', fields)
    }
  }

  async getItemCount(): Promise<number> {
    return this.redis.zCard('strata:idx:time')
  }

  async getOldestItemIds(n: number): Promise<string[]> {
    const entries = await this.redis.zRange('strata:idx:time', 0, n - 1)
    return entries.map(e => e.member)
  }

  async deleteItems(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    // Read items first to get their index keys
    for (const id of ids) {
      const raw = await this.redis.hGet('strata:items', id)
      if (!raw) continue
      const item = JSON.parse(raw) as StoredItem
      await this.redis.zRem(`strata:idx:author:${item.authorId}`, [id])
      await this.redis.zRem(`strata:idx:thread:${item.threadRootId}`, [id])
      await this.redis.zRem(`strata:idx:decision:${item.decision}`, [id])
    }
    await this.redis.hDel('strata:items', ids)
    await this.redis.hDel('strata:embeddings', ids)
    await this.redis.zRem('strata:idx:time', ids)
  }
}
