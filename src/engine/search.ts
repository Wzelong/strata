import type { KVStore } from './storage/interface.js'
import type { Item, Hit, SearchFilter, Entity } from './types.js'
import { cosine, dequantize } from './embed.js'

export type HybridResult = {
  candidates: Hit[]
  entityCount: number
  safetyNetCount: number
  entityMatches: Map<string, string[]>
}

const STRONG_TYPES = new Set(['object', 'username', 'phone', 'email', 'url', 'person', 'organization', 'location', 'quantity'])
const HUB_THRESHOLD = 0.03
const MIN_HUB_COUNT = 10
const EMBEDDING_THRESHOLD = 0.75
const STRING_THRESHOLD = 0.90

// --- Entity matching ---

const HAS_IDENTIFIER = /\d|@|\.com|\.org|\.net|#|\/\//

function isIdentifierLike(text: string): boolean {
  return HAS_IDENTIFIER.test(text)
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function stringSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a)
  const nb = normalizeForMatch(b)
  if (na === nb) return 1.0
  if (na.includes(nb) || nb.includes(na)) return 0.95
  // Character-level Dice coefficient
  const bigrams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ba = bigrams(na)
  const bb = bigrams(nb)
  let overlap = 0
  for (const bg of ba) { if (bb.has(bg)) overlap++ }
  return (2 * overlap) / (ba.size + bb.size) || 0
}

function entityMatch(querySurface: string, queryEmb: number[], storedSurface: string, storedEmb: number[]): number {
  const strSim = stringSimilarity(querySurface, storedSurface)
  const embSim = cosine(queryEmb, storedEmb)

  if (isIdentifierLike(querySurface) || isIdentifierLike(storedSurface)) {
    // Identifiers: characters matter, embedding can give false positives
    return strSim >= STRING_THRESHOLD ? strSim : 0
  }

  // Descriptive entities: either exact string match OR embedding match
  if (strSim >= STRING_THRESHOLD) return strSim
  if (embSim >= EMBEDDING_THRESHOLD) return embSim
  return 0
}

export async function hybridRetrieve(
  store: KVStore,
  queryEmbedding: number[],
  queryEntityEmbeddings: Array<{ type: string; surfaceText: string; embedding: number[] }>,
  opts?: { entityK?: number; safetyK?: number; excludeIds?: Set<string> },
): Promise<HybridResult> {
  const entityK = opts?.entityK ?? 30
  const safetyK = opts?.safetyK ?? 30
  const excludeIds = opts?.excludeIds ?? new Set()

  // Get hub counts for filtering
  const hubCounts = await store.getEntityHubCounts()
  const itemsPerType = new Map<string, number>()
  for (const [key, count] of hubCounts) {
    const type = key.split(':')[0]
    itemsPerType.set(type, (itemsPerType.get(type) ?? 0) + count)
  }

  function isHub(type: string, surfaceText: string): boolean {
    const key = `${type}:${surfaceText.toLowerCase()}`
    const count = hubCounts.get(key) ?? 0
    if (count < MIN_HUB_COUNT) return false
    const typeTotal = itemsPerType.get(type) ?? 1
    return count / typeTotal > HUB_THRESHOLD
  }

  const [entityResults, safetyNetResults] = await Promise.all([
    entityFilter(store, queryEntityEmbeddings, entityK, excludeIds, isHub),
    safetyNet(store, queryEmbedding, safetyK, excludeIds),
  ])

  // Reciprocal Rank Fusion (RRF)
  // Items found by both methods get boosted; entity-only items still get fair rank
  const RRF_K = 60
  const entityRanking = entityResults.ranked
  const safetyRanking = safetyNetResults.map(s => s.id)

  const rrfScores = new Map<string, number>()
  for (let i = 0; i < entityRanking.length; i++) {
    const id = entityRanking[i]
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i))
  }
  for (let i = 0; i < safetyRanking.length; i++) {
    const id = safetyRanking[i]
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + i))
  }

  // Sort by RRF score, build Hit objects
  const sorted = [...rrfScores.entries()].sort((a, b) => b[1] - a[1])
  const candidates: Hit[] = []

  for (const [id, score] of sorted) {
    const stored = await store.getItem(id)
    if (!stored) continue
    const emb = await store.getEmbedding(id)
    candidates.push({ item: { ...stored, embedding: emb ?? [] }, weight: score })
  }

  const entityMatches = new Map<string, string[]>()
  for (const [id, set] of entityResults.matchedEntities) {
    entityMatches.set(id, [...set])
  }

  return {
    candidates,
    entityCount: entityResults.ranked.length,
    safetyNetCount: safetyNetResults.length,
    entityMatches,
  }
}

