import type { KVStore } from './storage/interface.js'
import type { AlertStore } from './storage/alert-store.js'
import type { Item, Alert, AlertConnection, AlertEntity } from './types.js'
import type { ClassificationResult } from './classify.js'
import { cosine, dequantize } from './embed.js'
import { stringSimilarity } from './search.js'

const SCAN_TYPES = new Set(['object', 'username', 'phone', 'email', 'url', 'person', 'quantity', 'organization'])
const STRING_ONLY_TYPES = new Set(['quantity', 'url', 'username', 'phone', 'email'])

// Type weights — see H6 in tests/validate-scan-hypotheses.ts.
// object/quantity/phone/email/person identify individuals/incidents; location dominates in geo subs.
const TYPE_WEIGHT: Record<string, number> = {
  object: 1.0, quantity: 1.0, phone: 1.0, email: 1.0, person: 1.0, url: 0.8, username: 0.8,
  organization: 0.4, location: 0.2,
}

const ENTITY_STRING_THRESHOLD = 0.90
const ENTITY_EMBEDDING_THRESHOLD = 0.70
const HUB_FRACTION = 0.03
// Pre-merge: per-entity cluster cap. A single entity matching > 25 items is
// almost always a topic mention (Wu, Phil Eng, transit lines).
const MAX_ENTITY_CLUSTER_SIZE = 25
// Post-merge: a connected component of items linked through multiple entity
// channels can legitimately be larger than any single entity cluster. Scales
// with corpus; floor at 50, cap at 2% of N.
const MAX_COMPONENT_SIZE_FRAC = 0.02
const MAX_COMPONENT_SIZE_FLOOR = 50
// Two entity clusters merge if they share at least this many items. ≥2 prevents
// single-item bridges (random thread mention) from chaining unrelated topics.
// Multi-item overlap = two surface phrasings of the same referent.
const MERGE_OVERLAP_MIN = 2
const MIN_THREAD_COUNT = 3
const TIGHTNESS_MAX = 0.92
const COHERENCE_PEAK = 0.6
const COHERENCE_WIDTH = 0.45
const MAX_ANCHORS = 30
const RRF_K = 60

type EntityEntry = { itemId: string; surfaceText: string; embedding: number[]; type: string }

export type ScanPair = {
  anchorId: string
  connectionIds: string[]
  entitiesByItem: Map<string, AlertEntity[]>
}

function entityMatch(type: string, aSurface: string, aEmb: number[], bSurface: string, bEmb: number[]): number {
  const strSim = stringSimilarity(aSurface, bSurface)
  if (strSim >= ENTITY_STRING_THRESHOLD) return strSim
  if (STRING_ONLY_TYPES.has(type)) return 0
  if (aEmb.length === 0 || bEmb.length === 0) return 0
  const embSim = cosine(aEmb, bEmb)
  return embSim >= ENTITY_EMBEDDING_THRESHOLD ? embSim : 0
}

function specificity(surfaceText: string): number {
  const words = surfaceText.split(/\s+/).filter(w => w.length > 1).length
  return Math.min(words, 6)
}

function coherenceScore(tightness: number): number {
  return Math.max(0, 1 - Math.abs(tightness - COHERENCE_PEAK) / COHERENCE_WIDTH)
}

function rrfRank<T>(arr: T[], keyOf: (t: T) => string, metric: (t: T) => number): Map<string, number> {
  const sorted = [...arr].sort((a, b) => metric(b) - metric(a))
  const m = new Map<string, number>()
  for (let i = 0; i < sorted.length; i++) m.set(keyOf(sorted[i]), i + 1)
  return m
}

type EntityCluster = {
  leader: EntityEntry
  itemIds: Set<string>
  members: Array<{ itemId: string; surfaceText: string }>
  type: string
}

// A merged component is the connected component of clusters in the bipartite
// (item × cluster) graph — sub-clusters that share at least one item.
type ComponentGroup = {
  leader: EntityEntry
  itemIds: Set<string>
  subClusters: EntityCluster[]
  bridgeScore: Map<string, number>
}

