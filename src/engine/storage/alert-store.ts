import type { Alert, AlertConnection, AlertStatus } from '../types.js'

export interface AlertStore {
  createAlert(alert: Alert, connections: AlertConnection[]): Promise<void>
  getAlert(id: string): Promise<Alert | null>
  getAlertConnections(id: string): Promise<AlertConnection[]>
  listAlerts(opts?: { status?: AlertStatus; limit?: number; cursor?: number }): Promise<{ alerts: Alert[]; nextCursor: number | null }>
  updateAlertStatus(id: string, status: AlertStatus): Promise<void>
  updateAlertDraft(id: string, fields: { draftPostTitle: string; draftPostBody: string; draftedAt: number; draftedBy: string }): Promise<void>
  updateAlertPublished(id: string, fields: { publishedPostId: string; publishedPostTitle: string; publishedPostBody: string; publishedPostPermalink: string; publishedAt: number; publishedBy: string }): Promise<void>
  getAlertIdsByAnchor(anchorId: string): Promise<string[]>
  deleteAlert(id: string): Promise<void>
  resetAll(): Promise<void>
}
