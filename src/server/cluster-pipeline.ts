import type OpenAI from 'openai'
import type { KVStore } from '../engine/storage/interface.js'
import type { StoredItem } from '../engine/types.js'
import { quantize, dequantize } from '../engine/embed.js'
import {
  buildClusters, groupByCommunity, assignStableIds, centroidOf, liveAssign,
  MIN_CLUSTER_SIZE, type ExistingCluster,
} from '../engine/cluster.js'
import { labelClusters, type LabelTarget } from '../engine/cluster-label.js'
import { recordUsage } from './usage.js'

const KEY_COUNTER = 'strata:cluster:counter'
const KEY_IDS_BY_SIZE = 'strata:cluster:ids-by-size'
const KEY_CENTROIDS = 'strata:cluster:centroids'
const KEY_ALIASES = 'strata:cluster:alias'
const META_KEY = (id: number) => `strata:cluster:meta:${id}`

interface ClusterMeta {
  id: number
  label: string
  size: number
  createdAt: number
  updatedAt: number
}

type RedisLike = {
  get(k: string): Promise<string | null | undefined>
  set(k: string, v: string): Promise<string | void>
  del(k: string): Promise<number | void>
  hGet(k: string, f: string): Promise<string | null | undefined>
  hSet(k: string, fields: Record<string, string>): Promise<number>
  hGetAll(k: string): Promise<Record<string, string>>
  hDel(k: string, fields: string[]): Promise<number>
  zAdd(k: string, ...members: Array<{ member: string; score: number }>): Promise<number>
  zRange(k: string, start: number | string, stop: number | string, opts?: any): Promise<Array<{ member: string; score: number } | string>>
  zRem(k: string, members: string[]): Promise<number | void>
}

export interface ClusterListRow {
  id: number
  label: string
  size: number
}

export class ClusterRepo {
  constructor(private redis: RedisLike) {}

  async resolveAlias(id: number): Promise<number> {
    const target = await this.redis.hGet(KEY_ALIASES, String(id))
    return target ? parseInt(target, 10) : id
  }

  async getCentroids(): Promise<Map<number, number[]>> {
    const all = await this.redis.hGetAll(KEY_CENTROIDS)
    const out = new Map<number, number[]>()
    for (const [k, v] of Object.entries(all)) {
      const id = parseInt(k, 10)
      if (!Number.isFinite(id)) continue
      out.set(id, dequantize(v))
    }
    return out
  }

  async getMeta(id: number): Promise<ClusterMeta | null> {
    const resolved = await this.resolveAlias(id)
    const raw = await this.redis.hGetAll(META_KEY(resolved))
    if (!raw || !raw.label) return null
    return {
      id: resolved,
      label: raw.label,
      size: parseInt(raw.size ?? '0', 10) || 0,
      createdAt: parseInt(raw.createdAt ?? '0', 10) || 0,
      updatedAt: parseInt(raw.updatedAt ?? '0', 10) || 0,
    }
  }

  async listBySize(limit = 200): Promise<ClusterListRow[]> {
    const raw = await this.redis.zRange(KEY_IDS_BY_SIZE, 0, limit - 1, { by: 'rank', reverse: true })
    const out: ClusterListRow[] = []
    for (const entry of raw) {
      const idStr = typeof entry === 'string' ? entry : entry.member
      const id = parseInt(idStr, 10)
      const meta = await this.getMeta(id)
      if (meta) out.push({ id: meta.id, label: meta.label, size: meta.size })
    }
    return out
  }

  async getNextId(): Promise<number> {
    const cur = await this.redis.get(KEY_COUNTER)
    return cur ? parseInt(cur, 10) : 0
  }

  async reserveIdsUpTo(maxId: number): Promise<void> {
    const cur = await this.getNextId()
    if (maxId + 1 > cur) {
      await this.redis.set(KEY_COUNTER, String(maxId + 1))
    }
  }

