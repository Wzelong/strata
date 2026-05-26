import { useState } from 'react'
import { Header } from './components/header'
import { Dashboard } from './components/dashboard'
import { PublicLanding } from './components/public-landing'
import { EmptyDashboard } from './components/empty-dashboard'
import { ConfigureStrata } from './components/configure-strata'
import { SettingsView } from './components/settings-view'
import { BackfillProgress } from './components/backfill-progress'
import { PipelineBanner } from './components/pipeline-banner'
import { useViewer } from './hooks/use-viewer'
import { useStats } from './hooks/use-stats'
import { useIngestStatus } from './hooks/use-ingest-status'

export function App() {
  const { isMod, loading, subredditName } = useViewer()
  const stats = useStats()
  const ingest = useIngestStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [forceForm, setForceForm] = useState(false)

  if (loading) return <div className="h-dvh" />
  if (!isMod) return <PublicLanding />

  const itemCount = stats?.itemCount ?? 0
  const needsApiKey = stats !== null && !stats.hasApiKey
  const isBackfillRunning = ingest && !['idle', 'done', 'error', 'cancelled'].includes(ingest.phase)
  const showEmpty = itemCount === 0 && !isBackfillRunning
  const showFullProgress = itemCount === 0 && isBackfillRunning

  const openSettings = (withForm = false) => {
    setForceForm(withForm)
    setSettingsOpen(true)
  }
  const closeSettings = () => {
    setSettingsOpen(false)
    setForceForm(false)
  }

  let body: React.ReactNode
  if (needsApiKey) {
    body = <ConfigureStrata subredditName={subredditName} />
  } else if (settingsOpen) {
    body = <SettingsView onBack={closeSettings} forceForm={forceForm} />
  } else if (showFullProgress) {
    body = <BackfillProgress />
  } else if (showEmpty) {
    body = <EmptyDashboard onStartOnboarding={() => openSettings(true)} />
  } else {
    body = (
      <div className="flex flex-col h-full">
        <PipelineBanner onOpenSettings={() => openSettings(false)} />
        <div className="flex-1 min-h-0">
          <Dashboard />
        </div>
      </div>
    )
  }

  return (
    <div className="h-dvh flex flex-col">
      <Header
        settingsOpen={settingsOpen}
        onToggleSettings={() => (settingsOpen ? closeSettings() : openSettings(false))}
      />
      <main className="flex-1 min-h-0 h-0 pt-10">{body}</main>
    </div>
  )
}
