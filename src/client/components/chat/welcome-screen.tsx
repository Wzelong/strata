import { ShieldAlert, Users, Search, Layers, type LucideIcon } from 'lucide-react'
import logoUrl from '../../assets/logo.png'

interface Suggestion {
  icon: LucideIcon
  label: string
}

const SUGGESTIONS: Suggestion[] = [
  { icon: ShieldAlert, label: 'What needs my attention right now?' },
  { icon: Users, label: 'Any coordinated brigading lately?' },
  { icon: Search, label: 'Find complaints about moderation' },
  { icon: Layers, label: 'Summarize the biggest active topic' },
]

interface WelcomeScreenProps {
  onPick: (text: string) => void
}

export function WelcomeScreen({ onPick }: WelcomeScreenProps) {
  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 py-6 gap-4 text-center">
      <img src={logoUrl} alt="Strata" className="size-10 opacity-90" />
      <div className="space-y-1">
        <p className="text-sm font-medium">What can I help you moderate?</p>
        <p className="text-xs text-muted-foreground max-w-sm">
          Triage alerts, search by meaning, and summarize topics across the queue.
        </p>
      </div>
      <div className="flex flex-col gap-1.5 w-full max-w-sm">
        {SUGGESTIONS.map(({ icon: Icon, label }) => (
          <button
            key={label}
            onClick={() => onPick(label)}
            className="text-left text-sm rounded-none border px-3 py-2 hover:bg-muted cursor-pointer flex items-center gap-2 transition-colors"
          >
            <Icon className="size-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
