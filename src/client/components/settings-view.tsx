import { useState, useEffect } from 'react'
import { Check, X, Ban, Loader2, AlertTriangle, Plus, Telescope, RefreshCw, Bot } from 'lucide-react'
import { useBackfillHistory } from '../hooks/use-backfill-history.js'
import { useStats, refreshStats } from '../hooks/use-stats.js'
import { useIngestStatus, refreshIngestStatus } from '../hooks/use-ingest-status.js'
import { useScanStatus, refreshScanStatus } from '../hooks/use-scan-status.js'
import { useScanHistory } from '../hooks/use-scan-history.js'
import { OnboardingForm } from './onboarding-form.js'
import { BackfillCard } from './backfill-card.js'
import { ScanProgress } from './scan-progress.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { CancelBackfillDialog } from './cancel-backfill-dialog.js'
import {
  cancelBackfill, deleteAllItems, resetAllAlerts, resetStrata, fetchRules, reloadRules, startScan, fetchUsage,
  fetchCommunityContext, saveCommunityContext,
  fetchClusterStatus, fetchClusterConfig, saveClusterConfig, triggerRecluster,
  type BackfillRecord, type RuleSummary, type ScanRecord, type UsageSummary, type ClusterStatus, type ClusterConfig,
} from '../lib/api.js'
import { cn, formatBytes, formatRelativeTime, compactCount } from '../lib/utils.js'

const isDev = import.meta.env.DEV
const REDIS_CAP = 500 * 1024 * 1024
const ITEM_CAP = 330_000

interface Props {
  onBack?: () => void
  forceForm?: boolean
}

