import { setViewerOverride, useViewerOverride } from '../hooks/use-viewer'
import logo from '../assets/logo.png'

const isDev = import.meta.env.DEV

export function PublicLanding() {
  const override = useViewerOverride()
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-[440px] flex flex-col items-center space-y-3">
        <img src={logo} alt="Strata" width={64} height={64} className="size-16" />
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Strata</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Moderator-only investigation tool.
            <br />
            This dashboard is visible to subreddit moderators.
          </p>
        </div>
      </div>
      {isDev && override === 'public' && (
        <button
          onClick={() => setViewerOverride(null)}
          className="cursor-pointer fixed bottom-3 right-3 text-xs text-muted-foreground hover:text-foreground bg-background/80 border border-border rounded-md px-2 py-1 backdrop-blur"
        >
          Exit preview
        </button>
      )}
    </div>
  )
}
