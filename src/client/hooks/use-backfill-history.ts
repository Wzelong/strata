import { useState, useEffect, useCallback } from 'react'
import { fetchBackfillHistory, type BackfillHistoryResponse } from '../lib/api.js'

let cached: BackfillHistoryResponse | null = null
const subscribers = new Set<(h: BackfillHistoryResponse) => void>()

function publish(h: BackfillHistoryResponse) {
  cached = h
  subscribers.forEach(fn => fn(h))
}

async function load() {
  try {
    const h = await fetchBackfillHistory()
    publish(h)
  } catch {}
}

export function useBackfillHistory() {
  const [history, setHistory] = useState<BackfillHistoryResponse | null>(cached)
  const refresh = useCallback(() => load(), [])

  useEffect(() => {
    subscribers.add(setHistory)
    if (!cached) load()
    return () => { subscribers.delete(setHistory) }
  }, [])

  return { history, refresh }
}