export function SettingsView({ onBack, forceForm }: Props) {
  const stats = useStats()
  const { history: bfHistory, refresh: refreshBfHistory } = useBackfillHistory()
  const { records: scanRecords, refresh: refreshScanHistory } = useScanHistory()
  const ingest = useIngestStatus()
  const scan = useScanStatus()
  const [showForm, setShowForm] = useState(forceForm ?? false)

  const isBackfillRunning = ingest && !['idle', 'done', 'error', 'cancelled'].includes(ingest.phase)
  const isScanRunning = scan && (scan.phase === 'building' || scan.phase === 'classifying')
  const runningBfRecord = bfHistory?.records.find(r => r.status === 'running') ?? null

  useEffect(() => {
    if (scan && ['done', 'error', 'cancelled'].includes(scan.phase)) refreshScanHistory()
  }, [scan?.phase])

  useEffect(() => {
    if (ingest && ['done', 'error', 'cancelled'].includes(ingest.phase)) refreshBfHistory()
  }, [ingest?.phase])

  const itemCount = stats?.itemCount ?? bfHistory?.currentItemCount ?? 0
  const bytes = bfHistory?.currentBytes ?? 0
  const itemPct = Math.min(100, (itemCount / ITEM_CAP) * 100)
  const bytePct = Math.min(100, (bytes / REDIS_CAP) * 100)

  const handleStarted = async () => {
    setShowForm(false)
    await Promise.all([refreshIngestStatus(), refreshStats(), refreshBfHistory()])
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Storage, pipeline runs, rules, and danger-zone actions.
            </p>
          </div>
          {onBack && (
            <button
              onClick={onBack}
              title="Close settings"
              className="cursor-pointer h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors -mt-0.5"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <Section title="Storage">
          <div className="space-y-3 rounded-lg border border-border p-4">
            <Gauge label="Items" value={`${compactCount(itemCount)} / ${compactCount(ITEM_CAP)}`} pct={itemPct} />
            <Gauge label="Redis" value={`${formatBytes(bytes)} / ${formatBytes(REDIS_CAP)}`} pct={bytePct} />
          </div>
        </Section>

        <Section title="Backfill">
          {isBackfillRunning ? (
            <BackfillCard />
          ) : showForm ? (
            <div className="rounded-lg border border-border p-6">
              <OnboardingForm onStarted={handleStarted} />
            </div>
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="cursor-pointer inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="size-3" />
              Start backfill
            </button>
          )}

          {bfHistory && bfHistory.records.filter(r => r.status !== 'running').length > 0 && (
            <div className="rounded-lg border border-border divide-y divide-border">
              {bfHistory.records.filter(r => r.status !== 'running').map(r => <BackfillHistoryRow key={r.id} record={r} onCancelled={refreshBfHistory} />)}
            </div>
          )}
        </Section>

        <Section title="Scan" id="settings-scan">
          <ScanProgress />
          {!isScanRunning && (
            <ScanRunRow
              onStarted={async () => {
                await Promise.all([refreshScanStatus(), refreshScanHistory()])
              }}
              disabled={itemCount === 0 || isBackfillRunning}
              disabledReason={itemCount === 0 ? 'No items to scan' : isBackfillRunning ? 'Backfill running' : undefined}
            />
          )}

          {scanRecords && scanRecords.filter(r => r.status !== 'running').length > 0 && (
            <div className="rounded-lg border border-border divide-y divide-border">
              {scanRecords.filter(r => r.status !== 'running').map(r => <ScanHistoryRow key={r.id} record={r} />)}
            </div>
          )}
        </Section>

        <RulesSection />

        <CommunityContextSection />

        <ClustersSection />

        <UsageSection />

        <DangerZone
          onChanged={async () => {
            await Promise.all([refreshStats(), refreshIngestStatus(), refreshScanStatus(), refreshBfHistory(), refreshScanHistory()])
            onBack?.()
          }}
        />

        {isDev && (
          <Section title="Dev controls">
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={async () => {
                  await fetch('/api/dev/reset-items', { method: 'POST' })
                  await Promise.all([refreshStats(), refreshIngestStatus(), refreshBfHistory()])
                }}
                className="cursor-pointer px-2 py-1 rounded-md border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              >
                Reset to empty
              </button>
              <button
                onClick={async () => {
                  await fetch('/api/dev/reseed', { method: 'POST' })
                  await Promise.all([refreshStats(), refreshBfHistory()])
                }}
                className="cursor-pointer px-2 py-1 rounded-md border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              >
                Reload seed
              </button>
              <span className="text-muted-foreground">Simulated backfill ≈ 28s · scan ≈ 24s.</span>
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

function formatCents(cents: number): string {
  if (cents <= 0) return '$0.00'
  if (cents < 1) return `$${(cents / 100).toFixed(4)}`
  return `$${(cents / 100).toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n < 1_000) return n.toString()
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function CommunityContextSection() {
  const [text, setText] = useState('')
  const [initial, setInitial] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    fetchCommunityContext().then(t => { setText(t); setInitial(t) })
  }, [])

  const dirty = text !== initial
  const handleSave = async () => {
    setSaving(true)
    try {
      await saveCommunityContext(text)
      setInitial(text)
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title="Community context">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Optional. A short note about your subreddit's tone, common topics, or local quirks. Strata appends this to its prompts so drafts and recommendations sound like your community.
        </p>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="e.g. Hyperlocal Cambridge MA sub. Common topics: traffic incidents, lost pets, local politics. Mods prefer concise updates without flowery language."
          className="w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-sm leading-relaxed outline-none focus:border-foreground/40 transition-colors"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {text.length}/2000
          </span>
          {savedAt && !dirty && (
            <span className="text-[11px] text-muted-foreground">Saved {formatRelativeTime(savedAt)}</span>
          )}
        </div>
      </div>
    </Section>
  )
}

function ClustersSection() {
  const [status, setStatus] = useState<ClusterStatus | null>(null)
  const [config, setConfig] = useState<ClusterConfig | null>(null)
  const [resolution, setResolution] = useState(0.5)
  const [minSize, setMinSize] = useState(10)
  const [reclustering, setReclustering] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const s = await fetchClusterStatus()
      setStatus(s)
    } catch {}
    try {
      const c = await fetchClusterConfig()
      if (c?.resolution != null) {
        setConfig(c)
        setResolution(c.resolution)
        setMinSize(c.minClusterSize)
      }
    } catch {}
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 10000)
    return () => clearInterval(id)
  }, [])

  const dirty = config !== null && (resolution !== config.resolution || minSize !== config.minClusterSize)

  const handleSave = async () => {
    setSavingConfig(true)
    try {
      const next = await saveClusterConfig({ resolution, minClusterSize: minSize })
      setConfig(next)
    } finally {
      setSavingConfig(false)
    }
  }

  const [success, setSuccess] = useState<string | null>(null)

  const handleRecluster = async () => {
    setReclustering(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await triggerRecluster()
      if ('error' in res) {
        setError(res.error)
      } else {
        await load()
        setSuccess(`Done — ${(res as any).clusters} clusters, ${(res as any).orphans} orphans, ${((res as any).elapsedMs / 1000).toFixed(1)}s`)
      }
    } finally {
      setReclustering(false)
    }
  }

  return (
    <Section title="Clusters">
      <div className="space-y-3">
        <div className="rounded-md border border-border">
          <div className="grid grid-cols-3 divide-x divide-border">
            <Stat label="Clusters" value={status ? String(status.clusters) : '—'} />
            <Stat label="Orphans" value={status ? String(status.orphans) : '—'} />
            <Stat label="Pending" value={status ? String(status.pendingItems) : '—'} />
          </div>
          <div className="border-t border-border px-3 py-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {status && status.lastRun > 0
                ? `Last run ${formatRelativeTime(status.lastRun)} · ${(status.elapsedMs / 1000).toFixed(1)}s · ${status.relabeled} relabeled`
                : 'No clustering run yet.'}
            </span>
            <button
              onClick={handleRecluster}
              disabled={reclustering}
              className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {reclustering ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {reclustering ? 'Running…' : 'Recluster now'}
            </button>
          </div>
          {error && <p className="border-t border-border px-3 py-2 text-xs text-destructive">{error}</p>}
          {success && <p className="border-t border-border px-3 py-2 text-xs text-emerald-500">{success}</p>}
        </div>

        <div className="rounded-md border border-border p-3 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium">Granularity</label>
              <span className="text-[11px] text-muted-foreground tabular-nums">{resolution.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.3}
              max={1.5}
              step={0.1}
              value={resolution}
              onChange={e => setResolution(parseFloat(e.target.value))}
              className="w-full accent-foreground"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
              <span>Broader topics</span>
              <span>More specific</span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium">Minimum cluster size</label>
              <span className="text-[11px] text-muted-foreground tabular-nums">{minSize}</span>
            </div>
            <input
              type="range"
              min={5}
              max={50}
              step={1}
              value={minSize}
              onChange={e => setMinSize(parseInt(e.target.value, 10))}
              className="w-full accent-foreground"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
              <span>5 items</span>
              <span>50 items</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!dirty || savingConfig}
              className="h-7 px-2.5 text-xs rounded-md cursor-pointer border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {savingConfig ? 'Saving…' : 'Save'}
            </button>
            <span className="text-[11px] text-muted-foreground">
              Applies on next recluster. Defaults: resolution {config?.defaults.resolution.toFixed(2) ?? '0.5'}, min size {config?.defaults.minClusterSize ?? 10}.
            </span>
          </div>
        </div>
      </div>
    </Section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3">
      <div className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function UsageSection() {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const load = async () => {
    setLoading(true)
    try { setUsage(await fetchUsage()) } catch { setUsage(null) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const rows = usage?.allTime ?? []
  const totals = usage?.totals

  return (
    <Section title="Usage">
      <div className="rounded-md border border-border">
        <div className="grid grid-cols-2 divide-x divide-border">
          <div className="p-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">This month</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{formatCents(totals?.month.costCents ?? 0)}</div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {formatTokens((totals?.month.inputTokens ?? 0) + (totals?.month.outputTokens ?? 0))} tokens · {totals?.month.calls ?? 0} calls
            </div>
          </div>
          <div className="p-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">All time</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{formatCents(totals?.allTime.costCents ?? 0)}</div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {formatTokens((totals?.allTime.inputTokens ?? 0) + (totals?.allTime.outputTokens ?? 0))} tokens · {totals?.allTime.calls ?? 0} calls
            </div>
          </div>
        </div>
        {rows.length > 0 && (
          <div className="border-t border-border">
            <div className="px-3 py-2 grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <span>Model</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Calls</span>
              <span className="text-right">Cost</span>
            </div>
            {rows.map(r => (
              <div key={r.model} className="px-3 py-2 grid grid-cols-[1fr_auto_auto_auto] gap-3 text-xs tabular-nums">
                <span className="font-mono text-muted-foreground truncate">{r.model}</span>
                <span className="text-right">{formatTokens(r.inputTokens + r.outputTokens)}</span>
                <span className="text-right">{r.calls}</span>
                <span className="text-right">{formatCents(r.costCents)}</span>
              </div>
            ))}
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="border-t border-border px-3 py-3 text-xs text-muted-foreground">No usage recorded yet.</div>
        )}
      </div>
    </Section>
  )
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-3">
      <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Gauge({ label, value, pct }: { label: string; value: string; pct: number }) {
  const tone = pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-amber-500' : 'bg-foreground'
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full transition-all duration-300', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function BackfillHistoryRow({ record, onCancelled }: { record: BackfillRecord; onCancelled: () => void }) {
  const duration = record.endedAt ? Math.round((record.endedAt - record.startedAt) / 1000) : null

  const icon = record.status === 'running'
    ? <Loader2 className="size-3.5 animate-spin" />
    : record.status === 'done'
      ? <Check className="size-3.5 text-green-500" />
      : record.status === 'cancelled'
        ? <Ban className="size-3.5 text-muted-foreground" />
        : <AlertTriangle className="size-3.5 text-destructive" />

  return (
    <div className="flex items-start gap-3 p-3">
      <span className="size-3.5 inline-flex items-center justify-center mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="text-sm">
          {record.from} – {record.to}
          <span className="text-muted-foreground ml-2 text-xs">
            {record.status === 'running'
              ? `${compactCount(record.processed)} / ${compactCount(record.totalItems)}`
              : `${compactCount(record.totalItems)} items`}
          </span>
        </div>
        <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span>{formatRelativeTime(record.startedAt)}</span>
          {duration !== null && <><span>·</span><span>{duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`}</span></>}
          {record.costUsdEstimated !== undefined && <><span>·</span><span>~ ${record.costUsdEstimated.toFixed(2)}</span></>}
          {record.initiatedBy && record.initiatedBy !== 'unknown' && <><span>·</span><span>{record.initiatedBy}</span></>}
          {record.error && <><span>·</span><span className="text-destructive">{record.error}</span></>}
        </div>
      </div>
      {record.status === 'running' && (
        <CancelBackfillDialog
          processed={record.processed}
          total={record.totalItems}
          onKeep={async () => { await cancelBackfill(record.id, 'keep'); onCancelled() }}
          onDiscard={async () => { await cancelBackfill(record.id, 'discard'); onCancelled() }}
        >
          <button
            className="cursor-pointer text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
          >
            Cancel
          </button>
        </CancelBackfillDialog>
      )}
    </div>
  )
}

function ScanRunRow({ onStarted, disabled, disabledReason }: { onStarted: () => Promise<void>; disabled: boolean; disabledReason?: string }) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handleStart = async () => {
    setStarting(true); setError(null)
    try {
      const res = await startScan()
      if ('error' in res) setError(res.error)
      else await onStarted()
    } catch (err) {
      setError(String(err))
    } finally {
      setStarting(false)
    }
  }
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleStart}
        disabled={disabled || starting}
        className={cn(
          'cursor-pointer inline-flex items-center gap-1.5 h-8 px-3 text-xs rounded-md font-medium transition-colors',
          disabled ? 'bg-muted text-muted-foreground cursor-not-allowed' : 'bg-foreground text-background hover:bg-foreground/90',
        )}
      >
        <Telescope className="size-3" />
        {starting ? 'Starting…' : 'Run scan'}
      </button>
      {disabledReason && <span className="text-xs text-muted-foreground">{disabledReason}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

function ScanHistoryRow({ record }: { record: ScanRecord }) {
  const duration = record.endedAt ? Math.round((record.endedAt - record.startedAt) / 1000) : null
  const icon = record.status === 'running'
    ? <Loader2 className="size-3.5 animate-spin" />
    : record.status === 'done'
      ? <Check className="size-3.5 text-green-500" />
      : record.status === 'cancelled'
        ? <Ban className="size-3.5 text-muted-foreground" />
        : <AlertTriangle className="size-3.5 text-destructive" />
  return (
    <div className="flex items-start gap-3 p-3">
      <span className="size-3.5 inline-flex items-center justify-center mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="text-sm">
          {record.anchorsTotal > 0
            ? `${compactCount(record.anchorsProcessed)} / ${compactCount(record.anchorsTotal)} anchors`
            : 'Scan'}
          <span className="text-muted-foreground ml-2 text-xs">
            {compactCount(record.alertsCreated)} alerts
          </span>
        </div>
        <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span>{formatRelativeTime(record.startedAt)}</span>
          {duration !== null && <><span>·</span><span>{duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`}</span></>}
          {record.autoTriggered && <><span>·</span><span className="inline-flex items-center gap-1"><Bot className="size-3" />auto</span></>}
          {!record.autoTriggered && record.initiatedBy && record.initiatedBy !== 'unknown' && <><span>·</span><span>{record.initiatedBy}</span></>}
          {record.error && <><span>·</span><span className="text-destructive">{record.error}</span></>}
        </div>
      </div>
    </div>
  )
}

function RulesSection() {
  const [rules, setRules] = useState<RuleSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetchRules()
      setRules(r)
    } catch {
      setRules([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleReload = async () => {
    setReloading(true); setMessage(null)
    try {
      const res = await reloadRules()
      if ('error' in res) setMessage(`Error: ${res.error}`)
      else setMessage(res.message ?? `Loaded ${res.count} rule${res.count === 1 ? '' : 's'}.`)
      await load()
    } catch (err) {
      setMessage(`Error: ${err}`)
    } finally {
      setReloading(false)
    }
  }

  return (
    <Section title="Rules">
      <div className="flex items-center gap-2">
        <button
          onClick={handleReload}
          disabled={reloading}
          className="cursor-pointer inline-flex items-center gap-1.5 h-8 px-3 text-xs rounded-md border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3', reloading && 'animate-spin')} />
          {reloading ? 'Reloading…' : 'Reload from subreddit'}
        </button>
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
      </div>
      {loading ? (
        <div className="text-xs text-muted-foreground py-3">Loading rules…</div>
      ) : !rules || rules.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border rounded-lg">
          No rules loaded. Click "Reload from subreddit" to import.
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {rules.map(r => (
            <div key={r.id} className="p-3 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground font-mono w-6">#{r.priority}</span>
                <span className="text-sm font-medium">{r.shortName}</span>
              </div>
              {r.description && (
                <p className="text-xs text-muted-foreground pl-8 leading-relaxed">{r.description}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function DangerZone({ onChanged }: { onChanged: () => Promise<void> }) {
  const [message, setMessage] = useState<string | null>(null)

  const cards: Array<{
    title: string
    subtitle: string
    actionLabel: string
    confirm: { title: string; description: string; actionLabel: string }
    run: () => Promise<string>
  }> = [
    {
      title: 'Delete all items',
      subtitle: 'Wipes items, embeddings, and entity index. Alerts referencing deleted items will dangle.',
      actionLabel: 'Delete',
      confirm: {
        title: 'Delete all items?',
        description: 'Wipes the entire item store, embeddings, and entity index. Alerts referencing deleted items will dangle. Cannot be undone.',
        actionLabel: 'Delete items',
      },
      run: async () => {
        const res = await deleteAllItems()
        return `Deleted ${compactCount(res.deleted)} items.`
      },
    },
    {
      title: 'Delete all alerts',
      subtitle: 'Deletes every alert and its connections. Item data is preserved.',
      actionLabel: 'Delete',
      confirm: {
        title: 'Delete all alerts?',
        description: 'Deletes every alert and its connections. Item data is preserved. Cannot be undone.',
        actionLabel: 'Delete alerts',
      },
      run: async () => {
        await resetAllAlerts()
        return 'Alerts deleted.'
      },
    },
    {
      title: 'Reset Strata',
      subtitle: 'Full reset: items, alerts, rules, scan, and backfill history are all wiped. Strata returns to its first-install state.',
      actionLabel: 'Reset',
      confirm: {
        title: 'Reset Strata?',
        description: 'Wipes everything: items, alerts, rules, backfill history, and scan history. Strata returns to its first-install state. Cannot be undone.',
        actionLabel: 'Reset Strata',
      },
      run: async () => {
        const res = await resetStrata()
        return `Reset complete (${compactCount(res.deleted)} items removed).`
      },
    },
  ]

  return (
    <Section title="Danger zone">
      <div className="space-y-2">
        {cards.map(card => (
          <div key={card.title} className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <Row
              title={card.title}
              subtitle={card.subtitle}
              actionLabel={card.actionLabel}
              confirm={card.confirm}
              onAction={async () => {
                try {
                  const msg = await card.run()
                  setMessage(msg)
                  await onChanged()
                } catch (err) {
                  setMessage(`Error: ${err}`)
                }
              }}
            />
          </div>
        ))}
        {message && <div className="text-xs text-muted-foreground pt-1">{message}</div>}
      </div>
    </Section>
  )
}

function Row({ title, subtitle, actionLabel, confirm, onAction }: {
  title: string
  subtitle: string
  actionLabel: string
  confirm: { title: string; description: string; actionLabel: string }
  onAction: () => Promise<void>
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground leading-relaxed">{subtitle}</p>
      </div>
      <ConfirmDialog
        title={confirm.title}
        description={confirm.description}
        actionLabel={confirm.actionLabel}
        destructive
        onAction={onAction}
      >
        <button
          className="cursor-pointer shrink-0 h-8 px-3 text-xs rounded-md border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
        >
          {actionLabel}
        </button>
      </ConfirmDialog>
    </div>
  )
}
