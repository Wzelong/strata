import type { KVStore } from './storage/interface.js'
import type { Item, Hit, SearchFilter } from './types.js'
import { cosine } from './embed.js'
import { isGlobal, computeHubScores } from './scope.js'

export type IdentifierHit = {
  item: Item
  matchedEntity: { type: string; canonical: string }
}

export type CampaignOpts = {
  windowMs?: number
  minItems?: number
  minAuthors?: number
}

export type CampaignResult = {
  detected: boolean
  items: Item[]
  authorCount: number
  entityKey: string
}

export type Connection = {
  item: Item
  mode: 'identifier' | 'similar' | 'campaign'
  weight: number
  matchedEntity?: { type: string; canonical: string }
}

// Mode 1: Direct lookup — exact entity match on global-scope identifiers
export async function findByIdentifier(
  store: KVStore,
  item: Item,
  hubScores?: Map<string, number>,
): Promise<IdentifierHit[]> {
  const scores = hubScores ?? await computeHubScores(store)
  const globalEntities = item.entities.filter(e => isGlobal(e, scores))
  const hits = new Map<string, IdentifierHit>()

  for (const entity of globalEntities) {
    const ids = await store.getItemIdsByEntity(entity.type, entity.canonical)
    for (const id of ids) {
      if (id === item.id) continue
      if (hits.has(id)) continue
      const stored = await store.getItem(id)
      if (!stored) continue
      const emb = await store.getEmbedding(id)
      hits.set(id, {
        item: { ...stored, embedding: emb ?? [] },
        matchedEntity: { type: entity.type, canonical: entity.canonical },
      })
    }
  }

  return [...hits.values()]
}

// Mode 2: Pattern match — pure embedding similarity
export async function findSimilar(
  store: KVStore,
  emb: number[],
  k: number = 10,
  filter?: SearchFilter,
): Promise<Hit[]> {
  const allEmbeddings = await store.getAllEmbeddings()
  const scored: Array<{ id: string; weight: number }> = []

  for (const [id, itemEmb] of allEmbeddings) {
    if (filter?.excludeIds?.has(id)) continue
    scored.push({ id, weight: cosine(emb, itemEmb) })
  }

  scored.sort((a, b) => b.weight - a.weight)

  const hits: Hit[] = []
  for (const { id, weight } of scored) {
    if (hits.length >= k) break
    const stored = await store.getItem(id)
    if (!stored) continue
    if (filter?.decision && !filter.decision.includes(stored.decision)) continue
    if (filter?.maxAge && stored.createdAt < Date.now() - filter.maxAge) continue
    const emb = await store.getEmbedding(id)
    hits.push({ item: { ...stored, embedding: emb ?? [] }, weight })
  }

  return hits
}

// Mode 3: Campaign detection — entity co-occurrence + temporal window + author diversity
export async function detectCampaign(
  store: KVStore,
  type: string,
  canonical: string,
  opts?: CampaignOpts,
): Promise<CampaignResult> {
  const windowMs = opts?.windowMs ?? 7 * 24 * 60 * 60 * 1000
  const minItems = opts?.minItems ?? 3
  const minAuthors = opts?.minAuthors ?? 3
  const entityKey = `${type}:${canonical}`

  const ids = await store.getItemIdsByEntity(type, canonical)
  if (ids.length < minItems) {
    return { detected: false, items: [], authorCount: 0, entityKey }
  }

  const items: Item[] = []
  for (const id of ids) {
    const stored = await store.getItem(id)
    if (!stored) continue
    const emb = await store.getEmbedding(id)
    items.push({ ...stored, embedding: emb ?? [] })
  }

  items.sort((a, b) => a.createdAt - b.createdAt)

  let bestCluster: Item[] = []
  for (let i = 0; i < items.length; i++) {
    const windowEnd = items[i].createdAt + windowMs
    const cluster = items.filter(it => it.createdAt >= items[i].createdAt && it.createdAt <= windowEnd)
    const authors = new Set(cluster.map(c => c.authorId))
    if (cluster.length >= minItems && authors.size >= minAuthors && cluster.length > bestCluster.length) {
      bestCluster = cluster
    }
  }

  const authors = new Set(bestCluster.map(c => c.authorId))
  return {
    detected: bestCluster.length >= minItems && authors.size >= minAuthors,
    items: bestCluster,
    authorCount: authors.size,
    entityKey,
  }
}

// Composed: run all modes, merge, dedupe
export async function findConnections(
  store: KVStore,
  item: Item,
  k: number = 10,
): Promise<Connection[]> {
  const hubScores = await computeHubScores(store)
  const seen = new Set<string>([item.id])
  const connections: Connection[] = []

  // Mode 1: identifier matches (highest confidence)
  const identifierHits = await findByIdentifier(store, item, hubScores)
  for (const hit of identifierHits) {
    if (seen.has(hit.item.id)) continue
    seen.add(hit.item.id)
    connections.push({
      item: hit.item,
      mode: 'identifier',
      weight: 1.0,
      matchedEntity: hit.matchedEntity,
    })
  }

  // Mode 2: semantic similarity
  const similarHits = await findSimilar(store, item.embedding, k, { excludeIds: seen })
  for (const hit of similarHits) {
    if (seen.has(hit.item.id)) continue
    seen.add(hit.item.id)
    connections.push({
      item: hit.item,
      mode: 'similar',
      weight: hit.weight,
    })
  }

  // Sort: identifier matches first, then by weight
  connections.sort((a, b) => {
    if (a.mode === 'identifier' && b.mode !== 'identifier') return -1
    if (b.mode === 'identifier' && a.mode !== 'identifier') return 1
    return b.weight - a.weight
  })

  return connections.slice(0, k)
}
