import { useState, useEffect, useRef } from 'react'
import { fetchScanStatus, type ScanStatus } from '../lib/api.js'

const TERMINAL = new Set(['idle', 'done', 'error', 'cancelled'])
const POLL_INTERVAL_MS = 3000

let cached: ScanStatus | null = null
const subscribers = new Set<(s: ScanStatus) => void>()

function publish(s: ScanStatus) {
  cached = s
  subscribers.forEach(fn => fn(s))
}

export function useScanStatus() {
  const [status, setStatus] = useState<ScanStatus | null>(cached)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    subscribers.add(setStatus)
    let cancelled = false

    const tick = async () => {
      try {
        const s = await fetchScanStatus()
        if (cancelled) return
        publish(s)
        if (TERMINAL.has(s.phase) && timer.current) {
          clearInterval(timer.current)
          timer.current = null
        }
      } catch {}
    }

    const startPolling = () => {
      if (timer.current) return
      tick()
      timer.current = setInterval(tick, POLL_INTERVAL_MS)
    }

    restartPolling = startPolling
    startPolling()

    return () => {
      cancelled = true
      subscribers.delete(setStatus)
      restartPolling = null
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  return status
}

let restartPolling: (() => void) | null = null

export async function refreshScanStatus() {
  const s = await fetchScanStatus()
  publish(s)
  if (!TERMINAL.has(s.phase) && restartPolling) restartPolling()
}
