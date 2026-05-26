import { useState, useEffect } from 'react'
import { Check, Loader2, AlertTriangle } from 'lucide-react'
import { useIngestStatus, refreshIngestStatus } from '../hooks/use-ingest-status'
import { cancelBackfill } from '../lib/api'
import { cn } from '../lib/utils'
import { ConfirmDialog } from './confirm-dialog'
import logo from '../assets/logo.png'

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function ratio(done?: number, total?: number): number {
  if (!total || total <= 0) return 0
  return Math.min(1, (done ?? 0) / total)
}

interface Props {
  backfillId?: string
  subredditName?: string
}

export function BackfillProgress({ backfillId, subredditName }: Props) {
  const status = useIngestStatus()
  const [, tick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000)
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

  const embR = ratio(status.embCompleted, status.embTotal)
  const extractR = ratio(status.extractCompleted, status.extractTotal)
  const entR = ratio(status.entCompleted, status.entTotal)

  const chunkCount = status.chunkCount ?? 0
  const chunkIndex = status.chunkIndex ?? 0
  const chunked = chunkCount > 1

  // Within-chunk fraction (submit 0 → embed+extract .7 → entity-embed .9 → store 1).
  let chunkFrac = 0
  let phaseLabel = 'Preparing…'
  if (status.phase === 'submit') { chunkFrac = 0; phaseLabel = 'Submitting to OpenAI' }
  else if (status.phase === 'embedding' || status.phase === 'extracting') { chunkFrac = ((embR + extractR) / 2) * 0.7; phaseLabel = 'Embedding & extracting entities' }
  else if (status.phase === 'entity-embedding') { chunkFrac = 0.7 + entR * 0.2; phaseLabel = 'Embedding entities' }
  else if (status.phase === 'storing') { chunkFrac = 0.95; phaseLabel = 'Writing to store' }

  // Overall = completed chunks + current chunk's fraction, over total chunks.
  const overall = chunkCount > 0 ? (chunkIndex + chunkFrac) / chunkCount : chunkFrac
  const pct = Math.round(overall * 100)

  const waitingMs = status.waitingUntil ? status.waitingUntil - Date.now() : 0
  const waiting = status.phase === 'submit' && waitingMs > 1000

  const rows: Array<{ label: string; done: number; total: number; active: boolean }> = [
    { label: 'Embeddings', done: status.embCompleted ?? 0, total: status.embTotal ?? status.totalItems, active: status.phase === 'embedding' || status.phase === 'extracting' },
    { label: 'Entity extraction', done: status.extractCompleted ?? 0, total: status.extractTotal ?? status.totalItems, active: status.phase === 'embedding' || status.phase === 'extracting' },
  ]
  if (status.phase === 'entity-embedding' || (status.entTotal ?? 0) > 0) {
    rows.push({ label: 'Entity embeddings', done: status.entCompleted ?? 0, total: status.entTotal ?? 0, active: status.phase === 'entity-embedding' })
  }

  const lastPolledAgo = status.lastPolledAt ? duration(Date.now() - status.lastPolledAt) : null

  return (
    <div className="flex items-center justify-center h-full px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1.5">
          <img src={logo} alt="Strata" width={48} height={48} className="size-12 mx-auto animate-pulse" />
          <p className="text-sm font-medium">
            Processing {status.totalItems.toLocaleString()} items
            {subredditName ? ` from r/${subredditName}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            {chunked ? `Chunk ${Math.min(chunkIndex + 1, chunkCount)} of ${chunkCount} · ` : ''}{phaseLabel}
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-foreground transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>{pct}%</span>
            <span>{status.startedAt ? duration(Date.now() - status.startedAt) : ''} elapsed</span>
          </div>
        </div>

        <div className="space-y-2.5">
          {rows.map(r => {
            const done = r.total > 0 && r.done >= r.total
            return (
              <div key={r.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    {done ? <Check className="size-3 text-green-500" /> : r.active ? <Loader2 className="size-3 animate-spin text-foreground" /> : null}
                    <span className={r.active || done ? 'text-foreground' : 'text-muted-foreground'}>{r.label}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">{r.done.toLocaleString()} / {r.total.toLocaleString()}</span>
                </div>
                <div className="h-1 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-foreground/50 transition-all duration-500" style={{ width: `${ratio(r.done, r.total) * 100}%` }} />
                </div>
              </div>
            )
          })}
        </div>

        <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
          {waiting
            ? `Paused for Reddit's data limit — resuming in ~${duration(waitingMs)}.`
            : `Runs on OpenAI's batch queue — can take several minutes.${lastPolledAgo ? ` Last checked ${lastPolledAgo} ago; refreshes every ~2 min.` : ''}`}
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
