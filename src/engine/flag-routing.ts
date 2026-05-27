import type { FlagResult } from './types.js'

export type FlagRoute = 'queue' | 'ui' | 'drop'

export function routeFlag(flag: FlagResult): FlagRoute {
  if (flag.type === 'rule') return 'queue'
  // Pattern flags only exist once the LLM has judged the item a removable repeat, so
  // trust that decision and always queue it. Cosine sets high vs review (severity),
  // it no longer silently drops a match the model already approved.
  if (flag.type === 'pattern') return 'queue'
  if (flag.type === 'brigade') return 'ui'
  return 'drop'
}

export function formatReportReason(flag: FlagResult): string {
  const precedents = flag.type === 'pattern' && flag.connectionItems.length > 0
    ? ` (similar to ${flag.connectionItems.slice(0, 2).map(c => c.id).join(', ')})`
    : ''
  return `Strata ${flag.type} (${flag.confidence}): ${flag.reasoning}${precedents}`.slice(0, 100)
}

export const BRIGADE_LOCK_TTL_MS = 4 * 60 * 60_000
export const brigadeLockKey = (threadRootId: string) => `strata:brigade-lock:${threadRootId}`
