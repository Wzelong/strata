import { useState, useEffect, useCallback } from 'react'
import { Loader2, AlertTriangle, CalendarIcon } from 'lucide-react'
import { format } from 'date-fns'
import { previewBackfill, confirmBackfill, type BackfillEstimate } from '../lib/api'
import { refreshIngestStatus } from '../hooks/use-ingest-status'
import { cn, formatBytes, compactCount } from '../lib/utils'
import { Calendar } from './ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { InlineTabs } from './ui/inline-tabs'

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

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground tabular-nums mt-0.5">{sub}</div>}
    </div>
  )
}

function DatePicker({ value, onChange, label, disabled }: {
  value: Date
  onChange: (d: Date) => void
  label: string
  disabled?: (date: Date) => boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer flex-1 h-9 px-3 inline-flex items-center gap-2 rounded-md border border-border bg-background text-sm hover:bg-accent transition-colors">
          <CalendarIcon className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-left">{format(value, 'MMM d, yyyy')}</span>
          <span className="text-[10px] text-muted-foreground uppercase">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={(d) => { if (d) { onChange(d); setOpen(false) } }}
          defaultMonth={value}
          disabled={disabled}
        />
      </PopoverContent>
    </Popover>
  )
}

export function OnboardingForm({ onStarted, onCancel }: Props) {
  const [from, setFrom] = useState(offsetDate(-30))
  const [to, setTo] = useState(offsetDate(0))
  const [estimate, setEstimate] = useState<BackfillEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estError, setEstError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [demo, setDemo] = useState(true)
  const [mode, setMode] = useState<'realtime' | 'batch'>('realtime')

  const runPreview = useCallback(async (f: Date, t: Date, useDemo: boolean) => {
    setEstimating(true)
    setEstError(null)
    setEstimate(null)
    try {
      const res = await previewBackfill(isoDate(f), isoDate(t), useDemo)
      if ('error' in res) setEstError(res.error)
      else setEstimate(res)
    } catch (err) {
      setEstError(String(err))
    } finally {
      setEstimating(false)
    }
  }, [])

  useEffect(() => { runPreview(from, to, demo) }, [])

  const applyPreset = (days: number) => {
    const f = offsetDate(-days)
    const t = offsetDate(0)
    setFrom(f)
    setTo(t)
    runPreview(f, t, demo)
  }

  const handleFromChange = (d: Date) => {
    setFrom(d)
    if (d > to) { setTo(d); runPreview(d, d, demo) }
    else runPreview(d, to, demo)
  }

  const handleToChange = (d: Date) => {
    setTo(d)
    if (d < from) { setFrom(d); runPreview(d, d, demo) }
    else runPreview(from, d, demo)
  }

  const toggleDemo = () => {
    const next = !demo
    setDemo(next)
    runPreview(from, to, next)
  }

  const handleConfirm = async () => {
    if (!estimate || estimate.willExceed) return
    setSubmitting(true)
    try {
      const res = await confirmBackfill(estimate.token, mode)
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

  const canSubmit = estimate && !estimate.willExceed && !submitting

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <DatePicker
            value={from}
            onChange={handleFromChange}
            label="from"
            disabled={(d) => d > new Date()}
          />
          <span className="text-muted-foreground text-sm">→</span>
          <DatePicker
            value={to}
            onChange={handleToChange}
            label="to"
            disabled={(d) => d > new Date()}
          />
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

      <InlineTabs
        tabs={[{ value: 'realtime', label: 'Fast' }, { value: 'batch', label: 'Economy' }]}
        value={mode}
        onChange={(v) => setMode(v as 'realtime' | 'batch')}
      />

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
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Estimated</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Metric label="Items" value={compactCount(estimate.itemCount)} />
              <Metric
                label="Timing"
                value={mode === 'realtime'
                  ? `~${estimate.realtimeEstimate?.estimatedMinutes ?? '?'} min`
                  : `${Math.ceil(Math.ceil(estimate.itemCount / 500) * 2)} min – ${Math.ceil(Math.ceil(estimate.itemCount / 500) * 24 / 60)} hrs`}
                sub={mode === 'realtime' ? 'Predictable, linear' : 'Depends on OpenAI batch queue'}
              />
              <Metric
                label="OpenAI cost"
                value={`$${(mode === 'realtime' ? estimate.realtimeEstimate?.estimatedCostUsd ?? 0 : estimate.estimatedCostUsd).toFixed(2)}`}
                sub={mode === 'realtime' ? 'Standard pricing' : 'Batch pricing (50% off)'}
              />
              <Metric
                label="Storage"
                value={formatBytes(estimate.estimatedBytes)}
                sub={`${formatBytes(estimate.currentBytes + estimate.estimatedBytes)} / ${formatBytes(estimate.capacityBytes)}`}
              />
            </div>
            {estimate.willExceed && (
              <div className="flex items-start gap-1.5 text-xs text-destructive pt-1">
                <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                <span>
                  Exceeds capacity. {compactCount(estimate.currentItemCount)} current + {compactCount(estimate.itemCount)} new &gt; {compactCount(estimate.itemCapacity)} items.
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-start gap-2">
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
