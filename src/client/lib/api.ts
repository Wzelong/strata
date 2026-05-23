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
