import { useMemo, useRef, useCallback } from 'react'
import { ChevronLeft, ChevronRight, ChevronLast } from 'lucide-react'
import { cn } from '../../lib/utils'

const DAY = 86_400_000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfMonth(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return d.getTime()
}

function addMonths(ts: number, delta: number): number {
  const d = new Date(ts)
  d.setMonth(d.getMonth() + delta)
  return d.getTime()
}

function formatMonth(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function formatRelative(curDay: number, maxDay: number): string {
  if (curDay >= maxDay) return 'Today'
  const days = Math.round((maxDay - curDay) / DAY)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

interface TimelineCardProps {
  minTs: number
  maxTs: number
  tCurrent: number
  onChange: (t: number) => void
  timestamps: number[]
}

export function TimelineCard({ minTs, maxTs, tCurrent, onChange, timestamps }: TimelineCardProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const cappedT = Math.min(tCurrent, maxTs)

  const viewMonth = useMemo(() => startOfMonth(cappedT), [cappedT])

  const days = useMemo(() => {
    const result: { start: number; end: number }[] = []
    const next = addMonths(viewMonth, 1)
    let t = viewMonth
    while (t < next) {
      result.push({ start: t, end: t + DAY - 1 })
      t += DAY
    }
    return result
  }, [viewMonth])

  const histogram = useMemo(() => {
    if (days.length === 0) return []
    const counts = new Array(days.length).fill(0)
    for (const ts of timestamps) {
      const idx = Math.floor((ts - viewMonth) / DAY)
      if (idx >= 0 && idx < days.length) counts[idx]++
    }
    const maxCount = Math.max(...counts, 1)
    return counts.map(c => c / maxCount)
  }, [timestamps, days, viewMonth])

  const curDay = useMemo(() => startOfDay(cappedT), [cappedT])
  const maxDay = useMemo(() => startOfDay(maxTs), [maxTs])

  const minMonth = useMemo(() => startOfMonth(minTs), [minTs])
  const maxMonth = useMemo(() => startOfMonth(maxTs), [maxTs])
  const canPrev = viewMonth > minMonth
  const canNext = viewMonth < maxMonth

  const stepBack = () => {
    if (!canPrev) return
    const prevMonthEnd = viewMonth - 1
    onChange(Math.max(prevMonthEnd, minTs))
  }

  const stepForward = () => {
    if (!canNext) return
    const nextMonthEnd = addMonths(viewMonth, 2) - 1
    onChange(Math.min(nextMonthEnd, maxTs))
  }

  const updateFromPointer = useCallback((e: React.PointerEvent) => {
    const el = stripRef.current
    if (!el || days.length === 0) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const idx = Math.min(days.length - 1, Math.floor(ratio * days.length))
    onChange(Math.min(days[idx].end, maxTs))
  }, [days, maxTs, onChange])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const cur = startOfDay(cappedT)
    let next: number | null = null
    if (e.key === 'ArrowLeft' && !e.shiftKey) next = cur - 1
    else if (e.key === 'ArrowRight' && !e.shiftKey) next = cur + 2 * DAY - 1
    else if (e.key === 'ArrowLeft' && e.shiftKey) {
      if (canPrev) next = viewMonth - 1
    } else if (e.key === 'ArrowRight' && e.shiftKey) {
      if (canNext) next = addMonths(viewMonth, 2) - 1
    } else if (e.key === 'Home') next = minTs
    else if (e.key === 'End') next = maxTs
    if (next !== null) {
      e.preventDefault()
      onChange(Math.max(minTs, Math.min(maxTs, next)))
    }
  }

  return (
    <div className="absolute top-2 left-2 sm:top-3 sm:left-3 z-10 w-[clamp(160px,40vw,280px)] sm:w-[clamp(240px,30vw,280px)] select-none">
      <div className="flex items-center justify-between mb-1 sm:mb-2">
        <button
          type="button"
          onClick={stepBack}
          disabled={!canPrev}
          aria-label="Previous month"
          className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          <ChevronLeft className="size-3 sm:size-3.5" />
        </button>
        <span className="text-[10px] sm:text-xs tabular-nums leading-none flex items-center gap-1 sm:gap-1.5">
          <span className="text-foreground">{formatMonth(viewMonth)}</span>
          <span className="text-muted-foreground hidden sm:inline">·</span>
          <span className="text-muted-foreground hidden sm:inline">{formatRelative(curDay, maxDay)}</span>
          {curDay < maxDay && (
            <button
              type="button"
              onClick={() => onChange(maxTs)}
              aria-label="Jump to today"
              className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            >
              <ChevronLast className="size-2.5 sm:size-3" />
            </button>
          )}
        </span>
        <button
          type="button"
          onClick={stepForward}
          disabled={!canNext}
          aria-label="Next month"
          className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          <ChevronRight className="size-3 sm:size-3.5" />
        </button>
      </div>
      <div
        ref={stripRef}
        tabIndex={0}
        role="slider"
        aria-label="Timeline cursor"
        className="relative h-4 sm:h-6 cursor-pointer touch-none rounded-sm outline-none"
        onKeyDown={handleKeyDown}
        onPointerDown={(e) => {
          draggingRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          updateFromPointer(e)
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) updateFromPointer(e)
        }}
        onPointerUp={(e) => {
          draggingRef.current = false
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
      >
        <div className="absolute inset-0 flex items-end gap-px">
          {histogram.map((h, i) => (
            <div
              key={i}
              className={cn(
                'flex-1 rounded-sm',
                days[i].start <= curDay ? 'bg-foreground/60' : 'bg-muted-foreground/20',
              )}
              style={{ height: `${Math.max(8, h * 100)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
