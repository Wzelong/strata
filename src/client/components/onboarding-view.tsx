import logo from '../assets/logo.png'
import { OnboardingForm } from './onboarding-form'

interface Props {
  onStarted: () => void
  onSkip?: () => void
}

export function OnboardingView({ onStarted, onSkip }: Props) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-full flex flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-[440px] space-y-5">
          <div className="flex flex-col items-center text-center space-y-1.5">
            <img src={logo} alt="Strata" width={56} height={56} className="size-14" />
            <h1 className="text-2xl font-semibold tracking-tight">Backfill your subreddit</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Pick a window of history to process. Strata embeds, extracts entities,
              surfaces connections, and clusters topics — then keeps working on new posts.
            </p>
          </div>
          <OnboardingForm onStarted={onStarted} onSkip={onSkip} />
        </div>
      </div>
    </div>
  )
}
