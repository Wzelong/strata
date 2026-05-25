import { useState, useRef, useEffect } from 'react'
import { ListFilter } from 'lucide-react'
import { cn } from '../lib/utils'
import type { FilterConfig } from './data-list'

interface FilterMenuProps {
  filters: FilterConfig[]
  onReset: () => void
}

export function FilterMenu({ filters, onReset }: FilterMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const hasActiveFilter = filters.some(f => f.value !== null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:text-foreground transition-colors',
          (hasActiveFilter || open) && 'bg-accent text-foreground',
        )}
        aria-label="Filter"
      >
        <ListFilter className="size-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-[60] min-w-32 bg-popover border border-border rounded-md shadow-md py-1">
          {hasActiveFilter && (
            <>
              <button
                onClick={() => { onReset(); setOpen(false) }}
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-accent cursor-pointer rounded-sm"
              >
                Clear all
              </button>
              <div className="my-1 border-t border-border" />
            </>
          )}
          {filters.map((filter, idx) => (
            <div key={idx} className={idx > 0 ? 'mt-1' : ''}>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground select-none">
                {filter.label}
              </div>
              {filter.options.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No options</div>
              ) : (
                filter.options.map(option => {
                  const isActive = filter.value === option.value
                  return (
                    <button
                      key={option.value}
                      onClick={() => {
                        filter.onChange(isActive ? '' : option.value)
                        setOpen(false)
                      }}
                      className={cn(
                        'w-full text-left px-2 py-1.5 text-xs hover:bg-accent cursor-pointer rounded-sm flex items-center',
                        isActive && 'bg-accent',
                      )}
                    >
                      <span className="flex-1 truncate">{option.label}</span>
                      {option.count !== undefined && (
                        <span className="text-xs text-muted-foreground ml-2">{option.count}</span>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
