import { useState, useEffect } from 'react'
import { Check, Loader2, AlertTriangle, Circle } from 'lucide-react'
import { useIngestStatus, refreshIngestStatus } from '../hooks/use-ingest-status'
import { cancelBackfill } from '../lib/api'
import { cn } from '../lib/utils'
import { ConfirmDialog } from './confirm-dialog'
import logo from '../assets/logo.png'

const BATCH_STAGES = [
  { key: 'submit', label: 'Uploading to OpenAI', weight: 0.10 },
  { key: 'embedding', label: 'Embedding & extracting entities', weight: 0.40 },
  { key: 'entity-embedding', label: 'Indexing entity connections', weight: 0.20 },
  { key: 'storing', label: 'Writing to database', weight: 0.10 },
  { key: 'clustering', label: 'Clustering topics', weight: 0.10 },
  { key: 'scanning', label: 'Scanning for patterns', weight: 0.10 },
]

const RT_STAGES = [
  { key: 'realtime-ingest', label: 'Processing items', weight: 0.85 },
  { key: 'clustering', label: 'Clustering topics', weight: 0.15 },
]

const BATCH_POLL_S = 120

function batchPhaseToStageIndex(phase: string): number {
  if (phase === 'submit') return 0
  if (phase === 'embedding' || phase === 'extracting') return 1
  if (phase === 'entity-embedding') return 2
  if (phase === 'storing') return 3
  if (phase === 'clustering') return 4
  if (phase === 'scanning') return 5
  return 0
}

