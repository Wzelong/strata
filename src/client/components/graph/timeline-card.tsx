import { useMemo } from 'react'

const DAY_MS = 86_400_000

function startOfDay(ts: number) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface TimelineCardProps {
  minTs: number
  maxTs: number
  tCurrent: number
  onChange: (t: number) => void
}

export function TimelineCard({ minTs, maxTs, tCurrent, onChange }: TimelineCardProps) {
  const { minDay, maxDay, dayCount } = useMemo(() => {
    const minD = startOfDay(minTs)
    const maxD = startOfDay(maxTs)
    return { minDay: minD, maxDay: maxD, dayCount: Math.round((maxD - minD) / DAY_MS) + 1 }
  }, [minTs, maxTs])

  const currentDay = startOfDay(Math.min(tCurrent, maxDay))
  const dayIndex = Math.max(0, Math.min(dayCount - 1, Math.round((currentDay - minDay) / DAY_MS)))
  const daysAgo = Math.round((maxDay - currentDay) / DAY_MS)
  const label = daysAgo === 0 ? 'Today' : `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`

  return (
    <div className="absolute top-3 left-3 z-10 w-52 select-none">
      <div className="text-xs leading-none mb-2 tabular-nums">
        <span className="text-foreground">{formatDate(currentDay)}</span>
        <span className="mx-1.5 text-muted-foreground">·</span>
        <span className="text-muted-foreground">{label}</span>
      </div>
      <input
        type="range"
        min={0}
        max={dayCount - 1}
        step={1}
        value={dayIndex}
        onChange={e => {
          const v = Number(e.target.value)
          const t = v === dayCount - 1 ? maxTs : minDay + (v + 1) * DAY_MS - 1
          onChange(t)
        }}
        className="w-full h-4 appearance-none bg-transparent cursor-pointer
          [&::-webkit-slider-runnable-track]:h-px [&::-webkit-slider-runnable-track]:bg-border [&::-webkit-slider-runnable-track]:rounded-full
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-2 [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:mt-[-3.5px]
          [&::-moz-range-track]:h-px [&::-moz-range-track]:bg-border [&::-moz-range-track]:rounded-full
          [&::-moz-range-thumb]:h-2 [&::-moz-range-thumb]:w-2 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-foreground [&::-moz-range-thumb]:border-0"
      />
    </div>
  )
}
