import { useState, useEffect } from 'react'
import { Loader2, AlertTriangle, X } from 'lucide-react'
import { useIngestStatus } from '../hooks/use-ingest-status.js'
import { useScanStatus } from '../hooks/use-scan-status.js'
import { cn } from '../lib/utils.js'

interface Props {
  onOpenSettings: () => void
}

type Banner = {
  kind: 'backfill' | 'scan'
  variant: 'running' | 'error'
  text: string
  phase: string
}

const DISMISS_KEY = 'strata-banner-dismissed'

export function PipelineBanner({ onOpenSettings }: Props) {
  const ingest = useIngestStatus()
  const scan = useScanStatus()
  const [dismissed, setDismissed] = useState<string | null>(() => sessionStorage.getItem(DISMISS_KEY))

  const banner: Banner | null = (() => {
    if (ingest) {
      const running = !['idle', 'done', 'error', 'cancelled'].includes(ingest.phase)
      if (running) {
        return {
          kind: 'backfill', variant: 'running',
          text: `Backfilling — ${compactCount(ingest.processed)} / ${compactCount(ingest.totalItems)}`,
          phase: `bf:${ingest.phase}`,
        }
      }
      if (ingest.phase === 'error') {
        return {
          kind: 'backfill', variant: 'error',
          text: `Backfill failed${ingest.error ? `: ${ingest.error}` : ''}`,
          phase: 'bf:error',
        }
      }
    }
    if (scan) {
      const running = scan.phase === 'building' || scan.phase === 'classifying'
      if (running) {
        const counts = scan.phase === 'classifying'
          ? `${scan.anchorsProcessed} / ${scan.anchorsTotal} anchors · ${scan.alertsCreated} alerts`
          : 'building anchor groups'
        return {
          kind: 'scan', variant: 'running',
          text: `Scanning — ${counts}`,
          phase: `scan:${scan.phase}`,
        }
      }
      if (scan.phase === 'error') {
        return {
          kind: 'scan', variant: 'error',
          text: `Scan failed${scan.error ? `: ${scan.error}` : ''}`,
          phase: 'scan:error',
        }
      }
    }
    return null
  })()

  useEffect(() => {
    if (banner && dismissed && dismissed !== banner.phase) setDismissed(null)
  }, [banner?.phase])

  if (!banner) return null
  if (dismissed === banner.phase) return null

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, banner.phase)
    setDismissed(banner.phase)
  }

  return (
    <div className={cn(
      'flex items-center gap-2 px-3 h-9 border-b text-xs',
      banner.variant === 'error'
        ? 'bg-destructive/10 border-destructive/20 text-destructive'
        : 'bg-muted/50 border-border text-foreground',
    )}>
      {banner.variant === 'error' ? <AlertTriangle className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
      <span className="flex-1 min-w-0 truncate">{banner.text}</span>
      <button
        onClick={onOpenSettings}
        className="cursor-pointer underline-offset-2 hover:underline"
      >
        {banner.variant === 'error' ? 'View details' : 'View progress'}
      </button>
      <button
        onClick={dismiss}
        className="cursor-pointer p-0.5 hover:bg-foreground/10 rounded"
        title="Dismiss"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
