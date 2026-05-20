import type { KVStore } from './storage/interface.js'
import type { AlertStore } from './storage/alert-store.js'
import type { Item, Alert, AlertConnection } from './types.js'
import type { ClassificationResult } from './classify.js'

const SCAN_STRONG_TYPES = new Set(['object', 'username', 'phone', 'email', 'url', 'person', 'quantity'])
const MAX_ENTITY_ITEMS = 5
const MIN_ENTITY_ITEMS = 2
const MAX_ANCHORS = 10

export type ScanPair = {
  anchorId: string
  connectionIds: string[]
  entities: string[]
}

export async function buildScanPairs(store: KVStore): Promise<ScanPair[]> {
  const allItems = await store.getItemIds()
  const N = allItems.length
  if (N < 2) return []

  // Build entity → items map from stored item entities (strong types only)
  const entityToItems = new Map<string, Set<string>>()
  for (const id of allItems) {
    const item = await store.getItem(id)
    if (!item) continue
    for (const e of item.entities) {
      if (!SCAN_STRONG_TYPES.has(e.type)) continue
      const key = `${e.type}:${e.surfaceText.toLowerCase()}`
      if (!entityToItems.has(key)) entityToItems.set(key, new Set())
      entityToItems.get(key)!.add(id)
    }
  }

  // Score each item by how many rare-entity connections it has
  // An item is interesting if it shares rare entities with other items
  const itemScore = new Map<string, { score: number; connections: Map<string, Set<string>> }>()

  for (const [entityKey, itemIds] of entityToItems) {
    if (itemIds.size < MIN_ENTITY_ITEMS || itemIds.size > MAX_ENTITY_ITEMS) continue
    const idf = Math.log(N / itemIds.size)
    const ids = [...itemIds]

    for (const id of ids) {
      if (!itemScore.has(id)) itemScore.set(id, { score: 0, connections: new Map() })
      const entry = itemScore.get(id)!
      entry.score += idf

      for (const otherId of ids) {
        if (otherId === id) continue
        if (!entry.connections.has(otherId)) entry.connections.set(otherId, new Set())
        entry.connections.get(otherId)!.add(entityKey)
      }
    }
  }

  // Pick top anchors by score (most rare-entity connections)
  const ranked = [...itemScore.entries()]
    .filter(([_, v]) => v.connections.size > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_ANCHORS)

  // Deduplicate: if anchor A has connection to B, don't also make B an anchor connecting to A
  const usedAsConnection = new Set<string>()
  const pairs: ScanPair[] = []

  for (const [anchorId, { connections }] of ranked) {
    if (usedAsConnection.has(anchorId)) continue

    const connectionIds: string[] = []
    const allEntities = new Set<string>()

    for (const [connId, entities] of connections) {
      if (usedAsConnection.has(connId)) continue
      connectionIds.push(connId)
      for (const e of entities) allEntities.add(e)
    }

    if (connectionIds.length === 0) continue

    pairs.push({
      anchorId,
      connectionIds,
      entities: [...allEntities],
    })

    for (const id of connectionIds) usedAsConnection.add(id)
  }

  return pairs
}

export async function classifyAndCreateAlerts(
  pairs: ScanPair[],
  getItem: (id: string) => Promise<Item | null>,
  classifyBatch: (anchor: Item, candidates: Item[]) => Promise<ClassificationResult[]>,
  alertStore: AlertStore,
  subredditName: string,
  buildPermalink: (item: Item, sub: string) => string,
  generateAlertId: () => string,
): Promise<number> {
  let alertsCreated = 0

  for (const pair of pairs) {
    const anchor = await getItem(pair.anchorId)
    if (!anchor) continue

    const candidates: Item[] = []
    for (const id of pair.connectionIds) {
      const item = await getItem(id)
      if (item) candidates.push(item)
    }
    if (candidates.length === 0) continue

    // One batch classify call per anchor (all its connections at once)
    const classifications = await classifyBatch(anchor, candidates)

    const connections: AlertConnection[] = []
    for (const cls of classifications) {
      if (cls.relationship === 'UNRELATED') continue
      const item = candidates.find(c => c.id === cls.id)
      if (!item) continue

      connections.push({
        itemId: item.id,
        author: item.authorName,
        text: item.text,
        permalink: buildPermalink(item, subredditName),
        classification: cls.relationship.toLowerCase() as AlertConnection['classification'],
        confidence: cls.confidence ?? 'review',
        entities: pair.entities.map(e => e.split(':').slice(1).join(':')),
        reasoning: cls.reason,
      })
    }

    if (connections.length === 0) continue

    const alert: Alert = {
      id: generateAlertId(),
      mode: 'flag',
      status: 'pending',
      confidence: connections.some(c => c.confidence === 'high') ? 'high' : 'review',
      connectionCount: connections.length,
      createdAt: Date.now(),
      anchorId: anchor.id,
      anchorAuthor: anchor.authorName,
      anchorText: anchor.text,
      anchorPermalink: buildPermalink(anchor, subredditName),
    }

    await alertStore.createAlert(alert, connections)
    alertsCreated++
  }

  return alertsCreated
}
