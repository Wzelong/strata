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
  const [skipOnboarding, setSkipOnboarding] = useState(false)

  if (loading) return <div className="h-full" />
  if (!isMod) return <PublicLanding />
  if (stats === null) return <div className="h-full" />

  const needsApiKey = !stats.hasApiKey
  const isBackfillRunning = ingest && !['idle', 'done', 'error', 'cancelled'].includes(ingest.phase)
  const itemCount = Math.max(stats.itemCount ?? 0, ingest?.processed ?? 0)
  const showEmpty = itemCount === 0 && !isBackfillRunning
  const showFullProgress = !!isBackfillRunning

  const openSettings = () => setSettingsOpen(true)
  const closeSettings = () => setSettingsOpen(false)

  const showOnboarding = showEmpty && !skipOnboarding

  let body: React.ReactNode
  if (needsApiKey) {
    body = <ConfigureStrata subredditName={subredditName} />
  } else if (showFullProgress) {
    body = <BackfillProgress backfillId={ingest?.backfillId ?? undefined} subredditName={subredditName} />
  } else if (showOnboarding) {
    body = <OnboardingView onStarted={() => refreshStats()} onSkip={() => setSkipOnboarding(true)} />
  } else if (settingsOpen) {
    body = <SettingsView onBack={closeSettings} />
  } else {
    // No alerts yet but we have items: land on the Posts list (+ graph on desktop)
    // instead of an empty alerts → blank-detail view that looks like nothing's here.
    const noAlertsWithItems = !stats.hasAlerts && itemCount > 0
    body = (
      <div className="flex flex-col h-full">
        <div className="flex-1 min-h-0">
          <Dashboard
            initialTab={noAlertsWithItems ? 'items' : 'alerts'}
            initialDetailTab={noAlertsWithItems ? 'explore' : undefined}
          />
        </div>
      </div>
    )
  }

  const chromeless = needsApiKey || showOnboarding || showFullProgress

  return (
    <div className="h-full flex flex-col">
      {!chromeless && (
        <Header
          settingsOpen={settingsOpen}
          onToggleSettings={() => (settingsOpen ? closeSettings() : openSettings())}
          onBackfill={() => setSkipOnboarding(false)}
        />
      )}
      <main className={cn('flex-1 min-h-0 h-0', !chromeless && 'pt-10')}>{body}</main>
    </div>
  )
}
