import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, Send, RefreshCw, Check, Loader2, ExternalLink } from 'lucide-react'
import { composeAlertPost, publishAlertPost, type ComposeDraft } from '../lib/api'
import { ChatInput } from './chat/chat-input'
import { cn, formatRelativeTime } from '../lib/utils'

export interface PublishedSnapshot {
  title: string
  body: string
  permalink?: string
  publishedAt?: number
  publishedBy?: string
}

interface ComposeViewProps {
  alertId: string
  subredditName?: string
  published?: PublishedSnapshot
  onBack: () => void
  onPublished: () => void
}

export function ComposeView({ alertId, subredditName, published, onBack, onPublished }: ComposeViewProps) {
  if (published) {
    return (
      <PublishedView
        title={published.title}
        body={published.body}
        permalink={published.permalink}
        publishedAt={published.publishedAt}
        publishedBy={published.publishedBy}
        subredditName={subredditName}
      />
    )
  }
  return <ComposeEditor alertId={alertId} subredditName={subredditName} onBack={onBack} onPublished={onPublished} />
}

function PublishedView({ title, body, permalink, publishedAt, publishedBy, subredditName }: PublishedSnapshot & { subredditName?: string }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Community update
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">
        Posted{subredditName ? ` to r/${subredditName}` : ''}.
      </p>

      <p className="mt-5 text-base font-semibold leading-snug break-words">{title}</p>

      <div className="mt-3 border-t border-border" />

      <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap break-words">{body}</p>

      <div className="mt-8 rounded-lg border">
        <div className="h-9 px-3 flex items-center border-b">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Posted</span>
        </div>
        <div className="p-3 flex flex-col gap-1">
          {permalink ? (
            <a
              href={`https://reddit.com${permalink}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm break-all hover:underline inline-flex items-baseline gap-1.5"
            >
              <span className="break-all">reddit.com{permalink}</span>
              <ExternalLink className="size-3 shrink-0 self-center text-muted-foreground" />
            </a>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Published{publishedBy ? ` by u/${publishedBy}` : ''}
            {publishedAt ? ` · ${formatRelativeTime(publishedAt)}` : ''}
          </p>
        </div>
      </div>
    </div>
  )
}

interface ComposeEditorProps {
  alertId: string
  subredditName?: string
  onBack: () => void
  onPublished: () => void
}

function ComposeEditor({ alertId, subredditName, onBack, onPublished }: ComposeEditorProps) {
  const [draft, setDraft] = useState<ComposeDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [refineInput, setRefineInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [publishConfirm, setPublishConfirm] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const resizeTextarea = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    composeAlertPost(alertId).then(res => {
      if (cancelled) return
      if ('error' in res) setError(res.error)
      else setDraft(res)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [alertId])

  useEffect(() => { resizeTextarea(titleRef.current) }, [draft?.title])
  useEffect(() => { resizeTextarea(bodyRef.current) }, [draft?.body])

  const regenerate = async (refinementPrompt?: string) => {
    if (!draft && !refinementPrompt) return
    setRegenerating(true)
    setError(null)
    const res = await composeAlertPost(alertId, {
      ...(refinementPrompt && { refinementPrompt }),
      ...(draft && { currentDraft: draft }),
    })
    if ('error' in res) setError(res.error)
    else setDraft(res)
    setRegenerating(false)
  }

  const handleRefineSubmit = async () => {
    const prompt = refineInput.trim()
    if (!prompt) return
    setRefineInput('')
    await regenerate(prompt)
  }

  const handleCopy = async () => {
    if (!draft) return
    try {
      await navigator.clipboard.writeText(`${draft.title}\n\n${draft.body}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const handlePublishConfirm = async () => {
    if (!draft) return
    setPublishing(true)
    setError(null)
    const res = await publishAlertPost(alertId, draft)
    setPublishing(false)
    if ('error' in res && res.error) {
      setError(res.error)
      setPublishConfirm(false)
      return
    }
    onPublished()
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-xs">
        <Loader2 className="size-4 animate-spin mr-2" />
        Drafting your update…
      </div>
    )
  }

  if (publishConfirm) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-4 px-6">
        <div className="text-muted-foreground"><Send className="size-5" /></div>
        <div className="max-w-md">
          <p className="text-sm font-medium">Publish to r/{subredditName ?? 'this subreddit'}?</p>
          <p className="text-xs text-muted-foreground mt-2">
            This submits a new post under your account. Cancel to keep editing — the draft is preserved.
          </p>
        </div>
        {error && <p className="text-xs text-destructive max-w-md">{error}</p>}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => setPublishConfirm(false)}
            disabled={publishing}
            className="h-7 px-3 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handlePublishConfirm}
            disabled={publishing}
            className="h-7 px-3 text-xs rounded-md cursor-pointer border border-foreground/30 text-foreground hover:bg-foreground/5 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {publishing ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
            {publishing ? 'Publishing…' : `Publish to r/${subredditName ?? 'subreddit'}`}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Community update
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          One post for r/{subredditName ?? 'the community'} from the anchor and its connections.
        </p>

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <textarea
          ref={titleRef}
          value={draft?.title ?? ''}
          onChange={e => {
            setDraft(d => d ? { ...d, title: e.target.value } : d)
            resizeTextarea(e.currentTarget)
          }}
          placeholder="Title"
          rows={1}
          disabled={regenerating}
          className="mt-5 w-full resize-none bg-transparent text-base font-semibold leading-snug outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />

        <div className="mt-3 border-t border-border" />

        <textarea
          ref={bodyRef}
          value={draft?.body ?? ''}
          onChange={e => {
            setDraft(d => d ? { ...d, body: e.target.value } : d)
            resizeTextarea(e.currentTarget)
          }}
          placeholder="Body"
          rows={6}
          disabled={regenerating}
          className="mt-3 w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground whitespace-pre-wrap disabled:opacity-50"
        />

        <div className="mt-3 border-t border-border" />

        <div className="mt-1">
          <ChatInput
            value={refineInput}
            onChange={setRefineInput}
            onSubmit={handleRefineSubmit}
            disabled={regenerating}
            streaming={regenerating}
            placeholder="Refine: shorten it, soften the tone…"
          />
        </div>
      </div>

      <div className="shrink-0 border-t px-3 py-2.5 flex items-center gap-2">
        <button
          onClick={onBack}
          disabled={regenerating || publishing}
          className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="size-3" />
          Back
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => regenerate()}
            disabled={regenerating || !draft}
            className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw className={cn('size-3', regenerating && 'animate-spin')} />
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
          <button
            onClick={handleCopy}
            disabled={!draft}
            className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={() => setPublishConfirm(true)}
            disabled={regenerating || !draft || !draft.title.trim() || !draft.body.trim()}
            className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-emerald-600/40 text-emerald-600 hover:bg-emerald-600/10 dark:text-emerald-400 dark:border-emerald-400/40 dark:hover:bg-emerald-400/10 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Send className="size-3" />
            Publish
          </button>
        </div>
      </div>
    </>
  )
}
