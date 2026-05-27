import { useState, useEffect, useRef } from 'react'
import { fetchIngestStatus, type IngestStatus } from '../lib/api.js'
import { refreshStats } from './use-stats.js'

const TERMINAL = new Set(['idle', 'done', 'error', 'cancelled'])
const POLL_INTERVAL_MS = 5000

let cached: IngestStatus | null = null
const subscribers = new Set<(s: IngestStatus) => void>()

function publish(s: IngestStatus) {
  const prev = cached
  cached = s
  subscribers.forEach(fn => fn(s))
  if (prev && !TERMINAL.has(prev.phase) && TERMINAL.has(s.phase)) {
    refreshStats()
  }
}

export function useIngestStatus() {
  const [status, setStatus] = useState<IngestStatus | null>(cached)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    subscribers.add(setStatus)
    let cancelled = false

    const tick = async () => {
      try {
        const s = await fetchIngestStatus()
        if (cancelled) return
        publish(s)
        if (TERMINAL.has(s.phase) && timer.current) {
          clearInterval(timer.current)
          timer.current = null
        }
      } catch {}
    }

    tick()
    timer.current = setInterval(tick, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      subscribers.delete(setStatus)
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  return status
}

// Manual refresh, useful right after confirm to kick the poll cycle.
export async function refreshIngestStatus() {
  const s = await fetchIngestStatus()
  publish(s)
}
