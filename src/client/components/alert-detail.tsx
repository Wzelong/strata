import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { ArrowLeft, ClipboardList, Telescope, Sparkles, ChevronDown, ChevronUp, Trash2, Check, Lock, Ban, Stamp, Loader2, Copy, RefreshCw, ExternalLink, SquarePen, Megaphone } from 'lucide-react'
import { fetchAlertDetail, alertAction, fetchPostDetail, publishAlertPost, removeItem, approveItem, bulkRemoveAlert, bulkLockAlert, composeAlertPost, type AlertDetail, type AlertConnectionWithDecision, type PostDetail, type ClusterDetail, type ComposeDraft } from '../lib/api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Decision } from '../../engine/types'
import { useViewer } from '../hooks/use-viewer'
import { buildClusterColorMap } from '../lib/graph-utils'
import { useTheme } from '../hooks/use-theme'
import { ChatPanel } from './chat-panel'
import { ChatInput } from './chat/chat-input'
import type { ChatContext, ToolSideEffect } from '../types/chat'
import { HighlightedText } from './highlighted-text'
import { cn, formatRelativeTime, compactCount, openUrl } from '../lib/utils'

const GraphCanvas = lazy(() => import('./graph/graph-canvas').then(m => ({ default: m.GraphCanvas })))
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'

type DetailTab = 'overview' | 'explore' | 'chat'

function pendingBrigadeCount(alert: AlertDetail): number {
  let n = 0
  if ((alert.anchorDecision ?? 'pending') === 'pending') n++
  for (const c of alert.connections) if ((c.decision ?? 'pending') === 'pending') n++
  return n
}

interface BrigadeCardProps {
  id: string
  author: string
  text: string
  title?: string
  createdAt: number
  permalink?: string
  decision?: Decision
  isAnchor: boolean
  rowConfirm: { id: string; action: 'remove' | 'approve' } | null
  rowActing: string | null
  onTrigger: (action: 'remove' | 'approve') => void
  onConfirm: () => void
  onCancel: () => void
}

