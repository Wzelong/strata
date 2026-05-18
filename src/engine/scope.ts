import type { Entity } from './types.js'
import type { KVStore } from './storage/interface.js'

export type Scope = 'global' | 'local'

const HUB_THRESHOLD = 0.15

const ALWAYS_GLOBAL_TYPES = new Set(['phone', 'url', 'email', 'username'])

export async function computeHubScores(store: KVStore): Promise<Map<string, number>> {
  const allIds = await store.getItemIds()
  const entityCounts = new Map<string, number>()

  for (const id of allIds) {
    const item = await store.getItem(id)
    if (!item) continue
    const seen = new Set<string>()
    for (const e of item.entities) {
      const key = `${e.type}:${e.canonical}`
      if (seen.has(key)) continue
      seen.add(key)
      entityCounts.set(key, (entityCounts.get(key) ?? 0) + 1)
    }
  }

  const maxCount = Math.max(...entityCounts.values(), 1)
  const scores = new Map<string, number>()
  for (const [key, count] of entityCounts) {
    scores.set(key, count / maxCount)
  }
  return scores
}

export function isHub(entity: Entity, hubScores: Map<string, number>): boolean {
  if (ALWAYS_GLOBAL_TYPES.has(entity.type)) return false
  const key = `${entity.type}:${entity.canonical}`
  return (hubScores.get(key) ?? 0) > HUB_THRESHOLD
}

export function isGlobal(entity: Entity, hubScores?: Map<string, number>): boolean {
  if (ALWAYS_GLOBAL_TYPES.has(entity.type)) return true
  if (hubScores && isHub(entity, hubScores)) return false
  return true
}
