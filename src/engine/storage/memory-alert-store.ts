import type { AlertStore } from './alert-store.js'
import type { Alert, AlertConnection, AlertStatus } from '../types.js'

export class MemoryAlertStore implements AlertStore {
  private alerts = new Map<string, Alert>()
  private connections = new Map<string, AlertConnection[]>()
  private timeline: Array<{ id: string; createdAt: number }> = []

  async createAlert(alert: Alert, connections: AlertConnection[]): Promise<void> {
    this.alerts.set(alert.id, alert)
    this.connections.set(alert.id, connections)
    this.timeline.push({ id: alert.id, createdAt: alert.createdAt })
    this.timeline.sort((a, b) => b.createdAt - a.createdAt)
  }

  async getAlert(id: string): Promise<Alert | null> {
    return this.alerts.get(id) ?? null
  }

  async getAlertConnections(id: string): Promise<AlertConnection[]> {
    return this.connections.get(id) ?? []
  }

  async listAlerts(opts?: { status?: AlertStatus; limit?: number; cursor?: number }): Promise<{ alerts: Alert[]; nextCursor: number | null }> {
    const limit = opts?.limit ?? 20
    let entries = [...this.timeline]
    if (opts?.cursor) {
      entries = entries.filter(e => e.createdAt < opts.cursor!)
    }

    const result: Alert[] = []
    for (const entry of entries) {
      if (result.length >= limit + 1) break
      const alert = this.alerts.get(entry.id)!
      if (opts?.status && alert.status !== opts.status) continue
      result.push(alert)
    }

    const hasMore = result.length > limit
    const page = hasMore ? result.slice(0, limit) : result
    return {
      alerts: page,
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
    }
  }

  async updateAlertStatus(id: string, status: AlertStatus): Promise<void> {
    const alert = this.alerts.get(id)
    if (alert) {
      alert.status = status
      alert.statusUpdatedAt = Date.now()
    }
  }

  async updateAlertDraft(id: string, fields: { draftPostTitle: string; draftPostBody: string; draftedAt: number; draftedBy: string }): Promise<void> {
    const alert = this.alerts.get(id)
    if (!alert) return
    alert.draftPostTitle = fields.draftPostTitle
    alert.draftPostBody = fields.draftPostBody
    alert.draftedAt = fields.draftedAt
    alert.draftedBy = fields.draftedBy
  }

  async updateAlertPublished(id: string, fields: { publishedPostId: string; publishedPostTitle: string; publishedPostBody: string; publishedPostPermalink: string; publishedAt: number; publishedBy: string }): Promise<void> {
    const alert = this.alerts.get(id)
    if (!alert) return
    alert.publishedPostId = fields.publishedPostId
    alert.publishedPostTitle = fields.publishedPostTitle
    alert.publishedPostBody = fields.publishedPostBody
    alert.publishedPostPermalink = fields.publishedPostPermalink
    alert.publishedAt = fields.publishedAt
    alert.publishedBy = fields.publishedBy
  }

  async getAlertIdsByAnchor(anchorId: string): Promise<string[]> {
    return [...this.alerts.values()]
      .filter(a => a.anchorId === anchorId)
      .map(a => a.id)
  }

  async resetAll(): Promise<void> {
    this.alerts.clear()
    this.connections.clear()
    this.timeline = []
  }
}
