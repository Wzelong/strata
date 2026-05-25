import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { ArrowLeft, ClipboardList, Telescope, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import { fetchAlertDetail, alertAction, fetchPostDetail, fetchClusterDetail, type AlertDetail, type PostDetail, type ClusterDetail } from '../lib/api'
import { buildClusterColorMap } from '../lib/graph-utils'
import { useTheme } from '../hooks/use-theme'
import { ChatPanel } from './chat-panel'
import { HighlightedText } from './highlighted-text'
import { cn, formatRelativeTime, compactCount } from '../lib/utils'

const GraphCanvas = lazy(() => import('./graph/graph-canvas').then(m => ({ default: m.GraphCanvas })))
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'

type DetailTab = 'overview' | 'explore' | 'chat'

function EntityTags({ entities }: { entities: Array<{ text: string }> }) {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const e of entities) {
    if (!e?.text) continue
    const key = e.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(e.text)
    if (tags.length >= 8) break
  }
  if (tags.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {tags.map(t => (
        <span key={t} className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
          {t}
        </span>
      ))}
    </div>
  )
}

interface AlertDetailPanelProps {
  alertId: string | null
  itemId?: string | null
  clusterId?: string | null
  listTab?: 'alerts' | 'items' | 'clusters'
  onBack: () => void
  onStatusChange: () => void
  onGraphNodeSelect?: (nodeId: string) => void
}

