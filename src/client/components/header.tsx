import { Moon, Sun, Settings, AlertTriangle, Loader2, ScanSearch, DatabaseZap, X, User, KeyRound } from 'lucide-react'
import { useTheme } from '../hooks/use-theme'
import { useStats, refreshStats } from '../hooks/use-stats'
import { useViewer } from '../hooks/use-viewer'
import { useIngestStatus, refreshIngestStatus } from '../hooks/use-ingest-status'
import { recheckApiKey, startScan, dismissBackfillError } from '../lib/api'
import { refreshScanStatus } from '../hooks/use-scan-status'
import { cn, compactCount } from '../lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'
import logo from '../assets/logo.png'

interface Props {
  settingsOpen?: boolean
  onToggleSettings?: () => void
  onBackfill?: () => void
}

export function Header({ settingsOpen, onToggleSettings, onBackfill }: Props) {
  const { theme, toggle } = useTheme()
  const stats = useStats()
  const { subredditName } = useViewer()
  const ingest = useIngestStatus()
  const apiKeyInvalid = stats?.apiKeyInvalid ?? false
  const settingsUrl = subredditName ? `https://www.reddit.com/mod/${subredditName}/apps` : 'https://www.reddit.com'
  const isBackfilling = ingest && !['idle', 'done', 'error', 'cancelled'].includes(ingest.phase)

  const handleRecheck = async () => {
    await recheckApiKey()
    await refreshStats()
  }

  return (
    <header className="fixed top-0 left-0 right-0 h-10 border-t border-b border-border bg-background/95 backdrop-blur flex items-center z-50">
      <div className="pl-[6px] flex items-center gap-1">
        <img
          src={logo}
          alt="Strata"
          width={28}
          height={28}
          className="size-[28px]"
        />
        <span className="font-semibold text-sm">Strata</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1 pr-[6px]">
        {isBackfilling && (
          <button
            onClick={onToggleSettings}
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer tabular-nums"
          >
            <Loader2 className="size-3 animate-spin" />
            {compactCount(ingest?.processed ?? 0)}/{compactCount(ingest?.totalItems ?? 0)}
          </button>
        )}
        {!isBackfilling && ingest?.phase === 'error' && (
          <div className="h-7 inline-flex items-center rounded-md text-xs text-destructive bg-destructive/10 overflow-hidden">
            <button
              onClick={onToggleSettings}
              title="Backfill failed — open settings to retry"
              className="h-7 pl-2 pr-1.5 inline-flex items-center gap-1.5 cursor-pointer hover:bg-destructive/15 transition-colors"
            >
              <AlertTriangle className="size-3.5" />
              <span className="hidden sm:inline">Backfill failed</span>
            </button>
            <button
              onClick={async () => { await dismissBackfillError(); await refreshIngestStatus() }}
              title="Dismiss"
              className="h-7 px-1.5 inline-flex items-center cursor-pointer hover:bg-destructive/15 transition-colors"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
        {!isBackfilling && stats && stats.itemCount === 0 && onBackfill && (
          <button
            onClick={onBackfill}
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <DatabaseZap className="size-3" />
            <span className="hidden sm:inline">Backfill</span>
          </button>
        )}
        {!isBackfilling && stats && stats.itemCount > 0 && !stats.hasAlerts && (
          <button
            onClick={async () => {
              await startScan()
              await refreshScanStatus()
              if (!settingsOpen) onToggleSettings?.()
              requestAnimationFrame(() => {
                document.getElementById('settings-scan')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              })
            }}
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <ScanSearch className="size-3" />
            <span className="hidden sm:inline">Scan</span>
          </button>
        )}
        {apiKeyInvalid && (
          <a
            href={settingsUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleRecheck}
            title="OpenAI API key invalid — click to fix in app settings"
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
          >
            <KeyRound className="size-3.5" />
            <span className="hidden sm:inline">Invalid key</span>
          </a>
        )}
        {stats?.processModContent && onToggleSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleSettings}
                className="h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <User className="size-3" />
                <span className="hidden sm:inline">Moderator posts on</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Moderator posts &amp; comments are processed. Turn off for production.
            </TooltipContent>
          </Tooltip>
        )}
        <button
          onClick={toggle}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="cursor-pointer h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
        >
          {theme === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        </button>
        {onToggleSettings && (
          <button
            onClick={onToggleSettings}
            title="Settings"
            className={cn(
              'cursor-pointer h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors',
              settingsOpen ? 'bg-accent text-foreground' : 'hover:bg-accent text-muted-foreground hover:text-foreground',
            )}
          >
            <Settings className="size-3.5" />
          </button>
        )}
      </div>
    </header>
  )
}
