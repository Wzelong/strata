import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatRelativeTime } from '../../lib/utils'
import type { CodeUnitNode } from '../../types/graph'

const BODY_PREVIEW_CHARS = 140

interface NodeCardProps {
  node: CodeUnitNode
  clusterColor?: string
  orphanColor: string
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
}

export function NodeCard({ node, clusterColor, orphanColor, index, total, onPrev, onNext }: NodeCardProps) {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { setExpanded(false) }, [node.id])

  const isPost = node.kind === 'post'
  const title = isPost
    ? (node.title ?? node.symbol_name)
    : node.thread_title ? `Comment on "${node.thread_title}"` : 'Comment'
  const body = node.text ?? ''
  const canExpand = body.length > BODY_PREVIEW_CHARS
  const showPagination = total > 1

  return (
    <div className="absolute bottom-3 left-3 z-20 w-[320px] rounded-md border border-border bg-background/95 backdrop-blur-sm shadow-sm">
      <div className="px-3 pt-2.5 pb-1.5">
        <p className="text-sm font-medium leading-snug line-clamp-2">{title}</p>
        {node.author && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            u/{node.author}{node.created_at ? ` · ${formatRelativeTime(node.created_at)}` : ''}
          </div>
        )}
      </div>

      {body && (
        <div className="px-3 text-[11px] text-foreground/70 leading-relaxed">
          <p className={!expanded && canExpand ? 'line-clamp-3 whitespace-pre-wrap' : 'whitespace-pre-wrap'}>
            {body}
          </p>
          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded(e => !e)}
              className="mt-1 text-foreground hover:underline cursor-pointer"
            >
              {expanded ? 'show less' : 'show more'}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between px-3 py-2 mt-1.5 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="size-1.5 rounded-full shrink-0"
            style={{ background: node.cluster_label ? clusterColor : orphanColor }}
          />
          <span className="truncate">{node.cluster_label ?? 'no topic'}</span>
        </div>
        {showPagination && (
          <div className="flex items-center gap-2 shrink-0">
            <span>{index + 1} of {total}</span>
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous"
              className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 disabled:cursor-default"
              disabled={index === 0}
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next"
              className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 disabled:cursor-default"
              disabled={index === total - 1}
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
