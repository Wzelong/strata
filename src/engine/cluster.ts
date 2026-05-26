import { UndirectedGraph } from 'graphology'
import * as louvainModule from 'graphology-communities-louvain'

type LouvainFn = (graph: unknown, opts?: { getEdgeWeight?: string; randomWalk?: boolean; resolution?: number }) => Record<string, number>
const louvain: LouvainFn = (louvainModule as unknown as { default?: LouvainFn }).default ?? (louvainModule as unknown as LouvainFn)

export const KNN_K = 20
export const KNN_THRESHOLD = 0.55
export const MIN_CLUSTER_SIZE = 10
export const LIVE_ASSIGN_THRESHOLD = 0.6
export const RELABEL_DELTA = 0.2
export const JACCARD_MATCH_THRESHOLD = 0.5
export const LOUVAIN_RESOLUTION = 0.5

export interface ClusterAssignment {
  clusterId: number
  size: number
  members: string[]
  centroid: number[]
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function normalize(v: number[]): number[] {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s) || 1
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

export function centroidOf(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return []
  const d = embeddings[0].length
  const sum = new Array(d).fill(0)
  for (const e of embeddings) for (let i = 0; i < d; i++) sum[i] += e[i]
  for (let i = 0; i < d; i++) sum[i] /= embeddings.length
  return normalize(sum)
}

export function buildClusters(
  ids: string[],
  embeddings: number[][],
  opts?: { k?: number; threshold?: number; resolution?: number },
): { communityByItem: Map<string, number>; rawCommunityIds: number[] } {
  const k = opts?.k ?? KNN_K
  const threshold = opts?.threshold ?? KNN_THRESHOLD
  const resolution = opts?.resolution ?? LOUVAIN_RESOLUTION
  const N = ids.length
  if (N === 0) return { communityByItem: new Map(), rawCommunityIds: [] }

  const normalized = embeddings.map(normalize)
  const graph = new UndirectedGraph({ allowSelfLoops: false })
  for (const id of ids) graph.addNode(id)

  for (let i = 0; i < N; i++) {
    const scores: Array<{ j: number; w: number }> = []
    for (let j = 0; j < N; j++) {
      if (i === j) continue
      const w = dot(normalized[i], normalized[j])
      if (w < threshold) continue
      scores.push({ j, w })
    }
    scores.sort((a, b) => b.w - a.w)
    for (const { j, w } of scores.slice(0, k)) {
      if (!graph.hasEdge(ids[i], ids[j])) graph.addEdge(ids[i], ids[j], { weight: w })
    }
  }

  const communities = louvain(graph, { getEdgeWeight: 'weight', randomWalk: false, resolution })
  const communityByItem = new Map<string, number>()
  const seen = new Set<number>()
  for (const id of ids) {
    const c = communities[id]
    communityByItem.set(id, c)
    seen.add(c)
  }
  return { communityByItem, rawCommunityIds: [...seen] }
}

export function groupByCommunity(communityByItem: Map<string, number>): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const [id, c] of communityByItem) {
    if (!out.has(c)) out.set(c, [])
    out.get(c)!.push(id)
  }
  return out
}

export interface ExistingCluster {
  id: number
  members: string[]
}

export interface StableAssignmentResult {
  finalIdByRaw: Map<number, number>
  retiredIds: number[]
  newClusterIds: number[]
  aliasUpdates: Array<{ from: number; to: number }>
}

export function assignStableIds(
  rawCommunities: Map<number, string[]>,
  existing: ExistingCluster[],
  nextAvailableId: number,
  opts?: { jaccardThreshold?: number },
): StableAssignmentResult {
  const threshold = opts?.jaccardThreshold ?? JACCARD_MATCH_THRESHOLD
  const existingSets = existing.map(e => ({ id: e.id, set: new Set(e.members) }))
  const matchScores: Array<{ raw: number; existing: number; jaccard: number; overlap: number }> = []

  for (const [raw, members] of rawCommunities) {
    const newSet = new Set(members)
    for (const e of existingSets) {
      let inter = 0
      for (const m of newSet) if (e.set.has(m)) inter++
      if (inter === 0) continue
      const union = newSet.size + e.set.size - inter
      const j = inter / union
      if (j >= threshold) matchScores.push({ raw, existing: e.id, jaccard: j, overlap: inter })
    }
  }
  matchScores.sort((a, b) => b.jaccard - a.jaccard)

  const finalIdByRaw = new Map<number, number>()
  const claimedExisting = new Set<number>()
  for (const m of matchScores) {
    if (finalIdByRaw.has(m.raw)) continue
    if (claimedExisting.has(m.existing)) continue
    finalIdByRaw.set(m.raw, m.existing)
    claimedExisting.add(m.existing)
  }

  let cursor = nextAvailableId
  const newClusterIds: number[] = []
  for (const raw of rawCommunities.keys()) {
    if (finalIdByRaw.has(raw)) continue
    finalIdByRaw.set(raw, cursor)
    newClusterIds.push(cursor)
    cursor++
  }

  const finalIds = new Set(finalIdByRaw.values())
  const retiredIds = existing.map(e => e.id).filter(id => !finalIds.has(id))

  const aliasUpdates: Array<{ from: number; to: number }> = []
  for (const retired of retiredIds) {
    const retiredMembers = existing.find(e => e.id === retired)!.members
    let best = { id: -1, overlap: 0 }
    for (const [raw, members] of rawCommunities) {
      let inter = 0
      const set = new Set(members)
      for (const m of retiredMembers) if (set.has(m)) inter++
      if (inter > best.overlap) best = { id: finalIdByRaw.get(raw)!, overlap: inter }
    }
    if (best.id !== -1) aliasUpdates.push({ from: retired, to: best.id })
  }

  return { finalIdByRaw, retiredIds, newClusterIds, aliasUpdates }
}

export function liveAssign(
  embedding: number[],
  centroidsById: Map<number, number[]>,
  opts?: { threshold?: number },
): { clusterId: number; score: number } {
  const threshold = opts?.threshold ?? LIVE_ASSIGN_THRESHOLD
  const e = normalize(embedding)
  let best = { id: -1, score: -1 }
  for (const [id, c] of centroidsById) {
    const score = dot(e, c)
    if (score > best.score) best = { id, score }
  }
  if (best.score < threshold) return { clusterId: -1, score: best.score }
  return { clusterId: best.id, score: best.score }
}

export function jaccardOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const A = new Set(a)
  let inter = 0
  for (const x of b) if (A.has(x)) inter++
  const union = A.size + b.length - inter
  return union === 0 ? 0 : inter / union
}
