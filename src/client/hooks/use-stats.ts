import { useState, useEffect } from 'react'
import { fetchStats } from '../lib/api.js'

type Stats = { itemCount: number; capacity: number; hasApiKey: boolean; apiKeyInvalid: boolean } | null

let cached: Stats = null
let inflight: Promise<void> | null = null
const subscribers = new Set<(s: Stats) => void>()

function publish(s: Stats) {
  cached = s
  subscribers.forEach(fn => fn(s))
}

async function load() {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const s = await fetchStats()
      publish(s)
    } catch {} finally {
      inflight = null
    }
  })()
  return inflight
}

export function useStats() {
  const [stats, setStats] = useState<Stats>(cached)
  useEffect(() => {
    subscribers.add(setStats)
    if (!cached) load()
    return () => { subscribers.delete(setStats) }
  }, [])
  return stats
}

export async function refreshStats() {
  cached = null
  await load()
}
