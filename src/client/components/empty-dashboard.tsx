import logo from '../assets/logo.png'

interface Props {
  onStartOnboarding: () => void
}

export function EmptyDashboard({ onStartOnboarding }: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-[440px] flex flex-col items-center space-y-3">
        <img src={logo} alt="Strata" width={64} height={64} className="size-16" />
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Strata is ready</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Strata processes new posts as they come in.
            <br />
            Backfill historical posts to surface buried connections.
          </p>
        </div>
        <button
          onClick={onStartOnboarding}
          className="mt-4 h-9 px-4 text-sm rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors cursor-pointer font-medium"
        >
          Set up Strata
        </button>
      </div>
    </div>
  )
}