function BrigadeCard({ id, author, text, title, createdAt, permalink, decision, isAnchor, rowConfirm, rowActing, onTrigger, onConfirm, onCancel }: BrigadeCardProps) {
  const effectiveDecision: Decision = decision ?? 'pending'
  const isConfirming = rowConfirm?.id === id
  const isActing = rowActing === id
  const isRemoved = effectiveDecision === 'removed'

  if (isConfirming) {
    const action = rowConfirm!.action
    const verb = action === 'remove' ? 'Remove' : 'Approve'
    const detail = action === 'remove'
      ? `This will remove the comment by u/${author} from Reddit. Any mod can approve it back later.`
      : `This will approve the comment by u/${author} on Reddit and mark it as not part of the brigade.`
    return (
      <div className="rounded-md border border-border px-3 py-3">
        <p className="text-sm font-medium">{verb} this comment?</p>
        <p className="text-xs text-muted-foreground mt-1">{detail}</p>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={onCancel}
            disabled={isActing}
            className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isActing}
            className={cn(
              'h-7 px-2.5 text-xs rounded-md cursor-pointer transition-colors disabled:opacity-50',
              action === 'remove'
                ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
                : 'border border-emerald-600/40 text-emerald-600 hover:bg-emerald-600/10 dark:text-emerald-400 dark:border-emerald-400/40 dark:hover:bg-emerald-400/10',
            )}
          >
            {isActing ? `${verb}ing…` : `Confirm ${verb.toLowerCase()}`}
          </button>
        </div>
      </div>
    )
  }

  const titleText = title ? `Comment on "${title}"` : 'Comment'

  return (
    <div className={cn('rounded-md border border-border px-3 py-2.5 relative', isRemoved && 'opacity-60')}>
      <div className="absolute top-2.5 right-3 flex items-center gap-1.5">
        {isAnchor && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
            Anchor
          </span>
        )}
        {effectiveDecision === 'removed' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 inline-flex items-center gap-1">
            <Ban className="size-2.5" />
            Removed
          </span>
        )}
        {effectiveDecision === 'approved' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 inline-flex items-center gap-1">
            <Check className="size-2.5" />
            Approved
          </span>
        )}
      </div>
      {permalink ? (
        <a href={`https://reddit.com${permalink}`} target="_blank" rel="noopener noreferrer" className="text-sm font-medium break-words line-clamp-2 hover:underline block pr-24">
          {titleText}
        </a>
      ) : (
        <p className="text-sm font-medium break-words line-clamp-2 pr-24">{titleText}</p>
      )}
      <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground">
        <a href={`https://reddit.com/u/${author}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
          u/{author}
        </a>
        {createdAt > 0 && (
          <>
            <span>·</span>
            <span>{formatRelativeTime(createdAt)}</span>
          </>
        )}
      </div>
      <p className={cn('text-sm leading-relaxed break-words mt-2 whitespace-pre-wrap', isRemoved && 'line-through')}>
        {text}
      </p>
      {effectiveDecision === 'pending' && (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => onTrigger('remove')}
            className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors"
          >
            Remove
          </button>
          <button
            onClick={() => onTrigger('approve')}
            className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-emerald-600 hover:border-emerald-600/40 dark:hover:text-emerald-400 dark:hover:border-emerald-400/40 transition-colors"
          >
            Approve
          </button>
        </div>
      )}
    </div>
  )
}

interface BulkConfirmViewProps {
  kind: 'remove-all' | 'lock' | 'dismiss' | 'confirm'
  pendingCount: number
  acting: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

function BulkConfirmView({ kind, pendingCount, acting, error, onConfirm, onCancel }: BulkConfirmViewProps) {
  const config = kind === 'remove-all'
    ? {
        icon: <Trash2 className="size-5" />,
        title: `Remove ${pendingCount} pending comment${pendingCount === 1 ? '' : 's'}?`,
        detail: 'Each pending comment in this brigade will be removed from Reddit. Comments already approved or removed are left alone. The alert will be marked resolved.',
        confirmLabel: 'Remove all',
        actingLabel: 'Removing…',
        tone: 'destructive' as const,
      }
    : kind === 'lock'
    ? {
        icon: <Lock className="size-5" />,
        title: 'Lock this thread?',
        detail: 'No new comments can be posted until a moderator unlocks the thread. Existing comments stay visible. The alert will be marked resolved.',
        confirmLabel: 'Lock thread',
        actingLabel: 'Locking…',
        tone: 'neutral' as const,
      }
    : kind === 'confirm'
    ? {
        icon: <Stamp className="size-5" />,
        title: 'Confirm this surface?',
        detail: 'Marks this surface as resolved and creates a community post draft for moderator review.',
        confirmLabel: 'Confirm',
        actingLabel: 'Generating…',
        tone: 'positive' as const,
      }
    : {
        icon: <ClipboardList className="size-5" />,
        title: 'Dismiss this alert?',
        detail: 'Marks it as a false positive and closes the alert. No Reddit action will be taken.',
        confirmLabel: 'Dismiss',
        actingLabel: 'Dismissing…',
        tone: 'neutral' as const,
      }

  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-4 px-6">
      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">{config.icon}</div>
      <div className="max-w-md">
        <p className="text-sm font-medium">{config.title}</p>
        <p className="text-xs text-muted-foreground mt-2">{config.detail}</p>
        {error && <p className="text-xs text-destructive mt-2">{error}</p>}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={onCancel}
          disabled={acting}
          className="h-7 px-3 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={acting || (kind === 'remove-all' && pendingCount === 0)}
          className={cn(
            'h-7 px-3 text-xs rounded-md cursor-pointer transition-colors disabled:opacity-50 inline-flex items-center gap-1.5',
            config.tone === 'destructive'
              ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
              : config.tone === 'positive'
              ? 'border border-emerald-600/40 text-emerald-600 hover:bg-emerald-600/10 dark:text-emerald-400 dark:border-emerald-400/40 dark:hover:bg-emerald-400/10'
              : 'border border-border text-foreground hover:bg-muted',
          )}
        >
          {acting && kind === 'confirm' && <Loader2 className="size-3 animate-spin" />}
          {acting ? (config.actingLabel ?? `${config.confirmLabel}…`) : config.confirmLabel}
        </button>
      </div>
    </div>
  )
}

function formatDateTime(timestamp?: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function reviewedAt(alert: AlertDetail): number {
  return alert.statusUpdatedAt ?? alert.publishedAt ?? alert.createdAt
}

const markdownComponents = {
  p: (props: any) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
  ul: (props: any) => <ul className="mb-2 last:mb-0 ml-5 list-disc space-y-1" {...props} />,
  ol: (props: any) => <ol className="mb-2 last:mb-0 ml-5 list-decimal space-y-1" {...props} />,
  a: (props: any) => <a className="text-foreground underline underline-offset-2 hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
  code: (props: any) => <code className="rounded bg-muted px-1 py-0.5 text-[0.85em] font-mono" {...props} />,
  blockquote: (props: any) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" {...props} />,
  hr: () => <hr className="my-3 border-border" />,
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="text-sm break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown>
    </div>
  )
}

function SurfaceDraftCard({
  alertId,
  subredditName,
  draft,
  published,
  onDraftChange,
  onPublished,
}: {
  alertId: string
  subredditName?: string
  draft: ComposeDraft | null
  published?: { title: string; body: string; permalink?: string; publishedAt?: number; publishedBy?: string }
  onDraftChange: (draft: ComposeDraft) => void
  onPublished?: () => void
}) {
  const [regenerating, setRegenerating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refinement, setRefinement] = useState('')

  const handleRegenerate = async (refinementPrompt?: string) => {
    if (!draft) return
    setRegenerating(true)
    setError(null)
    try {
      const res = await composeAlertPost(alertId, { currentDraft: draft, refinementPrompt })
      if ('error' in res) {
        setError(res.error)
      } else {
        onDraftChange(res)
        if (refinementPrompt) setRefinement('')
      }
    } finally {
      setRegenerating(false)
    }
  }

  const handleRefine = () => {
    const prompt = refinement.trim()
    if (!prompt) return
    handleRegenerate(prompt)
  }

  const handleCopy = async () => {
    if (!draft && !published) return
    const title = published?.title ?? draft?.title ?? ''
    const body = published?.body ?? draft?.body ?? ''
    try {
      await navigator.clipboard.writeText(`${title}\n\n${body}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const submitUrl = (title: string, body: string) => {
    const base = subredditName ? `https://www.reddit.com/r/${subredditName}/submit` : 'https://www.reddit.com/submit'
    const params = new URLSearchParams({ title, selftext: 'true', text: body })
    return `${base}?${params.toString()}`
  }

  if (published) {
    return (
      <div className="mt-6 rounded-lg border overflow-hidden">
        <div className="h-11 px-3 flex items-center gap-2 border-b">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Community Post</span>
          <div className="flex-1" />
          <button
            onClick={handleCopy}
            className="h-7 w-7 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Copy published post"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
        <div className="p-3">
          <p className="text-base font-semibold leading-snug break-words">{published.title}</p>
          <div className="mt-3">
            <MarkdownBody text={published.body} />
          </div>
          <div className="mt-4 border-t pt-3 flex flex-col gap-1">
            {published.permalink && (
              <a href={`https://reddit.com${published.permalink}`} target="_blank" rel="noopener noreferrer" className="text-sm break-all hover:underline inline-flex items-baseline gap-1.5">
                <span className="break-all">reddit.com{published.permalink}</span>
                <ExternalLink className="size-3 shrink-0 self-center text-muted-foreground" />
              </a>
            )}
            <p className="text-[11px] text-muted-foreground">
              Published{published.publishedBy ? ` by u/${published.publishedBy}` : ''}
              {published.publishedAt ? ` · ${formatRelativeTime(published.publishedAt)}` : ''}
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (!draft) return null

  const canSubmit = draft.title.trim().length > 0 && draft.body.trim().length > 0

  return (
    <div className="mt-6 rounded-lg border overflow-hidden">
      <div className="h-11 px-3 flex items-center gap-2 border-b">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Community Draft</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => handleRegenerate()}
            disabled={regenerating}
            className="h-7 w-7 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
            aria-label="Regenerate draft"
          >
            <RefreshCw className={cn('size-3.5', regenerating && 'animate-spin')} />
          </button>
          <button
            onClick={handleCopy}
            className="h-7 w-7 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Copy draft"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => { if (canSubmit) openUrl(submitUrl(draft.title.trim(), draft.body)) }}
                className={cn(
                  'hidden sm:inline-flex h-7 w-7 items-center justify-center rounded cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                  !canSubmit && 'opacity-50 cursor-not-allowed',
                )}
                aria-label="Open in post editor"
              >
                <SquarePen className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Open in post editor</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!canSubmit || publishing}
                onClick={async () => {
                  if (!canSubmit || publishing) return
                  setPublishing(true)
                  setError(null)
                  const res = await publishAlertPost(alertId, { title: draft.title.trim(), body: draft.body })
                  setPublishing(false)
                  if ('error' in res && res.error) { setError(res.error); return }
                  onPublished?.()
                }}
                className={cn(
                  'h-7 w-7 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                  (!canSubmit || publishing) && 'opacity-50 cursor-not-allowed',
                )}
                aria-label="Publish directly"
              >
                {publishing ? <Loader2 className="size-3.5 animate-spin" /> : <Megaphone className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Publish directly</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="p-3">
        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
        <p className="text-base font-semibold leading-snug break-words mb-3">{draft.title}</p>
        <MarkdownBody text={draft.body} />
      </div>
      <div className="px-3 pb-3 pt-1">
        <ChatInput
          value={refinement}
          onChange={setRefinement}
          onSubmit={handleRefine}
          streaming={regenerating}
          placeholder="Refine draft..."
        />
      </div>
    </div>
  )
}

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
  alertData?: import('../lib/api').AlertListItem | null
  itemId?: string | null
  itemData?: import('../lib/api').ItemListItem | null
  clusterId?: string | null
  clusterData?: import('../lib/api').ClusterListItem | null
  listTab?: 'alerts' | 'items' | 'clusters'
  requestedTab?: DetailTab | null
  onTabConsumed?: () => void
  embedded?: boolean
  forcedTab?: DetailTab
  highlightRequest?: { ids: string[]; version: number } | null
  chatContext?: ChatContext
  onBack: () => void
  onStatusChange: () => void
  onGraphNodeSelect?: (nodeId: string) => void
  onAgentSideEffect?: (effect: ToolSideEffect, source: 'right-pane' | 'detail-tab') => void
}

