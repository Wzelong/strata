import { cn } from '../lib/utils'

interface HighlightedTextProps {
  text: string
  entities: string[]
  activeEntity: string | null
  onEntityClick: (entity: string) => void
}

type Segment = { text: string; entity?: string }

function buildSegments(text: string, entities: string[]): Segment[] {
  if (entities.length === 0) return [{ text }]

  const sorted = [...entities].sort((a, b) => b.length - a.length)
  const marks: Array<{ start: number; end: number; entity: string }> = []
  const lower = text.toLowerCase()

  for (const entity of sorted) {
    const needle = entity.toLowerCase()
    let idx = 0
    while ((idx = lower.indexOf(needle, idx)) !== -1) {
      const overlaps = marks.some(m => idx < m.end && idx + needle.length > m.start)
      if (!overlaps) marks.push({ start: idx, end: idx + needle.length, entity })
      idx += needle.length
    }
  }

  marks.sort((a, b) => a.start - b.start)

  const segments: Segment[] = []
  let cursor = 0
  for (const mark of marks) {
    if (mark.start > cursor) segments.push({ text: text.slice(cursor, mark.start) })
    segments.push({ text: text.slice(mark.start, mark.end), entity: mark.entity })
    cursor = mark.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })

  return segments
}

export function HighlightedText({ text, entities, activeEntity, onEntityClick }: HighlightedTextProps) {
  const segments = buildSegments(text, entities)
  console.log('[HighlightedText]', { text: text.slice(0, 50), entities, activeEntity, segmentCount: segments.length, highlights: segments.filter(s => s.entity).map(s => ({ text: s.text, entity: s.entity })) })

  return (
    <span>
      {segments.map((seg, i) =>
        seg.entity ? (
          <span
            key={i}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEntityClick(seg.entity!) }}
            className={cn(
              'rounded-sm px-0.5 -mx-0.5 cursor-pointer transition-colors',
              activeEntity === seg.entity
                ? 'bg-primary/25 text-primary'
                : 'bg-primary/8 hover:bg-primary/15',
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
