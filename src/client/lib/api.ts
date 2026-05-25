import type { Alert, AlertConnection, AlertStatus } from '../../engine/types'

export interface AlertListItem extends Alert {}

export interface AlertDetail extends Alert {
  connections: AlertConnection[]
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
  await fetch(`/api/alerts/${id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
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

export async function fetchStats(): Promise<{ itemCount: number; capacity: number }> {
  const res = await fetch('/api/stats')
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
