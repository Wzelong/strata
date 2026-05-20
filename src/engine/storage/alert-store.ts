import type { Alert, AlertConnection, AlertStatus } from '../types.js'

export interface AlertStore {
  createAlert(alert: Alert, connections: AlertConnection[]): Promise<void>
  getAlert(id: string): Promise<Alert | null>
  getAlertConnections(id: string): Promise<AlertConnection[]>
  listAlerts(opts?: { status?: AlertStatus; limit?: number; cursor?: number }): Promise<{ alerts: Alert[]; nextCursor: number | null }>
  updateAlertStatus(id: string, status: AlertStatus): Promise<void>
}
