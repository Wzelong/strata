import { useState, useRef, useEffect } from 'react'
import { ListFilter, ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'
import type { FilterConfig } from './data-list'

interface FilterMenuProps {
  filters: FilterConfig[]
  onReset: () => void
}

export function FilterMenu({ filters, onReset }: FilterMenuProps) {
  const [open, setOpen] = useState(false)
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const hasActiveFilter = filters.some(f => f.value !== null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setActiveSubmenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => { setOpen(!open); setActiveSubmenu(null) }}
        className={cn(
          'h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:text-foreground transition-colors',
          (hasActiveFilter || open) && 'bg-accent text-foreground',
        )}
        aria-label="Filter"
      >
        <ListFilter className="size-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-50 w-40 bg-popover border border-border rounded-md shadow-md py-1">
          {/* All */}
          <button
            onClick={() => { onReset(); setOpen(false); setActiveSubmenu(null) }}
            className={cn(
              'w-full text-left px-2 py-1.5 text-xs hover:bg-accent cursor-pointer rounded-sm',
              !hasActiveFilter && 'bg-accent',
            )}
          >
            All
          </button>

          {/* Filter submenus */}
          {filters.map((filter, idx) => (
            <div
              key={idx}
              className="relative"
              onMouseEnter={() => setActiveSubmenu(idx)}
            >
              <button
                className={cn(
                  'w-full text-left px-2 py-1.5 text-xs hover:bg-accent cursor-pointer rounded-sm flex items-center',
                  filter.value !== null && 'bg-accent',
                )}
              >
                <span className="flex-1">{filter.label}</span>
                <ChevronRight className="size-3 text-muted-foreground" />
              </button>

              {/* Submenu */}
              {activeSubmenu === idx && (
                <div className="absolute left-full top-0 ml-1 w-40 bg-popover border border-border rounded-md shadow-md py-1">
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
                            setActiveSubmenu(null)
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
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
