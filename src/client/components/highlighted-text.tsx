import type { AlertEntity } from '../../engine/types'
import { cn } from '../lib/utils'

interface HighlightedTextProps {
  text: string
  entities: AlertEntity[]
  activeCluster: string | null
  onClusterClick: (clusterId: string) => void
}

type Segment = { text: string; clusterId?: string }

function buildSegments(text: string, entities: AlertEntity[]): Segment[] {
  const valid = (entities ?? []).filter(e => e && typeof e.text === 'string' && e.text.length > 0)
  if (valid.length === 0) return [{ text }]

  const sorted = [...valid].sort((a, b) => b.text.length - a.text.length)
  const marks: Array<{ start: number; end: number; clusterId: string }> = []
  const lower = text.toLowerCase()

  for (const entity of sorted) {
    if (!entity.text) continue
    const needle = entity.text.toLowerCase()
    let idx = 0
    while ((idx = lower.indexOf(needle, idx)) !== -1) {
      const end = idx + needle.length
      const overlaps = marks.some(m => idx < m.end && end > m.start)
      if (!overlaps) marks.push({ start: idx, end, clusterId: entity.clusterId })
      idx = end
    }
  }

  marks.sort((a, b) => a.start - b.start)

  const segments: Segment[] = []
  let cursor = 0
  for (const mark of marks) {
    if (mark.start > cursor) segments.push({ text: text.slice(cursor, mark.start) })
    segments.push({ text: text.slice(mark.start, mark.end), clusterId: mark.clusterId })
    cursor = mark.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })

  return segments
}

export function HighlightedText({ text, entities, activeCluster, onClusterClick }: HighlightedTextProps) {
  const segments = buildSegments(text, entities)

  return (
    <span>
      {segments.map((seg, i) =>
        seg.clusterId ? (
          <span
            key={i}
            data-cluster={seg.clusterId}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClusterClick(seg.clusterId!) }}
            className={cn(
              'rounded-[3px] px-0.5 -mx-0.5 cursor-pointer transition-colors',
              '[box-decoration-break:clone] [-webkit-box-decoration-break:clone]',
              activeCluster === seg.clusterId
                ? 'bg-amber-300 text-amber-950 dark:bg-amber-300/60 dark:text-amber-50'
                : 'bg-amber-200/80 text-amber-950 hover:bg-amber-300/90 dark:bg-amber-300/25 dark:text-amber-50 dark:hover:bg-amber-300/40',
            )}
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  )
}
