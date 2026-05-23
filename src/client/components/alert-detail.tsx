import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, ClipboardList, Telescope, Sparkles } from 'lucide-react'
import { fetchAlertDetail, alertAction, type AlertDetail } from '../lib/api'
import { ChatPanel } from './chat-panel'
import { HighlightedText } from './highlighted-text'
import { cn, formatRelativeTime } from '../lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'

type DetailTab = 'overview' | 'explore' | 'chat'

interface AlertDetailPanelProps {
  alertId: string | null
  onBack: () => void
  onStatusChange: () => void
}

export function AlertDetailPanel({ alertId, onBack, onStatusChange }: AlertDetailPanelProps) {
  const [alert, setAlert] = useState<AlertDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [activeCluster, setActiveCluster] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  const toggleCluster = (id: string) => setActiveCluster(prev => prev === id ? null : id)

  // When a cluster becomes active, bring its other occurrences into view.
  // Skip when (a) cluster cleared, (b) all matches already visible, (c) only
  // one match exists. Picks the nearest off-screen match by document order.
  useEffect(() => {
    if (!activeCluster) return
    const container = scrollContainerRef.current
    if (!container) return
    const matches = Array.from(
      container.querySelectorAll<HTMLElement>(`[data-cluster="${CSS.escape(activeCluster)}"]`),
    )
    if (matches.length < 2) return
    const cRect = container.getBoundingClientRect()
    const offscreen = matches.find(el => {
      const r = el.getBoundingClientRect()
      return r.bottom <= cRect.top + 8 || r.top >= cRect.bottom - 8
    })
    if (!offscreen) return
    offscreen.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeCluster])

  useEffect(() => {
    if (!alertId) { setAlert(null); return }
    setLoading(true)
    fetchAlertDetail(alertId).then(setAlert).finally(() => setLoading(false))
  }, [alertId])

  const handleAction = async (action: 'resolved' | 'dismissed') => {
    if (!alertId) return
    setActing(true)
    await alertAction(alertId, action)
    setActing(false)
    onStatusChange()
    onBack()
  }

  const tabs: Array<{ value: DetailTab; label: string; icon: React.ReactNode; hideOnXl?: boolean }> = [
    { value: 'overview', label: 'Overview', icon: <ClipboardList className="size-3.5" /> },
    { value: 'explore', label: 'Explore', icon: <Telescope className="size-3.5" /> },
    { value: 'chat', label: 'AI Chat', icon: <Sparkles className="size-3.5" />, hideOnXl: true },
  ]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header — always visible */}
      <div className="h-10 px-3 border-b flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <ArrowLeft
            className="size-3.5 cursor-pointer text-muted-foreground hover:text-foreground transition-colors shrink-0 lg:hidden"
            onClick={onBack}
          />
          {alert && (
            <span className={cn(
              'text-[10px] font-medium uppercase tracking-wider shrink-0',
              alert.confidence === 'high' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
            )}>
              {alert.confidence === 'high' ? 'High confidence' : 'Needs review'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {tabs.map(t => (
            <Tooltip key={t.value}>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    'h-7 w-7 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground transition-colors',
                    detailTab === t.value && 'bg-muted',
                    t.hideOnXl && 'xl:hidden',
                  )}
                  onClick={() => setDetailTab(t.value)}
                  aria-label={t.label}
                >
                  {t.icon}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Body */}
      {!alert ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <ClipboardList className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Select an alert to review</p>
        </div>
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      ) : (
        <>
          <div ref={scrollContainerRef} className={cn('flex-1 overflow-y-auto min-h-0', detailTab !== 'chat' && 'px-3 py-3')}>
            {detailTab === 'chat' ? (
              <ChatPanel />
            ) : detailTab === 'overview' ? (
              <>
                {/* Title */}
                {alert.anchorPermalink ? (
                  <a href={`https://reddit.com${alert.anchorPermalink}`} target="_blank" rel="noopener noreferrer" className="text-base font-semibold break-words line-clamp-2 hover:underline block">
                    {alert.anchorType === 'comment'
                      ? (alert.anchorTitle ? `Comment on "${alert.anchorTitle}"` : 'Comment')
                      : (alert.anchorTitle || alert.anchorText.slice(0, 80))
                    }
                  </a>
                ) : (
                  <p className="text-base font-semibold break-words line-clamp-2">
                    {alert.anchorType === 'comment'
                      ? (alert.anchorTitle ? `Comment on "${alert.anchorTitle}"` : 'Comment')
                      : (alert.anchorTitle || alert.anchorText.slice(0, 80))
                    }
                  </p>
                )}

                {/* Author */}
                <div className="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground">
                  <a href={`https://reddit.com/u/${alert.anchorAuthor}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
                    u/{alert.anchorAuthor}
                  </a>
                  <span>·</span>
                  <span>{formatRelativeTime(alert.createdAt)}</span>
                </div>

                {/* Body */}
                <p className="text-sm leading-relaxed break-words mt-3">
                  <HighlightedText
                    text={alert.anchorText}
                    entities={alert.anchorEntities ?? []}
                    activeCluster={activeCluster}
                    onClusterClick={toggleCluster}
                  />
                </p>

                {/* Reasoning (flag alerts) */}
                {alert.reasoning && (
                  <p className="text-xs text-muted-foreground mt-3">{alert.reasoning}</p>
                )}

                {/* Connections */}
                <div className="flex flex-col gap-2 mt-6">
                  {alert.connections.map(conn => {
                    const label = conn.classification === 'confirms' ? 'Supports'
                      : conn.classification === 'contradicts' ? 'Contradicts'
                      : conn.classification === 'updates' ? 'New info'
                      : 'Timeline'
                    const connTitle = conn.type === 'comment'
                      ? (conn.title ? `Comment on "${conn.title}"` : 'Comment')
                      : (conn.title || conn.text.slice(0, 80))
                    return (
                      <div key={conn.itemId} className="rounded-md border border-border px-3 py-2.5 relative">
                        <span className={cn(
                          'absolute top-2.5 right-3 text-[10px] px-1.5 py-0.5 rounded font-medium',
                          conn.classification === 'contradicts'
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            : 'bg-muted text-muted-foreground',
                        )}>
                          {label}
                        </span>
                        {conn.permalink ? (
                          <a href={`https://reddit.com${conn.permalink}`} target="_blank" rel="noopener noreferrer" className="text-sm font-medium break-words line-clamp-2 hover:underline block pr-16">
                            {connTitle}
                          </a>
                        ) : (
                          <p className="text-sm font-medium break-words line-clamp-2 pr-16">{connTitle}</p>
                        )}
                        <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground">
                          <a href={`https://reddit.com/u/${conn.author}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
                            u/{conn.author}
                          </a>
                          {conn.createdAt > 0 && (
                            <>
                              <span>·</span>
                              <span>{formatRelativeTime(conn.createdAt)}</span>
                            </>
                          )}
                          {conn.sameAuthor && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 font-medium ml-1">
                              same author
                            </span>
                          )}
                        </div>
                        <p className="text-sm leading-relaxed break-words mt-2">
                          <HighlightedText
                            text={conn.text}
                            entities={conn.entities}
                            activeCluster={activeCluster}
                            onClusterClick={toggleCluster}
                          />
                        </p>
                        {conn.reasoning && (
                          <div className="mt-2">
                            <p className={cn(
                              'text-[10px] font-medium uppercase tracking-wider mb-0.5',
                              conn.confidence === 'high' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
                            )}>
                              {conn.confidence === 'high' ? 'High confidence' : 'Needs review'}
                            </p>
                            <p className="text-[11px] text-muted-foreground">{conn.reasoning}</p>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <Telescope className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Explore connections coming soon</p>
              </div>
            )}
          </div>

          {/* Bottom actions */}
          {alert.status === 'pending' && (
            <div className="shrink-0 border-t px-3 py-2.5 flex items-center gap-2">
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => handleAction('dismissed')}
                  disabled={acting}
                  className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                >
                  Dismiss
                </button>
                <button
                  onClick={() => handleAction('resolved')}
                  disabled={acting}
                  className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-emerald-600/40 text-emerald-600 hover:bg-emerald-600/10 dark:text-emerald-400 dark:border-emerald-400/40 dark:hover:bg-emerald-400/10 transition-colors disabled:opacity-50"
                >
                  Resolve
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
