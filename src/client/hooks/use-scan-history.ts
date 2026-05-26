import { useState, useEffect, useCallback } from 'react'
import { fetchScanHistory, type ScanRecord } from '../lib/api.js'

let cached: ScanRecord[] | null = null
const subscribers = new Set<(r: ScanRecord[]) => void>()

function publish(r: ScanRecord[]) {
  cached = r
  subscribers.forEach(fn => fn(r))
}

async function load() {
  try {
    const records = await fetchScanHistory()
    publish(records)
  } catch {}
}

export function useScanHistory() {
  const [records, setRecords] = useState<ScanRecord[] | null>(cached)
  const refresh = useCallback(() => load(), [])

  useEffect(() => {
    subscribers.add(setRecords)
    if (!cached) load()
    return () => { subscribers.delete(setRecords) }
  }, [])

  return { records, refresh }
}
