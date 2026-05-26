import { ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import logo from '../assets/logo.png'
import { refreshStats } from '../hooks/use-stats'

interface Props {
  subredditName?: string | null
}

export function ConfigureStrata({ subredditName }: Props) {
  const [refreshing, setRefreshing] = useState(false)

  const settingsUrl = subredditName
    ? `https://www.reddit.com/mod/${subredditName}/apps`
    : 'https://www.reddit.com'

  const handleRetry = async () => {
    setRefreshing(true)
    try {
      await refreshStats()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-[480px] flex flex-col items-center space-y-4">
        <img src={logo} alt="Strata" width={64} height={64} className="size-16" />
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Configure Strata</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Strata needs an OpenAI API key to surface connections and draft mod updates.
            <br />
            Add it once in this app's install settings.
          </p>
        </div>
        <ol className="text-sm text-muted-foreground space-y-1.5 self-stretch list-decimal pl-5">
          <li>Open r/{subredditName ?? 'your subreddit'} → Mod Tools → Apps → Strata.</li>
          <li>Paste your OpenAI API key into the <span className="font-medium text-foreground">OpenAI API Key</span> field.</li>
          <li>Save, then come back here and retry.</li>
        </ol>
        <div className="flex items-center gap-2 pt-1">
          <a
            href={settingsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="h-9 px-4 text-sm rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors cursor-pointer font-medium inline-flex items-center gap-2"
          >
            Open app settings
            <ExternalLink className="size-3.5" />
          </a>
          <button
            onClick={handleRetry}
            disabled={refreshing}
            className="h-9 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer font-medium inline-flex items-center gap-2 disabled:opacity-50"
          >
            <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
            Retry
          </button>
        </div>
      </div>
    </div>
  )
}
