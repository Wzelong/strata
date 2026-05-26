import { useState } from 'react'
import { Loader2, KeyRound, Check, ExternalLink } from 'lucide-react'
import logo from '../assets/logo.png'
import { saveApiKey } from '../lib/api'
import { refreshStats } from '../hooks/use-stats'

interface Props {
  subredditName?: string | null
}

export function ConfigureStrata({ subredditName }: Props) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleSave = async () => {
    const trimmed = key.trim()
    if (!trimmed) return
    setSaving(true)
    setError(null)
    try {
      const res = await saveApiKey(trimmed)
      if (res.error) {
        setError(res.error === 'invalid_api_key' ? 'That key was rejected by OpenAI. Check it and try again.' : res.error)
        return
      }
      setDone(true)
      setKey('')
      await refreshStats()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-[440px] flex flex-col items-center space-y-4">
        <img src={logo} alt="Strata" width={56} height={56} className="size-14" />
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Connect OpenAI</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Strata uses OpenAI to surface connections and draft mod updates.
            <br />
            Paste a key for r/{subredditName ?? 'this subreddit'}. It's encrypted and stored only for this community.
          </p>
        </div>

        <div className="w-full space-y-2">
          <div className="relative">
            <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="password"
              value={key}
              onChange={e => { setKey(e.target.value); setError(null); setDone(false) }}
              onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              className="w-full h-9 pl-8 pr-3 text-sm rounded-md border border-border bg-transparent outline-none focus:border-foreground/40 transition-colors placeholder:text-muted-foreground font-mono"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {done && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1.5">
              <Check className="size-3.5" /> Saved. Loading…
            </p>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !key.trim()}
            className="w-full h-9 text-sm rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors cursor-pointer font-medium disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {saving ? 'Validating…' : 'Validate & connect'}
          </button>
        </div>

        <a
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
        >
          Get an OpenAI API key
          <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}