async function entityFilter(
  store: KVStore,
  queryEntityEmbeddings: Array<{ type: string; surfaceText: string; embedding: number[] }>,
  k: number,
  excludeIds: Set<string>,
  isHub: (type: string, surfaceText: string) => boolean,
): Promise<{ ranked: string[]; matchedEntities: Map<string, Set<string>> }> {
  const bestScores = new Map<string, number>()
  const matchedEntities = new Map<string, Set<string>>()

  for (const queryEntity of queryEntityEmbeddings) {
    if (!STRONG_TYPES.has(queryEntity.type)) continue
    if (isHub(queryEntity.type, queryEntity.surfaceText)) continue

    const bucket = await store.getEntityEmbeddingsByType(queryEntity.type)
    if (bucket.length === 0) continue

    for (const entry of bucket) {
      if (excludeIds.has(entry.itemId)) continue
      if (isHub(queryEntity.type, entry.surfaceText)) continue

      const entryEmb = dequantize(entry.embedding)
      const score = entityMatch(queryEntity.surfaceText, queryEntity.embedding, entry.surfaceText, entryEmb)
      if (score === 0) continue

      const current = bestScores.get(entry.itemId) ?? 0
      if (score > current) bestScores.set(entry.itemId, score)

      if (!matchedEntities.has(entry.itemId)) matchedEntities.set(entry.itemId, new Set())
      matchedEntities.get(entry.itemId)!.add(queryEntity.surfaceText)
    }
  }

  const ranked = [...bestScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k * queryEntityEmbeddings.filter(e => STRONG_TYPES.has(e.type)).length)
    .map(([id]) => id)

  return { ranked, matchedEntities }
}

async function safetyNet(
  store: KVStore,
  queryEmbedding: number[],
  k: number,
  excludeIds: Set<string>,
): Promise<Array<{ id: string; score: number }>> {
  const allEmbeddings = await store.getAllEmbeddings()
  const scored: Array<{ id: string; score: number }> = []

  for (const [id, emb] of allEmbeddings) {
    if (excludeIds.has(id)) continue
    scored.push({ id, score: cosine(queryEmbedding, emb) })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

// Legacy exports for backward compatibility
export type IdentifierHit = { item: Item; matchedEntity: { type: string; surfaceText: string } }
export type Connection = { item: Item; mode: 'identifier' | 'similar' | 'campaign'; weight: number; matchedEntity?: { type: string; surfaceText: string } }
export type CampaignOpts = { windowMs?: number; minItems?: number; minAuthors?: number }
export type CampaignResult = { detected: boolean; items: Item[]; authorCount: number; entityKey: string }

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

export async function detectCampaign(
  store: KVStore,
  type: string,
  surfaceText: string,
  opts?: CampaignOpts,
): Promise<CampaignResult> {
  const windowMs = opts?.windowMs ?? 7 * 24 * 60 * 60 * 1000
  const minItems = opts?.minItems ?? 3
  const minAuthors = opts?.minAuthors ?? 3
  const entityKey = `${type}:${surfaceText}`

  const ids = await store.getItemIdsByEntity(type, surfaceText)
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
