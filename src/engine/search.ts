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
const STRING_ONLY_TYPES = new Set(['quantity', 'url', 'username', 'phone', 'email'])
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

function diceCoefficient(na: string, nb: string): number {
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

export function stringSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a)
  const nb = normalizeForMatch(b)
  if (na === nb) return 1.0
  if (na.includes(nb) || nb.includes(na)) return 0.95
  return diceCoefficient(na, nb)
}

// For identifiers (case#, plate, phone), substring matches are dangerous —
// different IDs can be substrings of each other (-K77 ⊂ K77 series). Use pure
// Dice without the substring shortcut.
function identifierSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a)
  const nb = normalizeForMatch(b)
  if (na === nb) return 1.0
  return diceCoefficient(na, nb)
}

function entityMatch(querySurface: string, queryEmb: number[], storedSurface: string, storedEmb: number[]): number {
  if (isIdentifierLike(querySurface) || isIdentifierLike(storedSurface)) {
    const idSim = identifierSimilarity(querySurface, storedSurface)
    return idSim >= STRING_THRESHOLD ? idSim : 0
  }

  const strSim = stringSimilarity(querySurface, storedSurface)
  if (strSim >= STRING_THRESHOLD) return strSim
  const embSim = cosine(queryEmb, storedEmb)
  if (embSim >= EMBEDDING_THRESHOLD) return embSim
  return 0
}

export async function hybridRetrieve(
  store: KVStore,
  queryEmbedding: number[],
  queryEntityEmbeddings: Array<{ type: string; surfaceText: string; embedding: number[] }>,
  opts?: { entityK?: number; safetyK?: number; excludeIds?: Set<string>; queryThreadRootId?: string },
): Promise<HybridResult> {
  const entityK = opts?.entityK ?? 30
  const excludeIds = opts?.excludeIds ?? new Set()
  const queryThread = opts?.queryThreadRootId

  // safetyK scales with corpus size: keep top 2%, with floor 30 and cap 300.
  // The cap matches the RRF meaningful-contribution horizon (1/(60+300) ≈ 0.003).
  const corpusSize = await store.getItemCount()
  const safetyK = opts?.safetyK ?? Math.min(300, Math.max(30, Math.floor(corpusSize * 0.02)))

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

  // Safety net catches narrative cross-thread witnesses (high cosine, weak entity overlap).
  // Exclude in-thread items so they don't crowd out the cross-thread cosine slots — they
  // already rank strongly via entity matches, they don't need the cosine path too.
  const safetyExcludes = new Set(excludeIds)
  if (queryThread) {
    const inThreadIds = await store.getItemIdsByThread(queryThread)
    for (const id of inThreadIds) safetyExcludes.add(id)
  }

  const [entityResults, safetyNetResults] = await Promise.all([
    entityFilter(store, queryEntityEmbeddings, entityK, excludeIds, isHub),
    safetyNet(store, queryEmbedding, safetyK, safetyExcludes),
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

  // Partition by thread: cross-thread items are the buried-connection value-add,
  // in-thread items are already visible to the moderator in the thread above.
  // Returning cross-thread first achieves the same effect as a numeric boost
  // without an arbitrary multiplier — RRF order is preserved within each stream.
  type Entry = { id: string; weight: number; stored: NonNullable<Awaited<ReturnType<typeof store.getItem>>> }
  const inThread: Entry[] = []
  const crossThread: Entry[] = []
  for (const [id, score] of rrfScores) {
    const stored = await store.getItem(id)
    if (!stored) continue
    const target = queryThread && stored.threadRootId === queryThread ? inThread : crossThread
    target.push({ id, weight: score, stored })
  }
  crossThread.sort((a, b) => b.weight - a.weight)
  inThread.sort((a, b) => b.weight - a.weight)

  const candidates: Hit[] = []
  for (const e of [...crossThread, ...inThread]) {
    const emb = await store.getEmbedding(e.id)
    candidates.push({ item: { ...e.stored, embedding: emb ?? [] }, weight: e.weight })
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
  const N = Math.max(1, await store.getItemCount())
  const idfWeightedScores = new Map<string, number>()
  const matchedEntities = new Map<string, Set<string>>()

  const addContribution = (itemId: string, score: number, clusterSize: number, querySurface: string) => {
    const idf = Math.log(N / Math.max(1, clusterSize))
    idfWeightedScores.set(itemId, (idfWeightedScores.get(itemId) ?? 0) + score * idf)
    if (!matchedEntities.has(itemId)) matchedEntities.set(itemId, new Set())
    matchedEntities.get(itemId)!.add(querySurface)
  }

  for (const queryEntity of queryEntityEmbeddings) {
    if (!STRONG_TYPES.has(queryEntity.type)) continue
    if (!STRING_ONLY_TYPES.has(queryEntity.type) && isHub(queryEntity.type, queryEntity.surfaceText)) continue

    if (STRING_ONLY_TYPES.has(queryEntity.type)) {
      const surfaces = await store.getEntityIndexEntries(queryEntity.type)
      const bestPerItem = new Map<string, { score: number; clusterSize: number }>()
      for (const surface of surfaces) {
        const strSim = identifierSimilarity(queryEntity.surfaceText, surface)
        if (strSim < STRING_THRESHOLD) continue
        const itemIds = await store.getItemIdsByEntity(queryEntity.type, surface)
        for (const itemId of itemIds) {
          if (excludeIds.has(itemId)) continue
          const existing = bestPerItem.get(itemId)
          if (!existing || strSim > existing.score) bestPerItem.set(itemId, { score: strSim, clusterSize: itemIds.length })
        }
      }
      for (const [itemId, m] of bestPerItem) addContribution(itemId, m.score, m.clusterSize, queryEntity.surfaceText)
      continue
    }

    const bucket = await store.getEntityEmbeddingsByType(queryEntity.type)
    if (bucket.length === 0) continue
    const surfaceCounts = new Map<string, number>()
    for (const entry of bucket) surfaceCounts.set(entry.surfaceText, (surfaceCounts.get(entry.surfaceText) ?? 0) + 1)

    const bestPerItem = new Map<string, { score: number; clusterSize: number }>()
    for (const entry of bucket) {
      if (excludeIds.has(entry.itemId)) continue
      if (isHub(queryEntity.type, entry.surfaceText)) continue
      const entryEmb = dequantize(entry.embedding)
      const score = entityMatch(queryEntity.surfaceText, queryEntity.embedding, entry.surfaceText, entryEmb)
      if (score === 0) continue
      const clusterSize = surfaceCounts.get(entry.surfaceText) ?? 1
      const existing = bestPerItem.get(entry.itemId)
      if (!existing || score > existing.score) bestPerItem.set(entry.itemId, { score, clusterSize })
    }
    for (const [itemId, m] of bestPerItem) addContribution(itemId, m.score, m.clusterSize, queryEntity.surfaceText)
  }

  const ranked = [...idfWeightedScores.entries()]
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