function componentsByItemOverlap(clusters: EntityCluster[], maxComponentSize: number): ComponentGroup[] {
  if (clusters.length === 0) return []

  const itemToClusters = new Map<string, number[]>()
  for (let i = 0; i < clusters.length; i++) {
    for (const id of clusters[i].itemIds) {
      if (!itemToClusters.has(id)) itemToClusters.set(id, [])
      itemToClusters.get(id)!.push(i)
    }
  }

  const parent = new Array(clusters.length).fill(0).map((_, i) => i)
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }

  // Count pairwise overlap between cluster indices via the inverted index.
  // Two clusters merge only if they share ≥ MERGE_OVERLAP_MIN items, which
  // prevents single-item bridges from chaining unrelated topic clusters
  // together (e.g. one item mentioning both Orange Line and Cambridge PD
  // shouldn't merge all MBTA-topic clusters with all PD-rant clusters).
  const overlapCount = new Map<number, number>()
  for (const indices of itemToClusters.values()) {
    if (indices.length < 2) continue
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a] < indices[b] ? indices[a] : indices[b]
        const j = indices[a] < indices[b] ? indices[b] : indices[a]
        const key = (i << 16) | j
        overlapCount.set(key, (overlapCount.get(key) ?? 0) + 1)
      }
    }
  }
  for (const [key, count] of overlapCount) {
    if (count < MERGE_OVERLAP_MIN) continue
    const i = key >> 16, j = key & 0xffff
    const ri = find(i), rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }

  const groups = new Map<number, { subClusters: EntityCluster[]; itemIds: Set<string> }>()
  for (let i = 0; i < clusters.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, { subClusters: [], itemIds: new Set() })
    const g = groups.get(root)!
    g.subClusters.push(clusters[i])
    for (const id of clusters[i].itemIds) g.itemIds.add(id)
  }

  const result: ComponentGroup[] = []
  for (const g of groups.values()) {
    if (g.itemIds.size > maxComponentSize) continue
    const bridgeScore = new Map<string, number>()
    for (const sub of g.subClusters) {
      for (const id of sub.itemIds) bridgeScore.set(id, (bridgeScore.get(id) ?? 0) + 1)
    }
    const leader = g.subClusters
      .map(s => s.leader)
      .sort((a, b) => b.surfaceText.length - a.surfaceText.length)[0]
    result.push({ leader, itemIds: g.itemIds, subClusters: g.subClusters, bridgeScore })
  }
  return result
}

