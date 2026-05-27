import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Search, Hash, Layers, PenTool, Bell, Telescope, Loader2, type LucideIcon } from 'lucide-react'
import type { ToolCallData } from '../../types/chat'
import { cn } from '../../lib/utils'

const ICON_FOR: Record<string, LucideIcon> = {
  semantic_search: Search,
  list_alerts: Bell,
  get_alert: Bell,
  get_topic: Hash,
  list_topics: Layers,
  get_thread: PenTool,
  get_item: PenTool,
  mark_relevant: Telescope,
}

export function titleFor(step: ToolCallData): string {
  const args = (step.args ?? {}) as Record<string, unknown>
  if (step.name === 'semantic_search') {
    const q = typeof args.query === 'string' ? args.query : ''
    return q ? `Searching "${q.length > 40 ? q.slice(0, 40) + '…' : q}"` : 'Searching'
  }
  if (step.name === 'list_alerts') {
    const parts: string[] = []
    if (args.flag_type) parts.push(String(args.flag_type))
    else if (args.mode) parts.push(String(args.mode))
    if (args.status) parts.push(String(args.status))
    return parts.length > 0 ? `Listing ${parts.join(' ')} alerts` : 'Listing alerts'
  }
  if (step.name === 'get_alert') return 'Reading alert'
  if (step.name === 'get_topic') return `Reading topic ${args.label ?? ''}`.trim()
  if (step.name === 'list_topics') return 'Ranking topics'
  if (step.name === 'get_thread') return 'Reading thread'
  if (step.name === 'get_item') return 'Reading item'
  if (step.name === 'mark_relevant') {
    const n = Array.isArray(args.ids) ? (args.ids as unknown[]).length : 0
    return n > 0 ? `Marking ${n} relevant` : 'Marking relevant'
  }
  return step.name
}

interface StepProps {
  step: ToolCallData
  expanded: boolean
  onToggle: () => void
  isNew: boolean
}

function ToolStep({ step, expanded, onToggle, isNew }: StepProps) {
  const ref = useRef<HTMLDivElement>(null)
  const isRunning = step.status === 'running'
  const Icon = ICON_FOR[step.name] ?? Search
  const title = titleFor(step)
  const content = step.preview ?? ''
  const hasContent = content.length > 0
  const resultLabel = step.summary ?? ''

  useEffect(() => {
    if (isNew && ref.current) {
      ref.current.style.opacity = '0'
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (ref.current) {
            ref.current.style.transition = 'opacity 0.4s ease-out'
            ref.current.style.opacity = '1'
          }
        })
      })
    }
  }, [isNew])

  return (
    <div ref={ref} className="relative" style={{ opacity: isNew ? 0 : 1 }}>
      <div className="flex items-center gap-2 h-8">
        <div className="size-4 flex items-center justify-center shrink-0 relative z-10">
          <div className="absolute size-3 bg-background" />
          {isRunning ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground relative" />
          ) : (
            <Icon className="size-3.5 text-muted-foreground relative" />
          )}
        </div>
        <button
          onClick={hasContent ? onToggle : undefined}
          className={cn('flex-1 flex items-center gap-2 text-left min-w-0', hasContent && 'cursor-pointer')}
        >
          <span className="flex-1 text-sm truncate">{title}</span>
          <span className="text-xs text-muted-foreground/50 shrink-0 max-w-[120px] truncate whitespace-nowrap text-right">{resultLabel}</span>
          <ChevronDown className={cn(
            'size-4 text-muted-foreground transition-transform shrink-0',
            expanded && 'rotate-180',
            !hasContent && 'invisible',
          )} />
        </button>
      </div>
      {expanded && hasContent && (
        <div className="mt-1 ml-6 max-h-48 overflow-y-auto mb-1 space-y-0.5">
          {content.split('\n').filter(Boolean).map((line, i) => (
            <div key={i} className="text-[11px] text-muted-foreground/70 font-mono truncate">{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

interface ReasoningStepsProps {
  steps: ToolCallData[]
}

export function ReasoningSteps({ steps }: ReasoningStepsProps) {
  const [showAll, setShowAll] = useState(true)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const seenRef = useRef<Set<string>>(new Set())
  const [newSteps, setNewSteps] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const [lineHeight, setLineHeight] = useState(0)

  useEffect(() => {
    const newIds = new Set<string>()
    steps.forEach((s) => {
      if (!seenRef.current.has(s.id)) {
        newIds.add(s.id)
        seenRef.current.add(s.id)
      }
    })
    if (newIds.size > 0) {
      requestAnimationFrame(() => setNewSteps(newIds))
      const timer = setTimeout(() => setNewSteps(new Set()), 500)
      return () => clearTimeout(timer)
    }
  }, [steps])

  useEffect(() => {
    const update = () => {
      if (!containerRef.current || steps.length < 2) {
        setLineHeight(0)
        return
      }
      const children = containerRef.current.children
      if (children.length < 2) return
      const first = children[0] as HTMLElement
      const last = children[children.length - 1] as HTMLElement
      setLineHeight(last.offsetTop - first.offsetTop)
    }
    update()
    const timer = setTimeout(update, 50)
    return () => clearTimeout(timer)
  }, [steps, expandedSteps, showAll])

  if (steps.length === 0) return null

  const toggleStep = (id: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="mb-1">
      <button onClick={() => setShowAll((v) => !v)} className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer mb-0.5">
        {showAll ? <ChevronDown className="size-4" /> : <ChevronDown className="size-4 -rotate-90" />}
        {showAll ? 'Hide steps' : 'Show steps'}
      </button>
      {showAll && (
        <div className="relative">
          {steps.length > 1 && lineHeight > 0 && (
            <div
              className="absolute left-2 w-px bg-muted-foreground/30 -translate-x-1/2"
              style={{ top: 16, height: lineHeight }}
            />
          )}
          <div ref={containerRef}>
            {steps.map((step) => (
              <ToolStep
                key={step.id}
                step={step}
                expanded={expandedSteps.has(step.id)}
                onToggle={() => toggleStep(step.id)}
                isNew={newSteps.has(step.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