  async writeCluster(meta: ClusterMeta, centroid: number[]): Promise<void> {
    await this.redis.hSet(META_KEY(meta.id), {
      label: meta.label,
      size: String(meta.size),
      createdAt: String(meta.createdAt),
      updatedAt: String(meta.updatedAt),
    })
    await this.redis.hSet(KEY_CENTROIDS, { [String(meta.id)]: quantize(centroid) })
    await this.redis.zAdd(KEY_IDS_BY_SIZE, { member: String(meta.id), score: meta.size })
  }

  async retireCluster(id: number, aliasTo?: number): Promise<void> {
    await this.redis.del(META_KEY(id))
    await this.redis.hDel(KEY_CENTROIDS, [String(id)])
    await this.redis.zRem(KEY_IDS_BY_SIZE, [String(id)])
    if (aliasTo !== undefined) {
      await this.redis.hSet(KEY_ALIASES, { [String(id)]: String(aliasTo) })
    }
  }

  async readAllExistingClusters(itemsByCluster: Map<number, string[]>): Promise<ExistingCluster[]> {
    const out: ExistingCluster[] = []
    for (const [id, members] of itemsByCluster) {
      if (id < 0) continue
      out.push({ id, members })
    }
    return out
  }
}

export interface ReclusterOptions {
  minClusterSize?: number
  resolution?: number
  parallelLabel?: number
  batchSize?: number
}

export interface ReclusterReport {
  totalItems: number
  clusters: number
  orphans: number
  kept: number
  created: number
  retired: number
  relabeled: number
  elapsedMs: number
}

interface PreparedCorpus {
  ids: string[]
  embeddings: number[][]
  itemsById: Map<string, StoredItem>
}

async function loadCorpus(store: KVStore): Promise<PreparedCorpus> {
  const ids = await store.getItemIds()
  const embMap = await store.getEmbeddings(ids)
  const itemEntries = await Promise.all(ids.map(async id => [id, await store.getItem(id)] as const))
  const itemsById = new Map<string, StoredItem>()
  const finalIds: string[] = []
  const embeddings: number[][] = []
  for (const [id, item] of itemEntries) {
    if (!item) continue
    const emb = embMap.get(id)
    if (!emb || emb.length === 0) continue
    itemsById.set(id, item)
    finalIds.push(id)
    embeddings.push(emb)
  }
  return { ids: finalIds, embeddings, itemsById }
}

