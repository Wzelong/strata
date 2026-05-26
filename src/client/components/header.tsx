import { Moon, Sun, Settings, AlertTriangle } from 'lucide-react'
import { useTheme } from '../hooks/use-theme'
import { useStats, refreshStats } from '../hooks/use-stats'
import { useViewer } from '../hooks/use-viewer'
import { recheckApiKey } from '../lib/api'
import { cn } from '../lib/utils'
import logo from '../assets/logo.png'

interface Props {
  settingsOpen?: boolean
  onToggleSettings?: () => void
}

export function Header({ settingsOpen, onToggleSettings }: Props) {
  const { theme, toggle } = useTheme()
  const stats = useStats()
  const { subredditName } = useViewer()
  const apiKeyInvalid = stats?.apiKeyInvalid ?? false
  const settingsUrl = subredditName ? `https://www.reddit.com/mod/${subredditName}/apps` : 'https://www.reddit.com'

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
        {apiKeyInvalid && (
          <a
            href={settingsUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleRecheck}
            title="OpenAI API key invalid — click to fix in app settings"
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
          >
            <AlertTriangle className="size-3.5" />
            Invalid key
          </a>
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
