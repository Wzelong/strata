import { RotateCcw, PenTool, MessageSquareText, Hash } from 'lucide-react'
import { compactCount } from '../../lib/utils'

interface GraphStatsProps {
  postCount: number
  commentCount: number
  clusterCount: number
  isHighlighted: boolean
  onReset: () => void
}

export function GraphStats({ postCount, commentCount, clusterCount, isHighlighted, onReset }: GraphStatsProps) {
  if (isHighlighted) {
    return (
      <button
        type="button"
        onClick={onReset}
        aria-label="Reset"
        className="absolute top-3 right-3 z-10 text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <RotateCcw className="size-3" />
      </button>
    )
  }
  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 sm:gap-3 text-xs leading-none text-muted-foreground select-none">
      <span className="flex items-center gap-1"><PenTool className="size-3" />{compactCount(postCount)}</span>
      <span className="flex items-center gap-1"><MessageSquareText className="size-3" />{compactCount(commentCount)}</span>
      <span className="flex items-center gap-1"><Hash className="size-3" />{compactCount(clusterCount)}</span>
    </div>
  )
}
