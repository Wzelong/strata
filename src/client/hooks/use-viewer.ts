import { useState, useEffect } from 'react'

type ViewerState = { isMod: boolean | null; loading: boolean; subredditName: string | null }
export type ViewerOverride = 'mod' | 'public' | null

const OVERRIDE_KEY = 'strata-viewer-override'

function readOverride(): ViewerOverride {
  if (typeof window === 'undefined') return null
  const v = localStorage.getItem(OVERRIDE_KEY)
  return v === 'mod' || v === 'public' ? v : null
}

function applyOverride(real: boolean, override: ViewerOverride): boolean {
  if (override === 'mod') return true
  if (override === 'public') return false
  return real
}

let realIsMod: boolean | null = null
let realSubredditName: string | null = null
let cached: ViewerState = { isMod: null, loading: true, subredditName: null }
let inflight: Promise<void> | null = null
const subscribers = new Set<(state: ViewerState) => void>()

function publish() {
  const override = readOverride()
  const next: ViewerState = {
    isMod: realIsMod === null ? null : applyOverride(realIsMod, override),
    loading: realIsMod === null,
    subredditName: realSubredditName,
  }
  cached = next
  subscribers.forEach(fn => fn(next))
}

async function fetchViewer() {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/viewer')
      if (!res.ok) throw new Error(`status ${res.status}`)
      const data = await res.json()
      realIsMod = !!data.isMod
      realSubredditName = typeof data.subredditName === 'string' ? data.subredditName : null
    } catch {
      realIsMod = import.meta.env.DEV
    } finally {
      inflight = null
      publish()
    }
  })()
  return inflight
}

export function setViewerOverride(override: ViewerOverride) {
  if (typeof window === 'undefined') return
  if (override === null) localStorage.removeItem(OVERRIDE_KEY)
  else localStorage.setItem(OVERRIDE_KEY, override)
  publish()
}

export function getViewerOverride(): ViewerOverride {
  return readOverride()
}

export function useViewer() {
  const [state, setState] = useState<ViewerState>(cached)
  useEffect(() => {
    subscribers.add(setState)
    if (realIsMod === null) fetchViewer()
    return () => { subscribers.delete(setState) }
  }, [])
  return state
}

export function useViewerOverride() {
  const [override, setOverride] = useState<ViewerOverride>(readOverride())
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === OVERRIDE_KEY) setOverride(readOverride())
    }
    const onChange = () => setOverride(readOverride())
    window.addEventListener('storage', onStorage)
    subscribers.add(onChange)
    return () => {
      window.removeEventListener('storage', onStorage)
      subscribers.delete(onChange)
    }
  }, [])
  return override
}
