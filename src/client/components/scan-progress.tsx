import { useState, useEffect } from 'react'
import { Check, Circle, Loader2, AlertTriangle } from 'lucide-react'
import { useScanStatus, refreshScanStatus } from '../hooks/use-scan-status.js'
import { cancelScan } from '../lib/api.js'
import { cn } from '../lib/utils.js'
import { ConfirmDialog } from './confirm-dialog.js'

function elapsed(startedAt: number, endedAt: number | null): string {
  const ms = (endedAt ?? Date.now()) - startedAt
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function ScanProgress() {
  const status = useScanStatus()
  const [, tick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!status || status.phase === 'idle') return null

  const isError = status.phase === 'error'
  const isCancelled = status.phase === 'cancelled'
  const isDone = status.phase === 'done'

  if (isError || isCancelled) {
    return (
      <div className="space-y-2 text-sm">
        <div className={cn('flex items-center gap-2', isError ? 'text-destructive' : 'text-muted-foreground')}>
          <AlertTriangle className="size-3.5" />
          {isError ? 'Scan failed' : 'Scan cancelled'}
        </div>
        {status.error && <p className="text-xs text-muted-foreground pl-5">{status.error}</p>}
      </div>
    )
  }

  if (isDone) return null

  const buildingDone = status.phase === 'classifying'
  const classifyingActive = status.phase === 'classifying'
  const pct = status.anchorsTotal > 0
    ? Math.round((status.anchorsProcessed / status.anchorsTotal) * 100)
    : 0

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {classifyingActive
            ? `${status.anchorsProcessed} / ${status.anchorsTotal} anchors · ${status.alertsCreated} alerts`
            : 'Building anchor groups…'}
          {' · '}
          {elapsed(status.startedAt, null)}
        </span>
        <ConfirmDialog
          title="Cancel scan?"
          description="Progress so far will be discarded. Any partially-built anchor groups will be dropped."
          actionLabel="Cancel scan"
          cancelLabel="Keep running"
          destructive
          onAction={async () => {
            await cancelScan()
            await refreshScanStatus()
          }}
        >
          <button className="cursor-pointer text-muted-foreground hover:text-destructive transition-colors">
            Cancel
          </button>
        </ConfirmDialog>
      </div>

      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-foreground transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="space-y-2 pt-1">
        <Stage
          done={buildingDone}
          active={status.phase === 'building'}
          label="Building anchor groups"
          detail={buildingDone ? `${status.anchorsTotal} anchors` : undefined}
        />
        <Stage
          done={false}
          active={classifyingActive}
          label="Classifying connections"
          detail={classifyingActive ? `${status.anchorsProcessed} / ${status.anchorsTotal}` : undefined}
        />
      </div>
    </div>
  )
}

function Stage({ done, active, label, detail }: { done: boolean; active: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2.5 text-xs">
      {done ? (
        <Check className="size-3.5 text-green-500 mt-0.5 shrink-0" />
      ) : active ? (
        <Loader2 className="size-3.5 animate-spin text-foreground mt-0.5 shrink-0" />
      ) : (
        <Circle className="size-3.5 text-muted-foreground/40 mt-0.5 shrink-0" />
      )}
      <span className={done || active ? 'text-foreground' : 'text-muted-foreground/60'}>
        {label}
        {detail && <span className="text-muted-foreground ml-1.5">— {detail}</span>}
      </span>
    </div>
  )
}