export function AlertDetailPanel({ alertId, itemId, clusterId, listTab, onBack, onStatusChange, onGraphNodeSelect }: AlertDetailPanelProps) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [alert, setAlert] = useState<AlertDetail | null>(null)
  const [postDetail, setPostDetail] = useState<PostDetail | null>(null)
  const [clusterDetail, setClusterDetail] = useState<ClusterDetail | null>(null)
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null)
  const [threadCache, setThreadCache] = useState<Map<string, PostDetail>>(new Map())
  const [acting, setActing] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('explore')
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
    let cancelled = false
    fetchAlertDetail(alertId).then(d => { if (!cancelled) setAlert(d) })
    return () => { cancelled = true }
  }, [alertId])

  useEffect(() => {
    if (alertId || !itemId) { setPostDetail(null); return }
    let cancelled = false
    fetchPostDetail(itemId).then(d => { if (!cancelled && d) setPostDetail(d) })
    return () => { cancelled = true }
  }, [itemId, alertId])

  useEffect(() => {
    if (!clusterId) { setClusterDetail(null); return }
    setExpandedPostId(null)
    let cancelled = false
    fetchClusterDetail(clusterId).then(d => { if (!cancelled && d) setClusterDetail(d) })
    return () => { cancelled = true }
  }, [clusterId])

  useEffect(() => {
    if (!expandedPostId) return
    if (threadCache.has(expandedPostId)) return
    let cancelled = false
    fetchPostDetail(expandedPostId).then(d => {
      if (cancelled || !d) return
      setThreadCache(prev => {
        const next = new Map(prev)
        next.set(expandedPostId, d)
        return next
      })
    })
    return () => { cancelled = true }
  }, [expandedPostId, threadCache])

  const clusterDotColor = useMemo(() => {
    if (!clusterDetail) return null
    if (clusterDetail.isOrphan) return isDark ? '#94a3b8' : '#64748b'
    const map = buildClusterColorMap([{ cluster_label: clusterDetail.label } as never], isDark)
    return map.get(clusterDetail.label) ?? null
  }, [clusterDetail, isDark])

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
            <button
              key={t.value}
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
          ))}
        </div>
      </div>

      {/* Body */}
      <>
          <div ref={scrollContainerRef} className={cn('flex-1 min-h-0', detailTab === 'overview' && (alert || postDetail || clusterDetail) ? 'overflow-y-auto px-3 py-3' : 'flex')}>
            {detailTab === 'chat' ? (
              <ChatPanel />
            ) : detailTab === 'explore' ? (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading graph...</div>}>
                <GraphCanvas
                  highlightIds={alert ? [alert.anchorId, ...alert.connections.map(c => c.itemId)] : clusterId ? (clusterDetail?.posts.map(p => p.id) ?? undefined) : (itemId ? [itemId] : undefined)}
                  threadAnchorId={!alert && !clusterId && itemId ? itemId : undefined}
                  hideCard={!!clusterId}
                  onReset={alert || itemId || clusterId ? onBack : undefined}
                  onNodeSelect={onGraphNodeSelect}
                />
              </Suspense>
            ) : !alert && clusterDetail ? (
              <>
                <div className="flex items-center gap-2">
                  {clusterDotColor && (
                    <span className="size-2 rounded-full shrink-0" style={{ background: clusterDotColor }} />
                  )}
                  <p className="text-base font-semibold break-words line-clamp-2 flex-1 min-w-0">
                    {clusterDetail.label}
                  </p>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {compactCount(clusterDetail.postCount)} posts · {compactCount(clusterDetail.commentCount)} comments
                  {clusterDetail.recentCount > 0 && ` · ${compactCount(clusterDetail.recentCount)} in 24h`}
                  {clusterDetail.lastActivity > 0 && ` · ${formatRelativeTime(clusterDetail.lastActivity)}`}
                </div>
                <div className="flex flex-col gap-2 mt-6">
                  {clusterDetail.posts.map(p => {
                    const expanded = expandedPostId === p.id
                    const thread = expanded ? threadCache.get(p.id) : undefined
                    return (
                      <div key={p.id} className="rounded-md border border-border">
                        <div className="px-3 py-2.5">
                          {p.permalink ? (
                            <a href={`https://reddit.com${p.permalink}`} target="_blank" rel="noopener noreferrer" className="text-sm font-medium break-words hover:underline block">
                              {p.title || p.text.slice(0, 80)}
                            </a>
                          ) : (
                            <p className="text-sm font-medium break-words">
                              {p.title || p.text.slice(0, 80)}
                            </p>
                          )}
                          <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground">
                            <a href={`https://reddit.com/u/${p.author}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">u/{p.author}</a>
                            <span>·</span>
                            <span>{formatRelativeTime(p.createdAt)}</span>
                          </div>
                          {p.text && (
                            <p className="text-sm leading-relaxed break-words mt-2 whitespace-pre-wrap">{p.text}</p>
                          )}
                        </div>
                        {p.commentCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setExpandedPostId(expanded ? null : p.id)}
                            className="w-full flex items-center justify-between px-3 py-2 border-t border-border text-[11px] text-muted-foreground hover:bg-muted/40 cursor-pointer transition-colors"
                          >
                            <span>{compactCount(p.commentCount)} comments</span>
                            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                          </button>
                        )}
                        {expanded && (
                          <div className="px-3 pb-3 border-t border-border">
                            {!thread ? (
                              <p className="mt-3 text-[11px] text-muted-foreground">Loading...</p>
                            ) : thread.comments.length === 0 ? (
                              <p className="mt-3 text-[11px] text-muted-foreground">No comments</p>
                            ) : (
                              <div className="flex flex-col gap-2 mt-3">
                                {thread.comments.map(c => (
                                  <div key={c.id} className="rounded-md border border-border px-3 py-2.5">
                                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                      <span>u/{c.author}</span>
                                      <span>·</span>
                                      <span>{formatRelativeTime(c.createdAt)}</span>
                                    </div>
                                    <p className="text-sm leading-relaxed break-words mt-2 whitespace-pre-wrap">{c.text}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : !alert && postDetail ? (
              <>
                {postDetail.post.permalink ? (
                  <a href={`https://reddit.com${postDetail.post.permalink}`} target="_blank" rel="noopener noreferrer" className="text-base font-semibold break-words line-clamp-2 hover:underline block">
                    {postDetail.post.title || postDetail.post.text.slice(0, 80)}
                  </a>
                ) : (
                  <p className="text-base font-semibold break-words line-clamp-2">
                    {postDetail.post.title || postDetail.post.text.slice(0, 80)}
                  </p>
                )}
                <div className="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground">
                  <a href={`https://reddit.com/u/${postDetail.post.author}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
                    u/{postDetail.post.author}
                  </a>
                  <span>·</span>
                  <span>{formatRelativeTime(postDetail.post.createdAt)}</span>
                </div>
                <p className="text-sm leading-relaxed break-words mt-3 whitespace-pre-wrap">
                  {postDetail.post.text}
                </p>
                <EntityTags entities={postDetail.post.entities} />
                <div className="flex flex-col gap-2 mt-6">
                  {postDetail.comments.map(c => (
                    <div key={c.id} className="rounded-md border border-border px-3 py-2.5">
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <a href={`https://reddit.com/u/${c.author}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
                          u/{c.author}
                        </a>
                        <span>·</span>
                        <span>{formatRelativeTime(c.createdAt)}</span>
                      </div>
                      <p className="text-sm leading-relaxed break-words mt-2 whitespace-pre-wrap">
                        {c.text}
                      </p>
                      <EntityTags entities={c.entities} />
                    </div>
                  ))}
                </div>
              </>
            ) : !alert ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <ClipboardList className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {listTab === 'items' ? 'Select a post to review' : 'Select an alert to review'}
                </p>
              </div>
            ) : (
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
            )}
          </div>

          {/* Bottom actions */}
          {alert && alert.status === 'pending' && detailTab === 'overview' && (
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
    </div>
  )
}
