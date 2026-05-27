import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from './ui/alert-dialog'
import { compactCount } from '../lib/utils'

interface Props {
  processed: number
  total: number
  onKeep: () => void | Promise<void>
  onDiscard: () => void | Promise<void>
  children: ReactNode
}

export function CancelBackfillDialog({ processed, total, onKeep, onDiscard, children }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null)

  const run = (which: 'keep' | 'discard', fn: () => void | Promise<void>) => async () => {
    setBusy(which)
    try { await fn(); setOpen(false) } finally { setBusy(null) }
  }

  return (
    <AlertDialog open={open} onOpenChange={o => { if (!busy) setOpen(o) }}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel backfill?</AlertDialogTitle>
          <AlertDialogDescription>
            {compactCount(processed)} of {compactCount(total)} items processed so far.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          {processed > 0 && (
            <button
              onClick={run('keep', onKeep)}
              disabled={!!busy}
              className="w-full text-left rounded-md border border-border p-3 hover:bg-accent transition-colors disabled:opacity-50 flex items-center gap-3 cursor-pointer"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Stop &amp; keep {compactCount(processed)} items</div>
                <div className="text-xs text-muted-foreground mt-0.5">Cluster what's processed so you can use it now. The rest is skipped.</div>
              </div>
              {busy === 'keep' && <Loader2 className="size-4 animate-spin shrink-0" />}
            </button>
          )}
          <button
            onClick={run('discard', onDiscard)}
            disabled={!!busy}
            className="w-full text-left rounded-md border border-destructive/40 bg-destructive/5 p-3 hover:bg-destructive/10 transition-colors disabled:opacity-50 flex items-center gap-3 cursor-pointer"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-destructive">Discard everything</div>
              <div className="text-xs text-muted-foreground mt-0.5">Removes this run's items. Back to where you started.</div>
            </div>
            {busy === 'discard' && <Loader2 className="size-4 animate-spin shrink-0 text-destructive" />}
          </button>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={!!busy}>Keep running</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
