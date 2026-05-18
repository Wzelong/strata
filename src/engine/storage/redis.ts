import type { KVStore } from './interface.js'
import type { Entity, StoredItem, StoredRule } from '../types.js'

export type RedisClient = {
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>
  hGet(key: string, field: string): Promise<string | undefined>
  hGetAll(key: string): Promise<Record<string, string>>
  zAdd(key: string, ...members: Array<{ member: string; score: number }>): Promise<number>
  zRange(key: string, start: number, stop: number, options?: { by: 'score' }): Promise<Array<{ member: string; score: number }>>
  zRem(key: string, members: string[]): Promise<number>
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
    const raw = await this.redis.hGetAll('strata:embeddings')
    const result = new Map<string, number[]>()
    for (const [id, val] of Object.entries(raw)) {
      result.set(id, JSON.parse(val) as number[])
    }
    return result
  }

  async addToEntityIndex(entities: Entity[], itemId: string, createdAt: number): Promise<void> {
    for (const e of entities) {
      const key = `strata:idx:entity:${e.type}:${e.canonical}`
      await this.redis.zAdd(key, { member: itemId, score: createdAt })
    }
  }

  async getItemIdsByEntity(type: string, canonical: string, timeRange?: [number, number]): Promise<string[]> {
    const key = `strata:idx:entity:${type}:${canonical}`
    if (timeRange) {
      const entries = await this.redis.zRange(key, timeRange[0], timeRange[1], { by: 'score' })
      return entries.map(e => e.member)
    }
    const entries = await this.redis.zRange(key, 0, -1)
    return entries.map(e => e.member)
  }

  async getCanonicals(): Promise<Map<string, string[]>> {
    const raw = await this.redis.hGetAll('strata:canonicals')
    const result = new Map<string, string[]>()
    for (const [type, val] of Object.entries(raw)) {
      result.set(type, JSON.parse(val) as string[])
    }
    return result
  }

  async addCanonicals(entities: Entity[]): Promise<void> {
    const current = await this.getCanonicals()
    for (const e of entities) {
      if (!current.has(e.type)) current.set(e.type, [])
      const list = current.get(e.type)!
      if (!list.includes(e.canonical)) list.push(e.canonical)
    }
    const fields: Record<string, string> = {}
    for (const [type, canonicals] of current) {
      fields[type] = JSON.stringify(canonicals)
    }
    if (Object.keys(fields).length > 0) {
      await this.redis.hSet('strata:canonicals', fields)
    }
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
}
