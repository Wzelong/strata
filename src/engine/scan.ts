import type { KVStore } from './storage/interface.js'
import type { AlertStore } from './storage/alert-store.js'
import type { Item, Alert, AlertConnection } from './types.js'
import type { ClassificationResult } from './classify.js'
import { cosine, dequantize } from './embed.js'
import { stringSimilarity } from './search.js'

const SCAN_TYPES = new Set(['object', 'username', 'phone', 'email', 'url', 'person', 'quantity', 'organization'])
const STRING_ONLY_TYPES = new Set(['quantity', 'url', 'username', 'phone', 'email'])
const MAX_ANCHORS = 10
const ENTITY_EMBEDDING_THRESHOLD = 0.70
const ENTITY_STRING_THRESHOLD = 0.90
const TEXT_SIMILARITY_THRESHOLD = 0.55
const HUB_FRACTION = 0.03

function entityMatch(type: string, aSurface: string, aEmb: number[], bSurface: string, bEmb: number[]): number {
  const strSim = stringSimilarity(aSurface, bSurface)
  if (strSim >= ENTITY_STRING_THRESHOLD) return strSim
  if (STRING_ONLY_TYPES.has(type)) return 0
  const embSim = cosine(aEmb, bEmb)
  if (embSim >= ENTITY_EMBEDDING_THRESHOLD) return embSim
  return 0
}

type EntityEntry = { itemId: string; surfaceText: string; embedding: number[]; type: string }

export type ScanPair = {
  anchorId: string
  connectionIds: string[]
  entities: string[]
}

