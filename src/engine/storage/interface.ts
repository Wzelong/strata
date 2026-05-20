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
  getItemIdsByEntity(type: string, surfaceText: string, timeRange?: [number, number]): Promise<string[]>

  setEntityEmbeddings(itemId: string, entities: Array<{ type: string; surfaceText: string; embedding: string }>): Promise<void>
  getEntityEmbeddingsByType(type: string): Promise<Array<{ itemId: string; surfaceText: string; embedding: string }>>
  getEntityHubCounts(): Promise<Map<string, number>>
  incrEntityHubCount(key: string): Promise<void>

  getItemIdsByDecision(decision: string, timeRange?: [number, number]): Promise<string[]>
  moveDecision(itemId: string, from: string, to: string, at: number): Promise<void>

  getItemIdsByAuthor(authorId: string, timeRange?: [number, number]): Promise<string[]>
  getItemIdsByThread(threadRootId: string): Promise<string[]>

  addCase(itemId: string, at: number): Promise<void>
  getCases(timeRange?: [number, number]): Promise<string[]>

  getRules(): Promise<StoredRule[]>
  setRules(rules: StoredRule[]): Promise<void>

  getItemCount(): Promise<number>
  getOldestItemIds(n: number): Promise<string[]>
  deleteItems(ids: string[]): Promise<void>
}