export async function buildScanPairs(store: KVStore): Promise<ScanPair[]> {
  const N = await store.getItemCount()
  if (N < 2) return []

  // 1) Load entity records for scan. Descriptive types come from the embedding
  //    bucket; string-only types (quantity/url/phone/email/username) come from
  //    the entity index, since ingest never embeds them.
  const entries: EntityEntry[] = []
  for (const type of SCAN_TYPES) {
    const minLen = STRING_ONLY_TYPES.has(type) ? 5 : 8
    if (STRING_ONLY_TYPES.has(type)) {
      const surfaces = await store.getEntityIndexEntries(type)
      for (const surface of surfaces) {
        if (surface.length < minLen) continue
        const itemIds = await store.getItemIdsByEntity(type, surface)
        for (const itemId of itemIds) {
          entries.push({ itemId, surfaceText: surface, embedding: [], type })
        }
      }
    } else {
      const raw = await store.getEntityEmbeddingsByType(type)
      for (const r of raw) {
        if (r.surfaceText.length < minLen) continue
        entries.push({ itemId: r.itemId, surfaceText: r.surfaceText, embedding: dequantize(r.embedding), type })
      }
    }
  }
  if (entries.length === 0) return []

  // Sort for determinism — leader-follower depends on iteration order.
  // Without this, different store-population orderings produce different clusters.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1
    if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1
    return a.surfaceText < b.surfaceText ? -1 : a.surfaceText > b.surfaceText ? 1 : 0
  })

  // 2) Leader-follower clustering on entities (each cluster = one "entity block")
  const entityClusters: EntityCluster[] = []
  for (const entry of entries) {
    let assigned = false
    for (const cluster of entityClusters) {
      if (cluster.leader.type !== entry.type) continue
      if (entityMatch(entry.type, entry.surfaceText, entry.embedding, cluster.leader.surfaceText, cluster.leader.embedding) > 0) {
        cluster.itemIds.add(entry.itemId)
        cluster.members.push({ itemId: entry.itemId, surfaceText: entry.surfaceText })
        assigned = true
        break
      }
    }
    if (!assigned) entityClusters.push({
      leader: entry,
      itemIds: new Set([entry.itemId]),
      members: [{ itemId: entry.itemId, surfaceText: entry.surfaceText }],
      type: entry.type,
    })
  }

  // 3) Filter hub entity clusters: drop singletons and any entity cluster whose
  //    single surface text matches more items than would be plausible for one
  //    real-world referent. Pre-merge cap is per-entity-cluster, not per-component.
  const entityClusterCap = Math.min(MAX_ENTITY_CLUSTER_SIZE, Math.max(5, Math.ceil(N * HUB_FRACTION)))
  const preMerge = entityClusters.filter(c => c.itemIds.size >= 2 && c.itemIds.size <= entityClusterCap)
  if (preMerge.length === 0) return []

  // 4) Build connected components on the (item × entity-cluster) bipartite graph.
  //    Two entity clusters belong to the same component if they share ≥2 items
  //    (prevents single-item bridges from chaining unrelated topics).
  const componentCap = Math.max(MAX_COMPONENT_SIZE_FLOOR, Math.floor(N * MAX_COMPONENT_SIZE_FRAC))
  const components = componentsByItemOverlap(preMerge, componentCap)
  if (components.length === 0) return []

  // 5) Load thread + embedding metadata for items in surviving components
  const allEmbeddings = await store.getAllEmbeddings()
  const itemThread = new Map<string, string>()
  const itemsNeeded = new Set<string>()
  for (const c of components) for (const id of c.itemIds) itemsNeeded.add(id)
  for (const id of itemsNeeded) {
    const stored = await store.getItem(id)
    if (stored) itemThread.set(id, stored.threadRootId)
  }

  // 5.5) Narrative satellites — mirror of surface()'s safety net. ONLY runs
  //      for components with a strong anchor (bridgeMax ≥ 3 = an item that
  //      links 3+ distinct entity channels — a real case post, not a topic
  //      mention). For those, find cross-thread items with high text cosine
  //      to the anchor and add at most NARRATIVE_MAX_SATELLITES per component.
  const NARRATIVE_MIN_BRIDGE = 3
  const NARRATIVE_SIGMA = 2.5
  const NARRATIVE_MAX_SATELLITES = 5
  for (const c of components) {
    // Pick the single richest anchor: highest bridge_score, tiebreak by entity
    // count (most "anchor-like" item). Using one specific anchor avoids the
    // noise of generic thread comments whose embeddings drift toward generic
    // safety-post topics.
    let bridgeItem: string | undefined
    let bestBridge = 0
    let bestEntities = 0
    for (const id of c.itemIds) {
      const b = c.bridgeScore.get(id) ?? 0
      if (b < NARRATIVE_MIN_BRIDGE) continue
      const stored = await store.getItem(id)
      if (!stored) continue
      const entCount = stored.entities.length
      if (b > bestBridge || (b === bestBridge && entCount > bestEntities)) {
        bestBridge = b
        bestEntities = entCount
        bridgeItem = id
      }
    }
    if (!bridgeItem) continue
    const bridgeEmb = allEmbeddings.get(bridgeItem)
    if (!bridgeEmb) continue
    const bridgeThread = itemThread.get(bridgeItem)

    const cosines: number[] = []
    const candidates: Array<{ id: string; cos: number }> = []
    for (const [id, emb] of allEmbeddings) {
      if (id === bridgeItem || c.itemIds.has(id)) continue
      const stored = await store.getItem(id)
      if (!stored || (bridgeThread && stored.threadRootId === bridgeThread)) continue
      const cos = cosine(bridgeEmb, emb)
      cosines.push(cos)
      candidates.push({ id, cos })
    }
    if (cosines.length === 0) continue
    const mean = cosines.reduce((s, x) => s + x, 0) / cosines.length
    const variance = cosines.reduce((s, x) => s + (x - mean) ** 2, 0) / cosines.length
    const threshold = mean + NARRATIVE_SIGMA * Math.sqrt(variance)
    candidates.sort((a, b) => b.cos - a.cos)
    let added = 0
    for (const cand of candidates) {
      if (cand.cos < threshold) break
      if (added >= NARRATIVE_MAX_SATELLITES) break
      c.itemIds.add(cand.id)
      const stored = await store.getItem(cand.id)
      if (stored) itemThread.set(cand.id, stored.threadRootId)
      added++
    }
  }

  // 6) Per-component stats. After merging, ranking uses 3 signals instead of 5
  //    — extraShared and specificity are subsumed by the component structure
  //    itself (sum of sub-cluster IDFs captures channel diversity).
  type ComponentStat = {
    component: ComponentGroup
    label: string
    ids: string[]
    threadCount: number
    tightness: number
    coherence: number
    sumIdf: number
    typeWeight: number
    bridgeMax: number
  }

  const stats: ComponentStat[] = []
  for (const c of components) {
    const ids = [...c.itemIds]
    const threads = new Set(ids.map(id => itemThread.get(id) ?? id))
    let sum = 0, pairs = 0
    for (let i = 0; i < ids.length; i++) {
      const ea = allEmbeddings.get(ids[i]); if (!ea) continue
      for (let j = i + 1; j < ids.length; j++) {
        const eb = allEmbeddings.get(ids[j]); if (!eb) continue
        sum += cosine(ea, eb); pairs++
      }
    }
    const tightness = pairs > 0 ? sum / pairs : 0

    // Sum-of-IDF across sub-clusters: rewards components built from many rare
    // entity blocks (buried-connection pattern) vs. one big topic block.
    const sumIdf = c.subClusters.reduce((acc, s) => acc + Math.log(N / s.itemIds.size), 0)
    // Max type weight across sub-clusters — incident-bearing types (object,
    // quantity, person) dominate over geographic/organizational ones.
    const typeWeight = Math.max(...c.subClusters.map(s => TYPE_WEIGHT[s.type] ?? 0.5))

    // bridgeMax: the most-connected item's degree (how many sub-clusters it
    // belongs to). A buried-witness component has a star topology — one anchor
    // item bridges multiple distinct channels (high bridgeMax). A topic chain
    // distributes membership uniformly (low bridgeMax).
    let bridgeMax = 0
    for (const id of ids) bridgeMax = Math.max(bridgeMax, c.bridgeScore.get(id) ?? 0)

    stats.push({
      component: c,
      label: `${c.leader.type}:${c.leader.surfaceText}`,
      ids,
      threadCount: threads.size,
      tightness,
      coherence: coherenceScore(tightness),
      sumIdf,
      typeWeight,
      bridgeMax,
    })
  }

  // 7) Gate: buried-connection signature requires ≥3 distinct threads + not duplicate-text spam
  const gated = stats.filter(s => s.threadCount >= MIN_THREAD_COUNT && s.tightness <= TIGHTNESS_MAX)
  if (gated.length === 0) return []

  // 8) Four rank signals, RRF-fused. Each is a structural property of the
  //    component, not a tuned magnitude.
  const keyOf = (s: ComponentStat) => s.label
  const rkIdf = rrfRank(gated, keyOf, s => s.sumIdf * s.typeWeight)
  const rkThreads = rrfRank(gated, keyOf, s => s.threadCount * s.typeWeight)
  const rkCoh = rrfRank(gated, keyOf, s => s.coherence)
  const rkBridge = rrfRank(gated, keyOf, s => s.bridgeMax * s.typeWeight)

  const ranked = gated.map(s => {
    const k = keyOf(s)
    return {
      ...s,
      rrf:
        1 / (RRF_K + rkIdf.get(k)!) +
        1 / (RRF_K + rkThreads.get(k)!) +
        1 / (RRF_K + rkCoh.get(k)!) +
        1 / (RRF_K + rkBridge.get(k)!),
    }
  }).sort((a, b) => b.rrf - a.rrf)

  // 9) Build anchor pairs from top components. Within a component, sort items
  //    by bridge score (count of sub-clusters they belong to) — the item with
  //    the most channels is the natural anchor, and decoys that joined via
  //    a single channel end up at the periphery.
  const pairs: ScanPair[] = []
  const used = new Set<string>()
  for (const c of ranked) {
    if (pairs.length >= MAX_ANCHORS) break
    const fresh = c.ids
      .filter(id => !used.has(id))
      .sort((a, b) => (c.component.bridgeScore.get(b) ?? 0) - (c.component.bridgeScore.get(a) ?? 0))
    if (fresh.length < 2) continue
    const anchorId = fresh[0]
    const connectionIds = fresh.slice(1)

    // Highlights only span bridging clusters — those holding the anchor AND
    // at least one connection. The purpose of a highlight is to explain why
    // this connection is linked to the anchor, so cross-connection overlaps
    // that never touch the anchor are intentionally not shown. clusterId is
    // shared across anchor and connection members so embedding-similar
    // phrasings ("Subaru Outback" / "dark green Subaru") light up together.
    const connSet = new Set(connectionIds)
    const entitiesByItem = new Map<string, AlertEntity[]>()
    const seenPerItem = new Map<string, Set<string>>()
    for (const sub of c.component.subClusters) {
      if (!sub.itemIds.has(anchorId)) continue
      let hasConn = false
      for (const id of sub.itemIds) if (connSet.has(id)) { hasConn = true; break }
      if (!hasConn) continue

      const clusterId = `${sub.type}:${sub.leader.surfaceText}`
      for (const m of sub.members) {
        if (m.itemId !== anchorId && !connSet.has(m.itemId)) continue
        const key = `${clusterId} ${m.surfaceText}`
        const seen = seenPerItem.get(m.itemId) ?? new Set<string>()
        if (seen.has(key)) continue
        seen.add(key)
        seenPerItem.set(m.itemId, seen)
        const list = entitiesByItem.get(m.itemId) ?? []
        list.push({ text: m.surfaceText, clusterId })
        entitiesByItem.set(m.itemId, list)
      }
    }

    pairs.push({ anchorId, connectionIds, entitiesByItem })
    used.add(anchorId)
    for (const id of connectionIds) used.add(id)
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
): Promise<string[]> {
  const newAlertIds: string[] = []

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

    // Body-presence filter: drop entity entries whose surface text isn't in
    // the body we'll actually render. Extraction reads `title + body` so a
    // title-only entity has nowhere to highlight on the rendered pane.
    const inBody = (needle: string, text: string) =>
      text.toLowerCase().includes(needle.toLowerCase())
    const filterByBody = (es: AlertEntity[], text: string) =>
      es.filter(e => inBody(e.text, text))

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
        entities: filterByBody(pair.entitiesByItem.get(item.id) ?? [], item.text),
        reasoning: cls.reason,
        createdAt: item.createdAt,
      })
    }

    if (connections.length === 0) continue

    // Only emit anchor entities that have a counterpart in some kept connection,
    // and that appear in the anchor body.
    const keptClusters = new Set<string>()
    for (const c of connections) for (const e of c.entities) keptClusters.add(e.clusterId)
    const anchorEntities = filterByBody(pair.entitiesByItem.get(anchor.id) ?? [], anchor.text)
      .filter(e => keptClusters.has(e.clusterId))

    const alert: Alert = {
      id: generateAlertId(),
      mode: 'surface',
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
      anchorEntities,
    }

    await alertStore.createAlert(alert, connections)
    newAlertIds.push(alert.id)
  }

  return newAlertIds
}
