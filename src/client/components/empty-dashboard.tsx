import { Telescope, Sparkles, Radio } from 'lucide-react'
import logo from '../assets/logo.png'

interface Props {
  onStartOnboarding: () => void
}

export function EmptyDashboard({ onStartOnboarding }: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-[460px] flex flex-col items-center space-y-5">
        <img src={logo} alt="Strata" width={56} height={56} className="size-14" />
        <div className="text-center space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Strata is connected</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Backfill your subreddit's history to surface buried connections,
            <br />
            then Strata keeps working on every new post.
          </p>
        </div>

        <div className="w-full space-y-2.5">
          <Step icon={<Telescope className="size-4" />} title="Backfill history" desc="Pull recent posts and comments so Strata can find related threads across time." />
          <Step icon={<Sparkles className="size-4" />} title="Surfaces & topics" desc="Connections, brigades, and topic clusters appear in the dashboard automatically." />
          <Step icon={<Radio className="size-4" />} title="Stays live" desc="New posts are processed as they arrive — no need to re-run anything." />
        </div>

        <button
          onClick={onStartOnboarding}
          className="h-9 px-4 text-sm rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors cursor-pointer font-medium w-full"
        >
          Backfill historical posts
        </button>
      </div>
    </div>
  )
}

function Step({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border p-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{desc}</p>
      </div>
    </div>
  )
}
