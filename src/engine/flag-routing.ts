import type { FlagResult } from './types.js'

export type FlagRoute = 'queue' | 'ui' | 'drop'

export function routeFlag(flag: FlagResult): FlagRoute {
  if (flag.type === 'rule') return 'queue'
  if (flag.type === 'pattern') return flag.confidence === 'high' ? 'queue' : 'drop'
  if (flag.type === 'brigade') return 'ui'
  return 'drop'
}

export function formatReportReason(flag: FlagResult): string {
  const precedents = flag.type === 'pattern' && flag.connectionItems.length > 0
    ? ` (similar to ${flag.connectionItems.slice(0, 2).map(c => c.id).join(', ')})`
    : ''
  return `Strata ${flag.type}: ${flag.reasoning}${precedents}`.slice(0, 100)
}

export const BRIGADE_LOCK_TTL_MS = 4 * 60 * 60_000
export const brigadeLockKey = (threadRootId: string) => `strata:brigade-lock:${threadRootId}`
