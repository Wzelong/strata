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
      statusUpdatedAt: String(alert.statusUpdatedAt ?? alert.createdAt),
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
      ...(alert.draftPostTitle && { draftPostTitle: alert.draftPostTitle }),
      ...(alert.draftPostBody && { draftPostBody: alert.draftPostBody }),
      ...(alert.draftedAt && { draftedAt: String(alert.draftedAt) }),
      ...(alert.draftedBy && { draftedBy: alert.draftedBy }),
      ...(alert.publishedPostId && { publishedPostId: alert.publishedPostId }),
      ...(alert.publishedPostTitle && { publishedPostTitle: alert.publishedPostTitle }),
      ...(alert.publishedPostBody && { publishedPostBody: alert.publishedPostBody }),
      ...(alert.publishedPostPermalink && { publishedPostPermalink: alert.publishedPostPermalink }),
      ...(alert.publishedAt && { publishedAt: String(alert.publishedAt) }),
      ...(alert.publishedBy && { publishedBy: alert.publishedBy }),
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
      ...(raw.statusUpdatedAt && { statusUpdatedAt: parseInt(raw.statusUpdatedAt, 10) }),
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
      ...(raw.draftPostTitle && { draftPostTitle: raw.draftPostTitle }),
      ...(raw.draftPostBody && { draftPostBody: raw.draftPostBody }),
      ...(raw.draftedAt && { draftedAt: parseInt(raw.draftedAt, 10) }),
      ...(raw.draftedBy && { draftedBy: raw.draftedBy }),
      ...(raw.publishedPostId && { publishedPostId: raw.publishedPostId }),
      ...(raw.publishedPostTitle && { publishedPostTitle: raw.publishedPostTitle }),
      ...(raw.publishedPostBody && { publishedPostBody: raw.publishedPostBody }),
      ...(raw.publishedPostPermalink && { publishedPostPermalink: raw.publishedPostPermalink }),
      ...(raw.publishedAt && { publishedAt: parseInt(raw.publishedAt, 10) }),
      ...(raw.publishedBy && { publishedBy: raw.publishedBy }),
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
    await this.redis.hSet(`strata:alert:${id}`, { status, statusUpdatedAt: String(Date.now()) })
  }

  async updateAlertDraft(id: string, fields: { draftPostTitle: string; draftPostBody: string; draftedAt: number; draftedBy: string }): Promise<void> {
    await this.redis.hSet(`strata:alert:${id}`, {
      draftPostTitle: fields.draftPostTitle,
      draftPostBody: fields.draftPostBody,
      draftedAt: String(fields.draftedAt),
      draftedBy: fields.draftedBy,
    })
  }

  async updateAlertPublished(id: string, fields: { publishedPostId: string; publishedPostTitle: string; publishedPostBody: string; publishedPostPermalink: string; publishedAt: number; publishedBy: string }): Promise<void> {
    await this.redis.hSet(`strata:alert:${id}`, {
      publishedPostId: fields.publishedPostId,
      publishedPostTitle: fields.publishedPostTitle,
      publishedPostBody: fields.publishedPostBody,
      publishedPostPermalink: fields.publishedPostPermalink,
      publishedAt: String(fields.publishedAt),
      publishedBy: fields.publishedBy,
    })
  }

  async getAlertIdsByAnchor(anchorId: string): Promise<string[]> {
    const entries = await this.redis.zRange(`strata:idx:alert-anchor:${anchorId}`, 0, -1)
    return entries.map(e => e.member)
  }

  async deleteAlert(id: string): Promise<void> {
    const raw = await this.redis.hGetAll(`strata:alert:${id}`)
    if (raw?.anchorId) {
      await this.redis.zRem(`strata:idx:alert-anchor:${raw.anchorId}`, [id])
    }
    await this.redis.del(`strata:alert:${id}`)
    await this.redis.del(`strata:alert:${id}:connections`)
    await this.redis.zRem('strata:alerts', [id])
  }

  async resetAll(): Promise<void> {
    const entries = await this.redis.zRange('strata:alerts', 0, -1).catch(() => [])
    const anchorIds = new Set<string>()
    for (const entry of entries) {
      const id = entry.member
      const raw = await this.redis.hGetAll(`strata:alert:${id}`)
      if (raw?.anchorId) anchorIds.add(raw.anchorId)
      await this.redis.del(`strata:alert:${id}`)
      await this.redis.del(`strata:alert:${id}:connections`)
    }
    for (const anchorId of anchorIds) {
      await this.redis.del(`strata:idx:alert-anchor:${anchorId}`)
    }
    await this.redis.del('strata:alerts')
  }
}
