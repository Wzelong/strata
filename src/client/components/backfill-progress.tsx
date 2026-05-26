import { useState, useEffect } from 'react'
import { Check, Circle, Loader2, AlertTriangle } from 'lucide-react'
import { useIngestStatus, refreshIngestStatus } from '../hooks/use-ingest-status'
import { cancelBackfill } from '../lib/api'
import { cn } from '../lib/utils'
import { ConfirmDialog } from './confirm-dialog'
import logo from '../assets/logo.png'

const STAGES = [
  { key: 'embedding', label: 'Embedding text' },
  { key: 'extracting', label: 'Extracting entities' },
  { key: 'entity-embedding', label: 'Embedding entities' },
  { key: 'storing', label: 'Writing to store' },
]

function elapsed(startedAt: number, endedAt: number | null): string {
  const ms = (endedAt ?? Date.now()) - startedAt
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
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
          <div className="text-sm font-medium">
            {isError ? 'Backfill failed' : 'Backfill cancelled'}
          </div>
          {status.error && <p className="text-xs text-muted-foreground">{status.error}</p>}
        </div>
      </div>
    )
  }

  const currentIdx = STAGES.findIndex(s => s.key === status.phase)
  const completedCount = currentIdx < 0 ? STAGES.length : currentIdx
  const pct = Math.round((completedCount / STAGES.length) * 100)

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
            Stage {Math.min(completedCount + 1, STAGES.length)} of {STAGES.length}
            {status.startedAt ? ` · ${elapsed(status.startedAt, null)}` : ''}
          </p>
        </div>

        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-foreground transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="space-y-2">
          {STAGES.map((stage, i) => {
            const done = i < completedCount
            const active = i === completedCount
            return (
              <div key={stage.key} className="flex items-start gap-2.5 text-xs">
                {done ? (
                  <Check className="size-3.5 text-green-500 mt-0.5 shrink-0" />
                ) : active ? (
                  <Loader2 className="size-3.5 animate-spin text-foreground mt-0.5 shrink-0" />
                ) : (
                  <Circle className="size-3.5 text-muted-foreground/40 mt-0.5 shrink-0" />
                )}
                <span className={done || active ? 'text-foreground' : 'text-muted-foreground/60'}>
                  {stage.label}
                </span>
              </div>
            )
          })}
        </div>

        {backfillId && (
          <div className="flex items-center justify-center pt-2">
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
