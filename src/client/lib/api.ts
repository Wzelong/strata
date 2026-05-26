import type { Alert, AlertConnection, AlertStatus, Decision } from '../../engine/types.js'

async function readJson<T>(res: Response, fallback: string): Promise<T | { error: string }> {
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: text }
    }
  }
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : res.statusText || fallback
    return { error: `${fallback} (${res.status}): ${message}` }
  }
  return (parsed ?? {}) as T
}

export interface AlertListItem extends Alert {}

export type AlertConnectionWithDecision = AlertConnection & { decision?: Decision }

export interface AlertDetail extends Alert {
  connections: AlertConnectionWithDecision[]
  anchorDecision?: Decision
}

export interface ItemListItem {
  id: string
  type: 'post' | 'comment'
  title?: string
  text: string
  authorName: string
  createdAt: number
  entityCount: number
  commentCount?: number
}

export interface ItemsPage {
  items: ItemListItem[]
  nextCursor: number | null
  total: number
}

export async function fetchAlerts(opts?: { status?: AlertStatus; limit?: number }): Promise<{ alerts: AlertListItem[]; nextCursor: number | null }> {
  const params = new URLSearchParams()
  if (opts?.status) params.set('status', opts.status)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const res = await fetch(`/api/alerts?${params}`)
  return res.json()
}

export async function fetchAlertDetail(id: string): Promise<AlertDetail> {
  const res = await fetch(`/api/alerts/${id}`)
  return res.json()
}

export interface PostDetailComment {
  id: string
  text: string
  author: string
  createdAt: number
  entities: Array<{ text: string; clusterId: string }>
  clusterLabel?: string | null
}

export interface PostDetail {
  post: {
    id: string
    title: string | null
    text: string
    author: string
    createdAt: number
    entities: Array<{ text: string; clusterId: string }>
    clusterLabel: string | null
    replyCount: number
    permalink?: string
  }
  comments: PostDetailComment[]
}

export async function fetchPostDetail(id: string): Promise<PostDetail | null> {
  const res = await fetch(`/api/threads/${id}`)
  if (!res.ok) return null
  const raw = await res.json()
  if (!raw?.post) return null
  return {
    post: raw.post,
    comments: (raw.comments ?? []).map((c: Record<string, unknown>) => ({
      id: c.id as string,
      text: c.text as string,
      author: c.author as string,
      createdAt: (c.createdAt as number) ?? (c.created_at as number),
      entities: (c.entities as Array<{ text: string; clusterId: string }>) ?? [],
      clusterLabel: (c.cluster_label as string | null) ?? null,
    })),
  }
}

export async function alertAction(id: string, action: 'resolved' | 'dismissed'): Promise<void> {
  const res = await fetch(`/api/alerts/${id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const parsed = await readJson<{ ok: boolean }>(res, 'Alert action failed')
  if ('error' in parsed) throw new Error(parsed.error)
}

export async function removeItem(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/items/${encodeURIComponent(id)}/remove`, { method: 'POST' })
  return res.json()
}

export async function approveItem(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/items/${encodeURIComponent(id)}/approve`, { method: 'POST' })
  return res.json()
}

export async function bulkRemoveAlert(id: string): Promise<{ ok: boolean; removed: number; error?: string }> {
  const res = await fetch(`/api/alerts/${id}/bulk-remove`, { method: 'POST' })
  return res.json()
}

export async function bulkLockAlert(id: string): Promise<{ ok: boolean; threadRootId?: string; error?: string }> {
  const res = await fetch(`/api/alerts/${id}/bulk-lock`, { method: 'POST' })
  return res.json()
}

export interface ComposeDraft {
  title: string
  body: string
}

export async function composeAlertPost(id: string, opts?: { refinementPrompt?: string; currentDraft?: ComposeDraft }): Promise<ComposeDraft | { error: string }> {
  const res = await fetch(`/api/alerts/${id}/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  })
  return readJson<ComposeDraft>(res, 'Draft generation failed')
}

