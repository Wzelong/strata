import { useState, useEffect } from 'react'
import { Check, Loader2, Circle } from 'lucide-react'
import { useScanStatus, refreshScanStatus } from '../hooks/use-scan-status.js'
import { cancelScan } from '../lib/api.js'
import { cn } from '../lib/utils.js'
import { ConfirmDialog } from './confirm-dialog.js'

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export function ScanProgress() {
  const status = useScanStatus()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!status || status.phase === 'idle' || status.phase === 'done' || status.phase === 'error' || status.phase === 'cancelled') return null

  const building = status.phase === 'building'
  const classifying = status.phase === 'classifying'
  const pct = classifying && status.anchorsTotal > 0
    ? Math.round((status.anchorsProcessed / status.anchorsTotal) * 100)
    : building ? 0 : 0
  const elapsed = status.startedAt ? now - status.startedAt : 0

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            Scanning for patterns
          </span>
          {classifying && status.alertsCreated > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground font-medium">
              {status.alertsCreated} alerts
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">{formatDuration(elapsed)}</span>
          <ConfirmDialog
            title="Cancel scan?"
            description="Progress so far will be discarded."
            actionLabel="Cancel scan"
            destructive
            onAction={async () => {
              await cancelScan()
              await refreshScanStatus()
            }}
          >
            <button className="cursor-pointer text-xs text-muted-foreground hover:text-destructive transition-colors">
              Cancel
            </button>
          </ConfirmDialog>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-foreground rounded-full transition-all duration-700 ease-out"
            style={{ width: `${Math.max(building ? 5 : pct, 2)}%` }}
          />
        </div>
        {classifying && (
          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>{status.anchorsProcessed} / {status.anchorsTotal} anchors</span>
            <span>{pct}%</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5 text-[11px]">
          {classifying ? <Check className="size-3 text-emerald-500" /> : <Loader2 className="size-3 animate-spin text-foreground" />}
          <span className={cn(classifying ? 'text-muted-foreground' : 'text-foreground font-medium')}>
            Building anchors
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          {classifying ? <Loader2 className="size-3 animate-spin text-foreground" /> : <Circle className="size-3 text-muted-foreground/30" />}
          <span className={cn(classifying ? 'text-foreground font-medium' : 'text-muted-foreground/50')}>
            Classifying
          </span>
        </div>
      </div>
    </div>
  )
}