export async function runRecluster(
  store: KVStore,
  redis: RedisLike,
  openai: OpenAI,
  opts?: ReclusterOptions,
): Promise<ReclusterReport> {
  const t0 = Date.now()
  const repo = new ClusterRepo(redis)
  const minSize = opts?.minClusterSize ?? MIN_CLUSTER_SIZE

  const { ids, embeddings, itemsById } = await loadCorpus(store)
  if (ids.length < minSize) {
    return { totalItems: ids.length, clusters: 0, orphans: ids.length, kept: 0, created: 0, retired: 0, relabeled: 0, elapsedMs: Date.now() - t0 }
  }

  const previousByCluster = new Map<number, string[]>()
  for (const id of ids) {
    const item = itemsById.get(id)
    const c = item?.clusterId
    if (c === undefined || c < 0) continue
    if (!previousByCluster.has(c)) previousByCluster.set(c, [])
    previousByCluster.get(c)!.push(id)
  }
  const existingClusters = await repo.readAllExistingClusters(previousByCluster)
  const previousLabels = new Map<number, string>()
  const previousSize = new Map<number, number>()
  for (const e of existingClusters) {
    const meta = await repo.getMeta(e.id)
    if (meta) { previousLabels.set(e.id, meta.label); previousSize.set(e.id, meta.size) }
  }

  const { communityByItem } = buildClusters(ids, embeddings, { resolution: opts?.resolution })
  const rawGroups = groupByCommunity(communityByItem)
  const labelableRaw = new Map<number, string[]>()
  for (const [raw, members] of rawGroups) if (members.length >= minSize) labelableRaw.set(raw, members)

  const nextId = await repo.getNextId()
  const { finalIdByRaw, retiredIds, newClusterIds, aliasUpdates } = assignStableIds(labelableRaw, existingClusters, nextId)

  const finalMembers = new Map<number, string[]>()
  for (const [raw, members] of labelableRaw) {
    const finalId = finalIdByRaw.get(raw)!
    finalMembers.set(finalId, members)
  }

  const indexById = new Map(ids.map((id, i) => [id, i]))
  const centroids = new Map<number, number[]>()
  for (const [id, members] of finalMembers) {
    const memberEmbs = members.map(m => embeddings[indexById.get(m)!])
    centroids.set(id, centroidOf(memberEmbs))
  }

  const needsRelabel: LabelTarget[] = []
  for (const [id, members] of finalMembers) {
    const prevSize = previousSize.get(id) ?? 0
    const prevLabel = previousLabels.get(id)
    const delta = prevSize === 0 ? 1 : Math.abs(members.length - prevSize) / prevSize
    if (prevLabel && delta < 0.2) continue
    const sampled = members.slice().sort(() => 0.5 - Math.random()).slice(0, 6)
      .map(mid => {
        const it = itemsById.get(mid)!
        return { title: it.title, text: it.text }
      })
    needsRelabel.push({ clusterId: id, samples: sampled })
  }

  const { labels: freshLabels } = await labelClusters(openai, needsRelabel, {
    batchSize: opts?.batchSize,
    parallel: opts?.parallelLabel,
  })

  const now = Date.now()
  const finalIds = [...finalMembers.keys()]
  const maxFinalId = finalIds.length > 0 ? Math.max(...finalIds) : nextId - 1
  await repo.reserveIdsUpTo(maxFinalId)

  for (const [id, members] of finalMembers) {
    const meta: ClusterMeta = {
      id,
      label: freshLabels.get(id) ?? previousLabels.get(id) ?? 'Untitled',
      size: members.length,
      createdAt: newClusterIds.includes(id) ? now : (previousByCluster.has(id) ? now - 1 : now),
      updatedAt: now,
    }
    await repo.writeCluster(meta, centroids.get(id)!)
  }

  for (const retired of retiredIds) {
    const alias = aliasUpdates.find(a => a.from === retired)
    await repo.retireCluster(retired, alias?.to)
  }

  const assignedItems = new Set<string>()
  for (const [id, members] of finalMembers) {
    for (const m of members) {
      assignedItems.add(m)
      const item = itemsById.get(m)
      if (!item) continue
      if (item.clusterId === id) continue
      await store.setItem({ ...item, clusterId: id })
    }
  }
  for (const id of ids) {
    if (assignedItems.has(id)) continue
    const item = itemsById.get(id)
    if (!item) continue
    if (item.clusterId === undefined || item.clusterId === -1) continue
    await store.setItem({ ...item, clusterId: -1 })
  }

  const totalInput = needsRelabel.length * 500
  const totalOutput = needsRelabel.length * 60
  if (needsRelabel.length > 0) {
    await recordUsage('gpt-5.4-mini', { inputTokens: totalInput, outputTokens: totalOutput })
  }

  return {
    totalItems: ids.length,
    clusters: finalMembers.size,
    orphans: ids.length - assignedItems.size,
    kept: finalIds.length - newClusterIds.length,
    created: newClusterIds.length,
    retired: retiredIds.length,
    relabeled: needsRelabel.length,
    elapsedMs: Date.now() - t0,
  }
}

export async function assignItemLive(
  redis: RedisLike,
  store: KVStore,
  itemId: string,
  embedding: number[],
): Promise<number> {
  const repo = new ClusterRepo(redis)
  const centroids = await repo.getCentroids()
  if (centroids.size === 0) return -1
  const { clusterId } = liveAssign(embedding, centroids)
  if (clusterId !== -1) {
    const item = await store.getItem(itemId)
    if (item && item.clusterId !== clusterId) {
      await store.setItem({ ...item, clusterId })
    }
  }
  return clusterId
}
