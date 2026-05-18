import type { Entity, StoredItem, StoredRule } from '../types.js'

export interface KVStore {
  getItem(id: string): Promise<StoredItem | null>
  setItem(item: StoredItem): Promise<void>
  getItemIds(opts?: { timeRange?: [number, number] }): Promise<string[]>

  getEmbedding(id: string): Promise<number[] | null>
  setEmbedding(id: string, embedding: number[]): Promise<void>
  getEmbeddings(ids: string[]): Promise<Map<string, number[]>>
  getAllEmbeddings(): Promise<Map<string, number[]>>

  addToEntityIndex(entities: Entity[], itemId: string, createdAt: number): Promise<void>
  getItemIdsByEntity(type: string, canonical: string, timeRange?: [number, number]): Promise<string[]>

  getCanonicals(): Promise<Map<string, string[]>>
  addCanonicals(entities: Entity[]): Promise<void>

  getItemIdsByDecision(decision: string, timeRange?: [number, number]): Promise<string[]>
  moveDecision(itemId: string, from: string, to: string, at: number): Promise<void>

  getItemIdsByAuthor(authorId: string, timeRange?: [number, number]): Promise<string[]>
  getItemIdsByThread(threadRootId: string): Promise<string[]>

  addCase(itemId: string, at: number): Promise<void>
  getCases(timeRange?: [number, number]): Promise<string[]>

  getRules(): Promise<StoredRule[]>
  setRules(rules: StoredRule[]): Promise<void>
}
