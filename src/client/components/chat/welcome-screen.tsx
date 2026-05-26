import { Search, Layers, TrendingUp, type LucideIcon } from 'lucide-react'
import logoUrl from '../../assets/logo.png'

interface Suggestion {
  icon: LucideIcon
  label: string
}

const SUGGESTIONS: Suggestion[] = [
  { icon: Search, label: 'Find recent complaints about moderation' },
  { icon: Layers, label: 'Summarize the largest active cluster' },
  { icon: TrendingUp, label: 'What spiked on the timeline today?' },
]

interface WelcomeScreenProps {
  onPick: (text: string) => void
}

export function WelcomeScreen({ onPick }: WelcomeScreenProps) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 pb-12 gap-4 text-center">
      <img src={logoUrl} alt="Strata" className="size-10 opacity-90" />
      <div className="space-y-1">
        <p className="text-sm font-medium">What can I help you moderate?</p>
        <p className="text-xs text-muted-foreground max-w-sm">
          Search, summarize clusters, and surface items on the graph.
        </p>
      </div>
      <div className="flex flex-col gap-1.5 w-full max-w-sm">
        {SUGGESTIONS.map(({ icon: Icon, label }) => (
          <button
            key={label}
            onClick={() => onPick(label)}
            className="text-left text-sm rounded-md border px-3 py-2 hover:bg-muted cursor-pointer flex items-center gap-2 transition-colors"
          >
            <Icon className="size-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
