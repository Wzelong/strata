import { useState } from 'react'
import { Header } from './components/header'
import { Dashboard } from './components/dashboard'
import { PublicLanding } from './components/public-landing'
import { OnboardingView } from './components/onboarding-view'
import { ConfigureStrata } from './components/configure-strata'
import { SettingsView } from './components/settings-view'
import { BackfillProgress } from './components/backfill-progress'
import { useViewer } from './hooks/use-viewer'
import { useStats, refreshStats } from './hooks/use-stats'
import { useIngestStatus } from './hooks/use-ingest-status'
import { cn } from './lib/utils'

export function App() {
  const { isMod, loading, subredditName } = useViewer()
  const stats = useStats()
  const ingest = useIngestStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (loading) return <div className="h-dvh" />
  if (!isMod) return <PublicLanding />
  if (stats === null) return <div className="h-dvh" />

  const needsApiKey = !stats.hasApiKey
  const isBackfillRunning = ingest && !['idle', 'done', 'error', 'cancelled'].includes(ingest.phase)
  const itemCount = Math.max(stats.itemCount ?? 0, ingest?.processed ?? 0)
  const showEmpty = itemCount === 0 && !isBackfillRunning
  const showFullProgress = !!isBackfillRunning

  const openSettings = () => setSettingsOpen(true)
  const closeSettings = () => setSettingsOpen(false)

  let body: React.ReactNode
  if (needsApiKey) {
    body = <ConfigureStrata subredditName={subredditName} />
  } else if (showFullProgress) {
    body = <BackfillProgress backfillId={ingest?.backfillId ?? undefined} subredditName={subredditName} />
  } else if (showEmpty) {
    body = <OnboardingView onStarted={() => refreshStats()} />
  } else if (settingsOpen) {
    body = <SettingsView onBack={closeSettings} />
  } else {
    body = (
      <div className="flex flex-col h-full">
        <div className="flex-1 min-h-0">
          <Dashboard />
        </div>
      </div>
    )
  }

  const chromeless = needsApiKey || showEmpty || showFullProgress

  return (
    <div className="h-dvh flex flex-col">
      {!chromeless && (
        <Header
          settingsOpen={settingsOpen}
          onToggleSettings={() => (settingsOpen ? closeSettings() : openSettings())}
        />
      )}
      <main className={cn('flex-1 min-h-0 h-0', !chromeless && 'pt-10')}>{body}</main>
    </div>
  )
}
