import { useState, useEffect, useCallback } from 'react'
import { Loader2, AlertTriangle, CalendarIcon } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { format } from 'date-fns'
import { previewBackfill, confirmBackfill, type BackfillEstimate } from '../lib/api'
import { refreshIngestStatus } from '../hooks/use-ingest-status'
import { cn, formatBytes } from '../lib/utils'
import { Calendar } from './ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'

const PRESETS: Array<{ label: string; days: number }> = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
]

function offsetDate(days: number): Date {
  return new Date(Date.now() + days * 86400_000)
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

interface Props {
  onStarted?: () => void
  onCancel?: () => void
}

export function OnboardingForm({ onStarted, onCancel }: Props) {
  const [range, setRange] = useState<DateRange>({ from: offsetDate(-30), to: offsetDate(0) })
  const [estimate, setEstimate] = useState<BackfillEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estError, setEstError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [demo, setDemo] = useState(true)

  const runPreview = useCallback(async (r: DateRange, useDemo: boolean) => {
    if (!r.from || !r.to) return
    const f = isoDate(r.from)
    const t = isoDate(r.to)
    setEstimating(true)
    setEstError(null)
    setEstimate(null)
    try {
      const res = await previewBackfill(f, t, useDemo)
      if ('error' in res) setEstError(res.error)
      else setEstimate(res)
    } catch (err) {
      setEstError(String(err))
    } finally {
      setEstimating(false)
    }
  }, [])

  useEffect(() => { runPreview(range, demo) }, [])

  const applyPreset = (days: number) => {
    const next: DateRange = { from: offsetDate(-days), to: offsetDate(0) }
    setRange(next)
    runPreview(next, demo)
  }

  const handleRangeChange = (next: DateRange | undefined) => {
    if (!next) return
    setRange(next)
    if (next.from && next.to) runPreview(next, demo)
  }

  const toggleDemo = () => {
    const next = !demo
    setDemo(next)
    runPreview(range, next)
  }

  const handleConfirm = async () => {
    if (!estimate || estimate.willExceed) return
    setSubmitting(true)
    try {
      const res = await confirmBackfill(estimate.token)
      if ('error' in res) {
        setEstError(res.error)
        setSubmitting(false)
        return
      }
      await refreshIngestStatus()
      onStarted?.()
    } catch (err) {
      setEstError(String(err))
      setSubmitting(false)
    }
  }

  const datesValid = !!(range.from && range.to)
  const canSubmit = estimate && !estimate.willExceed && !submitting && datesValid
  const label = range.from && range.to
    ? `${format(range.from, 'MMM d, yyyy')} → ${format(range.to, 'MMM d, yyyy')}`
    : 'Select date range'

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button className="cursor-pointer flex-1 h-9 px-3 inline-flex items-center gap-2 rounded-md border border-border bg-background text-sm hover:bg-accent transition-colors">
                <CalendarIcon className="size-3.5 text-muted-foreground" />
                <span className={cn('flex-1 text-left', !datesValid && 'text-muted-foreground')}>{label}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-2" align="start">
              <Calendar
                mode="range"
                selected={range}
                onSelect={handleRangeChange}
                numberOfMonths={2}
                defaultMonth={range.from ?? offsetDate(-30)}
                disabled={{ after: new Date() }}
              />
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex items-center gap-1.5">
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => applyPreset(p.days)}
              className="cursor-pointer text-xs px-2 py-1 rounded-md border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              Last {p.label}
            </button>
          ))}
        </div>
        <button
          onClick={toggleDemo}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <span className={cn(
            'flex h-4 w-7 items-center rounded-full px-0.5 transition-colors',
            demo ? 'bg-foreground' : 'bg-muted',
          )}>
            <span className={cn(
              'size-3 rounded-full bg-background transition-transform',
              demo && 'translate-x-3',
            )} />
          </span>
          Use demo data (sample subreddit, for testing)
        </button>
      </div>

      <div className={cn(
        'rounded-md border p-3 space-y-2',
        estimate?.willExceed ? 'border-destructive/50 bg-destructive/5' : 'border-border bg-muted/30',
      )}>
        {estimating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Counting posts in date range…
          </div>
        )}
        {!estimating && estError && (
          <div className="text-sm text-destructive">{estError}</div>
        )}
        {!estimating && estimate && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm font-medium">~ {estimate.itemCount.toLocaleString()} items</div>
              <div className="text-xs text-muted-foreground">~ {estimate.estimatedMinutes} min</div>
            </div>
            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-1.5">
              <span>~ ${estimate.estimatedCostUsd.toFixed(2)} OpenAI</span>
              <span>·</span>
              <span>~ {formatBytes(estimate.estimatedBytes)} Redis</span>
              <span>·</span>
              <span>{formatBytes(estimate.currentBytes)} → {formatBytes(estimate.currentBytes + estimate.estimatedBytes)} / {formatBytes(estimate.capacityBytes)}</span>
            </div>
            {estimate.willExceed && (
              <div className="flex items-start gap-1.5 text-xs text-destructive pt-1">
                <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                <span>
                  Exceeds capacity. Current {estimate.currentItemCount.toLocaleString()} + backfill {estimate.itemCount.toLocaleString()} &gt; {estimate.itemCapacity.toLocaleString()} items.
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={submitting}
            className="cursor-pointer h-8 px-3 text-xs rounded-md border border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          onClick={handleConfirm}
          disabled={!canSubmit}
          className={cn(
            'h-8 px-4 text-sm rounded-md font-medium transition-colors',
            canSubmit
              ? 'bg-foreground text-background hover:bg-foreground/90 cursor-pointer'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          {submitting ? 'Starting…' : 'Start backfill'}
        </button>
      </div>
    </div>
  )
}