function rtPhaseToStageIndex(phase: string): number {
  if (phase === 'realtime-ingest') return 0
  if (phase === 'clustering') return 1
  return 0
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}h${m}m${sec}s`
}

interface Props {
  backfillId?: string
  subredditName?: string
}

export function BackfillProgress({ backfillId, subredditName }: Props) {
  const status = useIngestStatus()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!status) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const isError = status.phase === 'error'
  const isCancelled = status.phase === 'cancelled'

  if (isError || isCancelled) {
    return (
      <div className="flex items-center justify-center h-full px-4">
        <div className="w-full max-w-sm text-center space-y-3">
          <AlertTriangle className={cn('size-8 mx-auto', isError ? 'text-destructive' : 'text-muted-foreground')} />
          <div className="text-sm font-medium">{isError ? 'Backfill failed' : 'Backfill cancelled'}</div>
          {status.error && <p className="text-xs text-muted-foreground">{status.error}</p>}
        </div>
      </div>
    )
  }

  const isRealtime = status.mode === 'realtime'
  const stages = isRealtime ? RT_STAGES : BATCH_STAGES
  const currentStageIdx = isRealtime ? rtPhaseToStageIndex(status.phase) : batchPhaseToStageIndex(status.phase)
  const totalItems = status.totalItems
  const processedSoFar = status.processed ?? 0

  // Batch-specific progress tracking
  const embDone = status.embCompleted ?? 0
  const extDone = status.extractCompleted ?? 0
  const chunkTotal = status.embTotal ?? 0
  const chunkIndex = status.chunkIndex ?? 0
  const embStageDone = processedSoFar + Math.min(embDone, extDone)
  const embStageFrac = totalItems > 0 ? embStageDone / totalItems : 0
  const entDone = status.entCompleted ?? 0
  const entTotal = status.entTotal ?? 0
  const entStageFrac = entTotal > 0 ? entDone / entTotal : 0

  let stageFrac = 0
  if (isRealtime && status.phase === 'realtime-ingest') {
    stageFrac = totalItems > 0 ? processedSoFar / totalItems : 0
  } else if (isRealtime && status.phase === 'clustering') {
    const clusterEstMs = totalItems * 17
    const phaseElapsed = (status.lastPolledAt ?? status.startedAt ?? now)
    const sinceClusterStart = now - (status.lastPolledAt ?? now)
    const rawFrac = clusterEstMs > 0 ? sinceClusterStart / clusterEstMs : 0
    stageFrac = Math.min(0.95, rawFrac * (0.7 + Math.sin(now / 3000) * 0.05))
  } else if (status.phase === 'embedding' || status.phase === 'extracting') {
    stageFrac = chunkTotal > 0 ? Math.min(embDone, extDone) / chunkTotal : 0
  } else if (status.phase === 'entity-embedding') {
    stageFrac = entStageFrac
  }

  let overallPct: number
  if (isRealtime) {
    let pct = 0
    for (let i = 0; i < currentStageIdx; i++) pct += stages[i].weight
    pct += stages[currentStageIdx].weight * stageFrac
    overallPct = Math.round(pct * 100)
  } else {
    let pct = 0
    for (let i = 0; i < currentStageIdx; i++) pct += stages[i].weight
    pct += stages[currentStageIdx].weight * stageFrac
    if (currentStageIdx === 1) pct = stages[0].weight + stages[1].weight * embStageFrac
    overallPct = Math.round(pct * 100)
  }

  const elapsed = status.startedAt ? now - status.startedAt : 0

  return (
    <div className="flex items-center justify-center h-full px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1.5">
          <img src={logo} alt="Strata" width={48} height={48} className="size-12 mx-auto animate-pulse" />
          <p className="text-sm font-medium">
            Processing {status.totalItems.toLocaleString()} items
            {subredditName ? ` from r/${subredditName}` : ''}
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-foreground rounded-full transition-all duration-1000 ease-out"
              style={{ width: `${Math.min(99, overallPct)}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>Stage {currentStageIdx + 1} of {stages.length}</span>
            <span>{formatDuration(elapsed)}</span>
          </div>
        </div>

        <div className="space-y-2.5">
          {stages.map((stage, i) => {
            const isDone = i < currentStageIdx || (i === currentStageIdx && stageFrac >= 1)
            const isActive = i === currentStageIdx && stageFrac < 1
            const isPending = i > currentStageIdx

            let count: string | null = null
            if (isRealtime && i === 0 && (isActive || isDone)) {
              count = `${processedSoFar.toLocaleString()} / ${totalItems.toLocaleString()}`
            } else if (!isRealtime && i === 1 && (isActive || isDone)) {
              count = `${embStageDone.toLocaleString()} / ${totalItems.toLocaleString()}`
            } else if (!isRealtime && i === 2 && (isActive || isDone) && entTotal > 0) {
              count = `${entDone.toLocaleString()} / ${entTotal.toLocaleString()}`
            }

            return (
              <div key={stage.key} className="flex items-center gap-2.5 text-xs">
                <div className="shrink-0">
                  {isDone && <Check className="size-3.5 text-emerald-500" />}
                  {isActive && <Loader2 className="size-3.5 animate-spin text-foreground" />}
                  {isPending && <Circle className="size-3.5 text-muted-foreground/40" />}
                </div>
                <span className={cn(
                  'flex-1',
                  isDone && 'text-muted-foreground',
                  isActive && 'text-foreground font-medium',
                  isPending && 'text-muted-foreground/60',
                )}>
                  {stage.label}
                </span>
                {count && (
                  <span className="text-muted-foreground tabular-nums">{count}</span>
                )}
              </div>
            )
          })}
        </div>

        <p className="text-[11px] text-muted-foreground text-center leading-relaxed max-w-[280px] mx-auto">
          {isRealtime
            ? currentStageIdx === 0
              ? 'Each item is embedded, entities extracted, and connections indexed in parallel batches.'
              : 'Grouping items by semantic similarity to discover topic clusters.'
            : currentStageIdx <= 1
            ? 'Waiting for OpenAI batch queue to process embeddings and entity extraction.'
            : currentStageIdx === 2
            ? 'Embedding extracted entities for cross-item semantic matching.'
            : 'Writing processed items and indices to the database.'}
        </p>

        {backfillId && (
          <div className="flex items-center justify-center">
            <ConfirmDialog
              title="Cancel backfill?"
              description="Progress so far will be discarded. In-flight OpenAI batch jobs will be cancelled if possible."
              actionLabel="Cancel backfill"
              cancelLabel="Keep running"
              destructive
              onAction={async () => {
                await cancelBackfill(backfillId)
                await refreshIngestStatus()
              }}
            >
              <button className="cursor-pointer text-xs text-muted-foreground hover:text-destructive transition-colors">
                Cancel backfill
              </button>
            </ConfirmDialog>
          </div>
        )}
      </div>
    </div>
  )
}
