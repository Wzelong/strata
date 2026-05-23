import type { AlertStore } from './alert-store.js'
import type { Alert, AlertConnection, AlertEntity, AlertStatus } from '../types.js'
import type { RedisClient } from './redis.js'

function normalizeEntities(value: unknown): AlertEntity[] {
  if (!Array.isArray(value)) return []
  return value.map(v => {
    if (typeof v === 'string') return { text: v, clusterId: v }
    if (v && typeof v === 'object' && typeof (v as AlertEntity).text === 'string') {
      const e = v as AlertEntity
      return { text: e.text, clusterId: e.clusterId ?? e.text }
    }
    return null
  }).filter((e): e is AlertEntity => e !== null)
}

export class RedisAlertStore implements AlertStore {
  private redis: RedisClient

  constructor(redis: RedisClient) {
    this.redis = redis
  }

  async createAlert(alert: Alert, connections: AlertConnection[]): Promise<void> {
    await this.redis.hSet(`strata:alert:${alert.id}`, {
      id: alert.id,
      mode: alert.mode,
      status: alert.status,
      confidence: alert.confidence,
      connectionCount: String(alert.connectionCount),
      createdAt: String(alert.createdAt),
      anchorId: alert.anchorId,
      anchorAuthor: alert.anchorAuthor,
      anchorType: alert.anchorType,
      anchorText: alert.anchorText,
      anchorPermalink: alert.anchorPermalink,
      anchorEntities: JSON.stringify(alert.anchorEntities ?? []),
      ...(alert.anchorTitle && { anchorTitle: alert.anchorTitle }),
      ...(alert.reasoning && { reasoning: alert.reasoning }),
      ...(alert.flagType && { flagType: alert.flagType }),
    })

    if (connections.length > 0) {
      const fields: Record<string, string> = {}
      for (const conn of connections) {
        fields[conn.itemId] = JSON.stringify(conn)
      }
      await this.redis.hSet(`strata:alert:${alert.id}:connections`, fields)
    }

    await this.redis.zAdd('strata:alerts', { member: alert.id, score: alert.createdAt })
    await this.redis.zAdd(`strata:idx:alert-anchor:${alert.anchorId}`, { member: alert.id, score: alert.createdAt })
  }

  async getAlert(id: string): Promise<Alert | null> {
    const raw = await this.redis.hGetAll(`strata:alert:${id}`)
    if (!raw || !raw.id) return null
    let anchorEntities: AlertEntity[] = []
    if (raw.anchorEntities) {
      try { anchorEntities = normalizeEntities(JSON.parse(raw.anchorEntities)) } catch {}
    }
    return {
      id: raw.id,
      mode: raw.mode as Alert['mode'],
      status: raw.status as Alert['status'],
      confidence: raw.confidence as Alert['confidence'],
      connectionCount: parseInt(raw.connectionCount, 10),
      createdAt: parseInt(raw.createdAt, 10),
      anchorId: raw.anchorId,
      anchorAuthor: raw.anchorAuthor,
      anchorType: (raw.anchorType || 'post') as Alert['anchorType'],
      anchorText: raw.anchorText,
      anchorPermalink: raw.anchorPermalink,
      anchorEntities,
      ...(raw.anchorTitle && { anchorTitle: raw.anchorTitle }),
      ...(raw.reasoning && { reasoning: raw.reasoning }),
      ...(raw.flagType && { flagType: raw.flagType as Alert['flagType'] }),
    }
  }

  async getAlertConnections(id: string): Promise<AlertConnection[]> {
    const raw = await this.redis.hGetAll(`strata:alert:${id}:connections`)
    if (!raw) return []
    return Object.values(raw).map(v => {
      const conn = JSON.parse(v) as AlertConnection
      conn.entities = normalizeEntities(conn.entities)
      if (typeof conn.createdAt !== 'number') conn.createdAt = 0
      return conn
    })
  }

  async listAlerts(opts?: { status?: AlertStatus; limit?: number; cursor?: number }): Promise<{ alerts: Alert[]; nextCursor: number | null }> {
    const limit = opts?.limit ?? 20
    const max = opts?.cursor ? opts.cursor - 1 : '+inf'
    const entries = await this.redis.zRange('strata:alerts', '-inf', max, {
      by: 'score',
      reverse: true,
      limit: { offset: 0, count: limit + 1 },
    })

    const hasMore = entries.length > limit
    const page = hasMore ? entries.slice(0, limit) : entries

    const alerts: Alert[] = []
    for (const entry of page) {
      const alert = await this.getAlert(entry.member)
      if (!alert) continue
      if (opts?.status && alert.status !== opts.status) continue
      alerts.push(alert)
    }

    const nextCursor = hasMore ? page[page.length - 1].score : null
    return { alerts, nextCursor }
  }

  async updateAlertStatus(id: string, status: AlertStatus): Promise<void> {
    await this.redis.hSet(`strata:alert:${id}`, { status })
  }

  async getAlertIdsByAnchor(anchorId: string): Promise<string[]> {
    const entries = await this.redis.zRange(`strata:idx:alert-anchor:${anchorId}`, 0, -1)
    return entries.map(e => e.member)
  }
}
