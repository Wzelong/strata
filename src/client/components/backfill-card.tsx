import { useState, useEffect } from 'react'
import { Check, Loader2, Circle, X } from 'lucide-react'
import { useIngestStatus, refreshIngestStatus } from '../hooks/use-ingest-status'
import { cancelBackfill } from '../lib/api'
import { cn } from '../lib/utils'
import { ConfirmDialog } from './confirm-dialog'

const BATCH_STAGES = [
  { key: 'submit', label: 'Uploading' },
  { key: 'embedding', label: 'Embedding & extracting' },
  { key: 'entity-embedding', label: 'Indexing connections' },
  { key: 'storing', label: 'Storing' },
  { key: 'clustering', label: 'Clustering' },
  { key: 'scanning', label: 'Scanning' },
]

const RT_STAGES = [
  { key: 'realtime-ingest', label: 'Processing' },
  { key: 'clustering', label: 'Clustering' },
  { key: 'scanning', label: 'Scanning' },
]

function batchStageIndex(phase: string): number {
  if (phase === 'submit') return 0
  if (phase === 'embedding' || phase === 'extracting') return 1
  if (phase === 'entity-embedding') return 2
  if (phase === 'storing') return 3
  if (phase === 'clustering') return 4
  if (phase === 'scanning') return 5
  return 0
}

function rtStageIndex(phase: string): number {
  if (phase === 'realtime-ingest') return 0
  if (phase === 'clustering') return 1
  if (phase === 'scanning') return 2
  return 0
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export function BackfillCard() {
  const status = useIngestStatus()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!status || !status.phase || ['idle', 'done', 'error', 'cancelled'].includes(status.phase)) return null

  const isRealtime = status.mode === 'realtime'
  const stages = isRealtime ? RT_STAGES : BATCH_STAGES
  const currentStageIdx = isRealtime ? rtStageIndex(status.phase) : batchStageIndex(status.phase)
  const totalItems = status.totalItems ?? 0
  const processed = status.processed ?? 0
  const pct = totalItems > 0 ? Math.round((processed / totalItems) * 100) : 0
  const elapsed = status.startedAt ? now - status.startedAt : 0

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin text-foreground" />
          <span className="text-sm font-medium">
            Backfilling {totalItems.toLocaleString()} items
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground font-medium">
            {isRealtime ? 'Fast' : 'Economy'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">{formatDuration(elapsed)}</span>
          {status.backfillId && (
            <ConfirmDialog
              title="Cancel backfill?"
              description="Progress so far will be kept. In-flight jobs will be cancelled."
              actionLabel="Cancel"
              destructive
              onAction={async () => {
                await cancelBackfill(status.backfillId!)
                await refreshIngestStatus()
              }}
            >
              <button className="cursor-pointer size-6 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                <X className="size-3.5" />
              </button>
            </ConfirmDialog>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-foreground rounded-full transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{processed.toLocaleString()} / {totalItems.toLocaleString()} items</span>
          <span>{pct}%</span>
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        {stages.map((stage, i) => {
          const isDone = i < currentStageIdx
          const isActive = i === currentStageIdx
          return (
            <div key={stage.key} className="flex items-center gap-1.5 text-[11px]">
              {isDone && <Check className="size-3 text-emerald-500" />}
              {isActive && <Loader2 className="size-3 animate-spin text-foreground" />}
              {!isDone && !isActive && <Circle className="size-3 text-muted-foreground/30" />}
              <span className={cn(
                isDone && 'text-muted-foreground',
                isActive && 'text-foreground font-medium',
                !isDone && !isActive && 'text-muted-foreground/50',
              )}>
                {stage.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
