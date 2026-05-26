import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface InlineTab {
  value: string
  label?: string
  icon?: ReactNode
}

interface InlineTabsProps {
  tabs: InlineTab[]
  value: string
  onChange: (value: string) => void
  className?: string
}

export function InlineTabs({ tabs, value, onChange, className }: InlineTabsProps) {
  return (
    <div className={cn('inline-flex items-center rounded-md border border-border', className)}>
      {tabs.map((tab, i) => (
        <button
          key={tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'h-7 px-3 text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors',
            i < tabs.length - 1 && 'border-r border-border',
            i === 0 && 'rounded-l-md',
            i === tabs.length - 1 && 'rounded-r-md',
            value === tab.value
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  )
}