export async function publishAlertPost(id: string, draft: ComposeDraft): Promise<{ ok?: boolean; postId?: string; permalink?: string; publishedAt?: number; publishedBy?: string; error?: string }> {
  const res = await fetch(`/api/alerts/${id}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  return readJson<{ ok: boolean; postId?: string; permalink?: string; publishedAt?: number; publishedBy?: string; error?: string }>(res, 'Publish failed')
}

export async function fetchItems(opts?: { limit?: number; cursor?: number; type?: string; search?: string }): Promise<ItemsPage> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.cursor) params.set('cursor', String(opts.cursor))
  if (opts?.type) params.set('type', opts.type)
  if (opts?.search) params.set('search', opts.search)
  const res = await fetch(`/api/items?${params}`)
  return res.json()
}

export async function fetchStats(): Promise<{ itemCount: number; capacity: number; hasApiKey: boolean; apiKeyInvalid: boolean }> {
  const res = await fetch('/api/stats')
  return res.json()
}

export async function recheckApiKey(): Promise<void> {
  await fetch('/api/apikey/recheck', { method: 'POST' })
}

export async function saveApiKey(key: string): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch('/api/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  return res.json()
}

export async function deleteApiKey(): Promise<void> {
  await fetch('/api/apikey', { method: 'DELETE' })
}

export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  calls: number
  costCents: number
}

export interface UsageSummary {
  today: ModelUsage[]
  month: ModelUsage[]
  totals: { today: ModelUsage; month: ModelUsage }
}

export async function fetchUsage(): Promise<UsageSummary> {
  const res = await fetch('/api/usage')
  return res.json()
}

export async function fetchCommunityContext(): Promise<string> {
  const res = await fetch('/api/community-context')
  const data = await res.json()
  return typeof data?.text === 'string' ? data.text : ''
}

export async function saveCommunityContext(text: string): Promise<void> {
  await fetch('/api/community-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export interface ClusterStatus {
  lastRun: number
  totalItems: number
  clusters: number
  orphans: number
  relabeled: number
  elapsedMs: number
  pendingItems: number
}

export async function fetchClusterStatus(): Promise<ClusterStatus> {
  const res = await fetch('/api/clusters/status')
  return res.json()
}

export async function triggerRecluster(): Promise<{ clusters: number; orphans: number; relabeled: number; elapsedMs: number } | { error: string }> {
  const res = await fetch('/api/clusters/recluster', { method: 'POST' })
  return res.json()
}

export interface ClusterConfig {
  resolution: number
  minClusterSize: number
  defaults: { resolution: number; minClusterSize: number }
}

export async function fetchClusterConfig(): Promise<ClusterConfig> {
  const res = await fetch('/api/clusters/config')
  return res.json()
}

export async function saveClusterConfig(patch: { resolution?: number; minClusterSize?: number }): Promise<ClusterConfig> {
  const res = await fetch('/api/clusters/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return res.json()
}

export interface ClusterListItem {
  id: string
  label: string
  isOrphan: boolean
  postCount: number
  commentCount: number
  recentCount: number
  lastActivity: number
  hotScore: number
}

export async function fetchClusters(sort: 'hot' | 'size' | 'name' = 'hot'): Promise<ClusterListItem[]> {
  const res = await fetch(`/api/clusters?sort=${sort}`)
  const raw = await res.json()
  return raw.clusters ?? []
}

export interface ClusterDetailPost {
  id: string
  title: string | null
  text: string
  author: string
  createdAt: number
  commentCount: number
  permalink: string
}

export interface ClusterDetail {
  id: string
  label: string
  isOrphan: boolean
  postCount: number
  commentCount: number
  recentCount: number
  lastActivity: number
  posts: ClusterDetailPost[]
}

export async function fetchEntityMatches(id: string): Promise<string[]> {
  const res = await fetch(`/api/items/${encodeURIComponent(id)}/entity-matches`)
  if (!res.ok) return []
  const raw = await res.json()
  return raw.matchedIds ?? []
}

export async function fetchClusterDetail(id: string): Promise<ClusterDetail | null> {
  const res = await fetch(`/api/clusters/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const raw = await res.json()
  if (!raw?.id) return null
  return raw as ClusterDetail
}

// --- Backfill ---

export type IngestPhase = 'idle' | 'embedding' | 'extracting' | 'entity-embedding' | 'storing' | 'done' | 'error' | 'cancelled'

export interface IngestStatus {
  phase: IngestPhase
  totalItems: number
  processed: number
  startedAt: number
  endedAt: number | null
  error: string | null
}

export async function fetchIngestStatus(): Promise<IngestStatus> {
  const res = await fetch('/api/ingest/status')
  const raw = await res.json()
  return {
    phase: (raw.phase ?? 'idle') as IngestPhase,
    totalItems: raw.totalItems ?? 0,
    processed: raw.processed ?? 0,
    startedAt: raw.startedAt ?? 0,
    endedAt: raw.endedAt ?? null,
    error: raw.error ?? null,
  }
}

export interface BackfillEstimate {
  token: string
  itemCount: number
  estimatedMinutes: number
  estimatedCostUsd: number
  estimatedBytes: number
  currentBytes: number
  capacityBytes: number
  willExceed: boolean
  currentItemCount: number
  itemCapacity: number
  from: string
  to: string
}

export async function previewBackfill(from: string, to: string): Promise<BackfillEstimate | { error: string }> {
  const res = await fetch('/api/backfill/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  })
  return res.json()
}

export async function confirmBackfill(token: string): Promise<{ id: string; totalItems: number } | { error: string }> {
  const res = await fetch('/api/backfill/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return res.json()
}

export async function cancelBackfill(id: string): Promise<{ ok: boolean } | { error: string }> {
  const res = await fetch('/api/backfill/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  return res.json()
}

export interface BackfillRecord {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  from: string
  to: string
  startedAt: number
  endedAt: number | null
  totalItems: number
  processed: number
  initiatedBy: string
  error?: string
  costUsdEstimated?: number
}

export interface BackfillHistoryResponse {
  records: BackfillRecord[]
  currentItemCount: number
  currentBytes: number
  itemCapacity: number
}

export async function fetchBackfillHistory(): Promise<BackfillHistoryResponse> {
  const res = await fetch('/api/backfill/history')
  return res.json()
}

// --- Rules ---

export interface RuleSummary {
  id: string
  shortName: string
  description: string
  priority: number
}

export async function fetchRules(): Promise<RuleSummary[]> {
  const res = await fetch('/api/rules')
  const raw = await res.json()
  return raw.rules ?? []
}

export async function reloadRules(): Promise<{ count: number; message?: string } | { error: string }> {
  const res = await fetch('/api/rules/reload', { method: 'POST' })
  return res.json()
}

// --- Danger zone ---

export async function deleteAllItems(): Promise<{ deleted: number }> {
  const res = await fetch('/api/items/delete-all', { method: 'POST' })
  return res.json()
}

export async function resetAllAlerts(): Promise<{ ok: boolean }> {
  const res = await fetch('/api/alerts/reset', { method: 'POST' })
  return res.json()
}

export async function resetStrata(): Promise<{ ok: boolean; deleted: number }> {
  const res = await fetch('/api/strata/reset', { method: 'POST' })
  return res.json()
}

// --- Scan ---

export type ScanPhase = 'idle' | 'building' | 'classifying' | 'done' | 'error' | 'cancelled'

export interface ScanStatus {
  phase: ScanPhase
  scanId: string | null
  startedAt: number
  endedAt: number | null
  anchorsProcessed: number
  anchorsTotal: number
  alertsCreated: number
  error: string | null
}

export async function fetchScanStatus(): Promise<ScanStatus> {
  const res = await fetch('/api/scan/status')
  const raw = await res.json()
  return {
    phase: (raw.phase ?? 'idle') as ScanPhase,
    scanId: raw.scanId ?? null,
    startedAt: raw.startedAt ?? 0,
    endedAt: raw.endedAt ?? null,
    anchorsProcessed: raw.anchorsProcessed ?? 0,
    anchorsTotal: raw.anchorsTotal ?? 0,
    alertsCreated: raw.alertsCreated ?? 0,
    error: raw.error ?? null,
  }
}

export async function startScan(): Promise<{ id: string } | { error: string }> {
  const res = await fetch('/api/scan/start', { method: 'POST' })
  return res.json()
}

export async function cancelScan(): Promise<{ ok: boolean } | { error: string }> {
  const res = await fetch('/api/scan/cancel', { method: 'POST' })
  return res.json()
}

export interface ScanRecord {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt: number | null
  anchorsTotal: number
  anchorsProcessed: number
  alertsCreated: number
  autoTriggered: boolean
  initiatedBy: string
  error?: string
}

export async function fetchScanHistory(): Promise<ScanRecord[]> {
  const res = await fetch('/api/scan/history')
  const raw = await res.json()
  return raw.records ?? []
}