export function AlertDetailPanel({ alertId, alertData, itemId, itemData, clusterId, clusterData, listTab, requestedTab, onTabConsumed, embedded, forcedTab, highlightRequest, chatContext, onBack, onStatusChange, onGraphNodeSelect, onAgentSideEffect }: AlertDetailPanelProps) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [alert, setAlert] = useState<AlertDetail | null>(null)
  const [postDetail, setPostDetail] = useState<PostDetail | null>(null)
  const [clusterDetail, setClusterDetail] = useState<ClusterDetail | null>(null)
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null)
  const [threadCache, setThreadCache] = useState<Map<string, PostDetail>>(new Map())
  const [rowConfirm, setRowConfirm] = useState<{ id: string; action: 'remove' | 'approve' } | null>(null)
  const [rowActing, setRowActing] = useState<string | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState<'remove-all' | 'lock' | 'dismiss' | 'confirm' | null>(null)
  const [bulkActing, setBulkActing] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [surfaceDraft, setSurfaceDraft] = useState<ComposeDraft | null>(null)
  const [detailTabState, setDetailTab] = useState<DetailTab>('overview')
  const detailTab = embedded ? (forcedTab ?? 'overview') : detailTabState
  const { subredditName } = useViewer()

  useEffect(() => {
    if (requestedTab) {
      setDetailTab(requestedTab)
      onTabConsumed?.()
    }
  }, [requestedTab, onTabConsumed])
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
    if (!alertId || !alertData) { setAlert(null); return }
    setAlert({
      ...alertData,
      connections: alertData.connections ?? [],
      anchorDecision: alertData.anchorDecision,
    })
  }, [alertId, alertData])

  useEffect(() => {
    setRowConfirm(null)
    setRowActing(null)
    setBulkConfirm(null)
    setBulkActing(false)
    setConfirmError(null)
    setSurfaceDraft(null)
  }, [alertId])

  const isBrigade = alert?.mode === 'flag' && alert?.flagType === 'brigade'

  useEffect(() => {
    if (alertId || !itemId || !itemData) { setPostDetail(null); return }
    setPostDetail({
      post: {
        id: itemData.id,
        title: itemData.title ?? null,
        text: itemData.text,
        author: itemData.authorName,
        createdAt: itemData.createdAt,
        entities: itemData.entities ?? [],
        clusterLabel: itemData.clusterLabel ?? null,
        replyCount: itemData.commentCount ?? 0,
        permalink: itemData.permalink,
      },
      comments: (itemData.comments ?? []).map(c => ({
        id: c.id,
        text: c.text,
        author: c.author,
        createdAt: c.createdAt,
        entities: c.entities ?? [],
        clusterLabel: c.clusterLabel ?? null,
      })),
    })
  }, [itemId, alertId, itemData])

  useEffect(() => {
    if (!clusterId || !clusterData) { setClusterDetail(null); return }
    setExpandedPostId(null)
    setClusterDetail({
      id: clusterData.id,
      label: clusterData.label,
      isOrphan: clusterData.isOrphan,
      postCount: clusterData.postCount,
      commentCount: clusterData.commentCount,
      recentCount: clusterData.recentCount,
      lastActivity: clusterData.lastActivity,
      posts: (clusterData.posts ?? []).map(p => ({
        id: p.id,
        title: p.title,
        text: p.text,
        author: p.author,
        createdAt: p.createdAt,
        commentCount: p.commentCount,
        permalink: p.permalink,
      })),
    })
  }, [clusterId, clusterData])

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

  const handleRowConfirm = async () => {
    if (!rowConfirm || !alertId) return
    setRowActing(rowConfirm.id)
    try {
      if (rowConfirm.action === 'remove') await removeItem(rowConfirm.id)
      else await approveItem(rowConfirm.id)
      const fresh = await fetchAlertDetail(alertId)
      setAlert(fresh)
    } finally {
      setRowActing(null)
      setRowConfirm(null)
    }
  }

  const handleBulkConfirm = async () => {
    if (!bulkConfirm || !alertId) return
    setBulkActing(true)
    setConfirmError(null)
    try {
      if (bulkConfirm === 'confirm') {
        const draft = await composeAlertPost(alertId)
        if ('error' in draft) {
          setConfirmError(draft.error)
          return
        }
        await alertAction(alertId, 'resolved')
        const fresh = await fetchAlertDetail(alertId)
        setAlert(fresh)
        setSurfaceDraft(draft)
        setBulkConfirm(null)
        onStatusChange()
        return
      }

      if (bulkConfirm === 'remove-all') await bulkRemoveAlert(alertId)
      else if (bulkConfirm === 'lock') await bulkLockAlert(alertId)
      else if (bulkConfirm === 'dismiss') await alertAction(alertId, 'dismissed')
      setBulkConfirm(null)
      onStatusChange()
      onBack()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setConfirmError(message)
    } finally {
      setBulkActing(false)
    }
  }

  const tabs: Array<{ value: DetailTab; label: string; icon: React.ReactNode; hideOnXl?: boolean }> = [
    { value: 'overview', label: 'Overview', icon: <ClipboardList className="size-3.5" /> },
    { value: 'explore', label: 'Explore', icon: <Telescope className="size-3.5" /> },
    { value: 'chat', label: 'AI Chat', icon: <Sparkles className="size-3.5" />, hideOnXl: true },
  ]

  const detailTitle = alert
    ? (alert.anchorTitle || alert.anchorText.slice(0, 80))
    : clusterDetail
      ? clusterDetail.label
      : postDetail
        ? (postDetail.post.title || postDetail.post.text.slice(0, 80))
        : detailTab === 'explore' ? 'Explore' : detailTab === 'chat' ? 'Chat' : ''
  const publishedDraft = alert?.publishedPostId ? {
    title: alert.publishedPostTitle ?? '',
    body: alert.publishedPostBody ?? '',
    permalink: alert.publishedPostPermalink,
    publishedAt: alert.publishedAt,
    publishedBy: alert.publishedBy,
  } : undefined
  const storedDraft: ComposeDraft | null = alert?.draftPostTitle || alert?.draftPostBody
    ? { title: alert.draftPostTitle ?? '', body: alert.draftPostBody ?? '' }
    : null
  const activeDraft = surfaceDraft ?? storedDraft

  return (
    <div className="flex flex-col h-full min-w-0 flex-1 overflow-hidden">
      {/* Header */}
      {!embedded && (
      <div className="h-10 pl-3 pr-[6px] border-b flex items-center justify-between shrink-0 gap-2">
        <div className="flex-1 flex items-center gap-1.5 min-w-0">
          <ArrowLeft
            className="size-3.5 cursor-pointer text-muted-foreground hover:text-foreground transition-colors shrink-0 lg:hidden"
            onClick={onBack}
          />
          {alert && alert.status === 'pending' && (
            <span className={cn(
              'hidden sm:inline text-[10px] font-medium uppercase tracking-wider shrink-0',
              alert.confidence === 'high' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
            )}>
              {alert.confidence === 'high' ? 'High confidence' : 'Needs review'}
            </span>
          )}
          {alert && alert.status !== 'pending' && (
            <span
              className="hidden sm:inline text-[10px] font-medium shrink-0 text-muted-foreground tabular-nums"
              title={formatDateTime(reviewedAt(alert))}
            >
              <span className="uppercase tracking-wider">{alert.status === 'resolved' ? 'Resolved' : 'Dismissed'}</span> · {formatRelativeTime(reviewedAt(alert))}
            </span>
          )}
          <span className="text-sm font-medium truncate flex-1 min-w-0 lg:hidden">
            {detailTitle}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {tabs.map(t => (
            <button
              key={t.value}
              className={cn(
                'cursor-pointer h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors',
                detailTab === t.value
                  ? 'bg-accent text-foreground'
                  : 'hover:bg-accent text-muted-foreground hover:text-foreground',
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
      )}

      {/* Body */}
      <>
          <div className={cn('flex-1 min-h-0 flex', detailTab !== 'explore' && 'hidden')}>
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Loading graph...</div>}>
              <GraphCanvas
                highlightIds={alert ? [alert.anchorId, ...alert.connections.map(c => c.itemId)] : clusterId ? (clusterDetail?.posts.map(p => p.id) ?? undefined) : (itemId ? [itemId] : undefined)}
                threadAnchorId={!alert && !clusterId && itemId ? itemId : undefined}
                hideCard={!!clusterId}
                onReset={alert || itemId || clusterId ? onBack : undefined}
                onNodeSelect={onGraphNodeSelect}
                highlightRequest={highlightRequest}
              />
            </Suspense>
          </div>

          {detailTab !== 'explore' && (
          <div ref={scrollContainerRef} className={cn('flex-1 min-h-0', detailTab === 'overview' && (alert || postDetail || clusterDetail) ? 'overflow-y-auto px-3 pt-3 pb-4' : 'flex')}>
            {detailTab === 'chat' ? (
              <ChatPanel surface="detail-tab" context={chatContext} onAgentSideEffect={onAgentSideEffect} />
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
            ) : bulkConfirm ? (
              <BulkConfirmView
                kind={bulkConfirm}
                pendingCount={pendingBrigadeCount(alert)}
                acting={bulkActing}
                error={confirmError}
                onConfirm={handleBulkConfirm}
                onCancel={() => { setBulkConfirm(null); setConfirmError(null) }}
              />
            ) : isBrigade ? (
              <>
                {(() => {
                  const threadHref = alert.anchorPermalink
                    ? `https://reddit.com${alert.anchorPermalink.replace(/\/_\/[^/]+$/, '')}`
                    : null
                  const intro = alert.anchorTitle
                    ? `Coordinated activity on "${alert.anchorTitle}"`
                    : 'Coordinated activity on this thread'
                  return threadHref ? (
                    <a href={threadHref} target="_blank" rel="noopener noreferrer" className="text-base font-semibold break-words line-clamp-2 hover:underline block">
                      {intro}
                    </a>
                  ) : (
                    <p className="text-base font-semibold break-words line-clamp-2">{intro}</p>
                  )
                })()}
                {alert.reasoning && (
                  <p className="text-xs text-muted-foreground mt-1">{alert.reasoning}</p>
                )}
                <div className="flex flex-col gap-2 mt-4">
                  <BrigadeCard
                    id={alert.anchorId}
                    author={alert.anchorAuthor}
                    text={alert.anchorText}
                    title={alert.anchorTitle}
                    createdAt={alert.createdAt}
                    permalink={alert.anchorPermalink}
                    decision={alert.anchorDecision}
                    isAnchor
                    rowConfirm={rowConfirm}
                    rowActing={rowActing}
                    onTrigger={(action) => setRowConfirm({ id: alert.anchorId, action })}
                    onConfirm={handleRowConfirm}
                    onCancel={() => setRowConfirm(null)}
                  />
                  {alert.connections.map(conn => (
                    <BrigadeCard
                      key={conn.itemId}
                      id={conn.itemId}
                      author={conn.author}
                      text={conn.text}
                      title={conn.title}
                      createdAt={conn.createdAt}
                      permalink={conn.permalink}
                      decision={conn.decision}
                      isAnchor={false}
                      rowConfirm={rowConfirm}
                      rowActing={rowActing}
                      onTrigger={(action) => setRowConfirm({ id: conn.itemId, action })}
                      onConfirm={handleRowConfirm}
                      onCancel={() => setRowConfirm(null)}
                    />
                  ))}
                </div>
              </>
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

                {(activeDraft || publishedDraft) && (
                  <SurfaceDraftCard
                    alertId={alert.id}
                    subredditName={subredditName ?? undefined}
                    draft={activeDraft}
                    published={publishedDraft}
                    onDraftChange={setSurfaceDraft}
                    onPublished={async () => {
                      const fresh = await fetchAlertDetail(alert.id)
                      setAlert(fresh)
                      onStatusChange()
                    }}
                  />
                )}

              </>
            )}
          </div>
          )}

          {/* Bottom actions */}
          {alert && alert.status === 'pending' && detailTab === 'overview' && !bulkConfirm && isBrigade && (
            <div className="shrink-0 border-t h-[45px] px-3 flex items-center gap-2">
              <button
                onClick={() => setBulkConfirm('dismiss')}
                disabled={bulkActing}
                className="h-7 px-2.5 text-xs rounded-md cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
              >
                Dismiss
              </button>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => setBulkConfirm('lock')}
                  disabled={bulkActing}
                  className="h-7 px-2.5 text-xs rounded-md cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
                >
                  Lock thread
                </button>
                <button
                  onClick={() => setBulkConfirm('remove-all')}
                  disabled={bulkActing || pendingBrigadeCount(alert) === 0}
                  className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                >
                  Remove all
                </button>
              </div>
            </div>
          )}
          {alert && alert.status === 'pending' && detailTab === 'overview' && !bulkConfirm && !isBrigade && (
            <div className="shrink-0 border-t h-[45px] px-3 flex items-center gap-2">
              <button
                onClick={() => setBulkConfirm('dismiss')}
                disabled={bulkActing}
                className="h-7 px-2.5 text-xs rounded-md cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
              >
                Dismiss
              </button>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => setBulkConfirm('confirm')}
                  disabled={bulkActing}
                  className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-emerald-600/40 text-emerald-600 hover:bg-emerald-600/10 dark:text-emerald-400 dark:border-emerald-400/40 dark:hover:bg-emerald-400/10 transition-colors disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            </div>
          )}
        </>
    </div>
  )
}