export async function buildScanPairs(store: KVStore): Promise<ScanPair[]> {
  const allItems = await store.getItemIds()
  const N = allItems.length
  if (N < 2) return []

  // Step 1: Load entity embeddings
  const entries: EntityEntry[] = []
  for (const type of SCAN_TYPES) {
    const raw = await store.getEntityEmbeddingsByType(type)
    if (raw.length === 0) continue
    const minLen = STRING_ONLY_TYPES.has(type) ? 5 : 8
    for (const r of raw) {
      if (r.surfaceText.length < minLen) continue
      entries.push({
        itemId: r.itemId,
        surfaceText: r.surfaceText,
        embedding: STRING_ONLY_TYPES.has(type) ? [] : dequantize(r.embedding),
        type,
      })
    }
  }

  if (entries.length === 0) return []

  // Step 2: Cluster entities using leader-follower — O(entries × clusters)
  type Cluster = { leader: EntityEntry; members: EntityEntry[] }
  const clusters: Cluster[] = []

  for (const entry of entries) {
    let assigned = false
    for (const cluster of clusters) {
      if (cluster.leader.type !== entry.type) continue
      const score = entityMatch(entry.type, entry.surfaceText, entry.embedding, cluster.leader.surfaceText, cluster.leader.embedding)
      if (score > 0) {
        cluster.members.push(entry)
        assigned = true
        break
      }
    }
    if (!assigned) {
      clusters.push({ leader: entry, members: [entry] })
    }
  }

  // Step 3: For each non-hub cluster with 2+ items, check text embedding similarity
  // Entity overlap = blocking (reduces candidate pairs)
  // Text similarity = confirmation (eliminates topical false matches)
  const hubThreshold = Math.max(5, Math.ceil(N * HUB_FRACTION))
  const allEmbeddings = await store.getAllEmbeddings()

  type ConfirmedPair = { a: string; b: string; entities: Set<string>; textSim: number }
  const confirmedPairs = new Map<string, ConfirmedPair>()

  for (const cluster of clusters) {
    const uniqueItems = [...new Set(cluster.members.map(m => m.itemId))]
    if (uniqueItems.length < 2 || uniqueItems.length > hubThreshold) continue

    const entityLabel = `${cluster.leader.type}:${cluster.leader.surfaceText}`

    for (let i = 0; i < uniqueItems.length; i++) {
      const embA = allEmbeddings.get(uniqueItems[i])
      if (!embA) continue
      for (let j = i + 1; j < uniqueItems.length; j++) {
        const embB = allEmbeddings.get(uniqueItems[j])
        if (!embB) continue

        const textSim = cosine(embA, embB)
        if (textSim < TEXT_SIMILARITY_THRESHOLD) continue

        const key = uniqueItems[i] < uniqueItems[j]
          ? `${uniqueItems[i]}|${uniqueItems[j]}`
          : `${uniqueItems[j]}|${uniqueItems[i]}`

        const existing = confirmedPairs.get(key)
        if (existing) {
          existing.entities.add(entityLabel)
          existing.textSim = Math.max(existing.textSim, textSim)
        } else {
          confirmedPairs.set(key, {
            a: uniqueItems[i],
            b: uniqueItems[j],
            entities: new Set([entityLabel]),
            textSim,
          })
        }
      }
    }
  }

  // Step 4: Score by text_similarity × entity_rarity (IDF)
  const clusterSizes = new Map<string, number>()
  for (const cluster of clusters) {
    const size = new Set(cluster.members.map(m => m.itemId)).size
    if (size >= 2) clusterSizes.set(`${cluster.leader.type}:${cluster.leader.surfaceText}`, size)
  }

  const scoredPairs = [...confirmedPairs.values()]
    .map(pair => {
      let entityScore = 0
      for (const e of pair.entities) {
        const size = clusterSizes.get(e) ?? 2
        entityScore += Math.log(N / size)
      }
      return { ...pair, score: pair.textSim * entityScore }
    })
    .sort((a, b) => b.score - a.score)

  // Step 5: Group into anchor pairs
  const usedItems = new Set<string>()
  const pairs: ScanPair[] = []

  for (const { a, b, entities } of scoredPairs) {
    if (pairs.length >= MAX_ANCHORS) break
    if (usedItems.has(a) && usedItems.has(b)) continue

    const anchorId = usedItems.has(a) ? b : a
    const allEntities = new Set(entities)
    const connectionIds: string[] = []

    // Find other confirmed pairs involving the anchor
    for (const otherPair of confirmedPairs.values()) {
      const otherId = otherPair.a === anchorId ? otherPair.b
        : otherPair.b === anchorId ? otherPair.a : null
      if (!otherId || usedItems.has(otherId) || otherId === anchorId) continue
      connectionIds.push(otherId)
      for (const e of otherPair.entities) allEntities.add(e)
    }

    if (connectionIds.length === 0) {
      const otherId = a === anchorId ? b : a
      if (!usedItems.has(otherId)) connectionIds.push(otherId)
    }

    if (connectionIds.length === 0) continue

    pairs.push({ anchorId, connectionIds, entities: [...allEntities] })
    usedItems.add(anchorId)
    for (const id of connectionIds) usedItems.add(id)
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

    const existingAlertIds = await alertStore.getAlertIdsByAnchor(pair.anchorId)
    const existingConnectionIds = new Set<string>()
    for (const alertId of existingAlertIds) {
      const conns = await alertStore.getAlertConnections(alertId)
      for (const conn of conns) existingConnectionIds.add(conn.itemId)
    }

    const newCandidates = candidates.filter(c => !existingConnectionIds.has(c.id))
    if (newCandidates.length === 0) continue

    const classifications = await classifyBatch(anchor, newCandidates)

    const connections: AlertConnection[] = []
    for (const cls of classifications) {
      if (cls.relationship === 'UNRELATED') continue
      const item = newCandidates.find(c => c.id === cls.id)
      if (!item) continue

      connections.push({
        itemId: item.id,
        author: item.authorName,
        type: item.type,
        title: item.title,
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
      anchorType: anchor.type,
      anchorTitle: anchor.title,
      anchorText: anchor.text,
      anchorPermalink: buildPermalink(anchor, subredditName),
    }

    await alertStore.createAlert(alert, connections)
    alertsCreated++
  }

  return alertsCreated
}
