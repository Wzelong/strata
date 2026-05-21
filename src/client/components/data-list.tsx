import { useState, useEffect, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X, CheckCheck } from 'lucide-react'
import { cn } from '../lib/utils'
import { FilterMenu } from './filter-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'
import { Checkbox } from './ui/checkbox'

export interface FilterOption {
  value: string
  label: string
  count?: number
}

export interface FilterConfig {
  label: string
  value: string | null
  options: FilterOption[]
  onChange: (value: string) => void
}

export interface BulkAction {
  icon: ReactNode
  onClick: () => void
  ariaLabel: string
}

export interface InfiniteConfig {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  total?: number
}

interface DataListProps<T> {
  data: T[]
  getItemId: (item: T) => string
  renderItem: (item: T) => ReactNode
  activeId?: string
  onItemClick?: (item: T) => void
  isLoading?: boolean
  emptyIcon?: ReactNode
  emptyMessage?: string
  tabs?: { label: string; value: string; icon?: ReactNode }[]
  activeTab?: string
  onTabChange?: (tab: string) => void
  filters?: FilterConfig[]
  searchValue?: string
  onSearchChange?: (value: string) => void
  toolbarButtons?: { icon: ReactNode; onClick: () => void; ariaLabel: string; active?: boolean }[]
  selectedIds?: Set<string>
  onSelectOne?: (id: string) => void
  onSelectAll?: () => void
  allSelected?: boolean
  onClearSelection?: () => void
  bulkActions?: BulkAction[]
  infinite?: InfiniteConfig
}

function LoadingBar({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 h-0.5 overflow-hidden">
      <div
        className="absolute h-full w-1/3 bg-muted-foreground/30 rounded-full animate-[indeterminate_1.2s_ease-in-out_infinite]"
      />
    </div>
  )
}

export function DataList<T>({
  data,
  getItemId,
  renderItem,
  activeId,
  onItemClick,
  isLoading,
  emptyIcon,
  emptyMessage = 'No items',
  tabs,
  activeTab,
  onTabChange,
  filters,
  searchValue,
  onSearchChange,
  toolbarButtons = [],
  selectedIds,
  onSelectOne,
  onSelectAll,
  allSelected,
  onClearSelection,
  bulkActions = [],
  infinite,
}: DataListProps<T>) {
  const [searchOpen, setSearchOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const hasSelection = selectedIds && selectedIds.size > 0

  // Infinite scroll sentinel
  useEffect(() => {
    if (!infinite || !sentinelRef.current || !listRef.current) return
    const sentinel = sentinelRef.current
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && infinite.hasNextPage && !infinite.isFetchingNextPage) {
          infinite.fetchNextPage()
        }
      },
      { root: listRef.current, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [infinite?.hasNextPage, infinite?.isFetchingNextPage, infinite?.fetchNextPage])

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    overscan: 10,
  })

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="relative flex items-center justify-between gap-2 px-3 h-10 border-b shrink-0 select-none">
        <LoadingBar active={!!isLoading} />
        {hasSelection ? (
          <>
            <span className="text-xs text-muted-foreground flex-1">
              {selectedIds!.size} selected
            </span>
            <div className="flex items-center gap-1">
              {onSelectAll && (
                <button
                  onClick={onSelectAll}
                  className={cn(
                    'h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer transition-colors',
                    allSelected ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  aria-label="Select all"
                >
                  <CheckCheck className="size-3" />
                </button>
              )}
              {bulkActions.map((action, idx) => (
                <button
                  key={idx}
                  onClick={action.onClick}
                  className="h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={action.ariaLabel}
                >
                  {action.icon}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            {tabs && onTabChange ? (
              <div className="flex items-center gap-1 -ml-[4px]">
                {tabs.map(t => (
                  <Tooltip key={t.value}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onTabChange(t.value)}
                        className={cn(
                          'h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer transition-colors',
                          activeTab === t.value
                            ? 'bg-foreground/10 text-foreground'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {t.icon ?? <span className="text-[11px]">{t.label}</span>}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t.label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            ) : (
              <div className="flex-1" />
            )}

            <div className="flex items-center gap-1">
              {filters && filters.length > 0 && (
                <FilterMenu
                  filters={filters}
                  onReset={() => filters.forEach(f => f.onChange(''))}
                />
              )}
              {onSearchChange && (
                <button
                  onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) onSearchChange('') }}
                  className={cn(
                    'h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:text-foreground transition-colors',
                    searchOpen && 'bg-accent text-foreground',
                  )}
                  aria-label="Search"
                >
                  <Search className="size-3" />
                </button>
              )}
              {toolbarButtons.map((btn, idx) => (
                <button
                  key={idx}
                  onClick={btn.onClick}
                  className={cn(
                    'h-6 w-6 inline-flex items-center justify-center rounded cursor-pointer text-muted-foreground hover:text-foreground transition-colors',
                    btn.active && 'bg-accent text-foreground',
                  )}
                  aria-label={btn.ariaLabel}
                >
                  {btn.icon}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Search bar */}
      {searchOpen && onSearchChange && (
        <div className="px-3 py-1.5 border-b shrink-0">
          <div className="relative">
            <Search className="absolute left-1 top-1.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              autoFocus
              value={searchValue ?? ''}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search..."
              className="pl-6 pr-6 h-7 text-xs w-full bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {searchValue && (
              <button
                onClick={() => onSearchChange('')}
                className="absolute right-0.5 top-0.5 h-6 w-6 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-4">
            {emptyIcon}
            <p className={cn('text-sm text-muted-foreground text-center', isLoading && 'shimmer-text')}>
              {emptyMessage}
            </p>
          </div>
        ) : (
          <>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map(virtual => {
                const item = data[virtual.index]
                const id = getItemId(item)
                const isActive = activeId === id
                const isSelected = selectedIds?.has(id) ?? false
                return (
                  <div
                    key={id}
                    data-index={virtual.index}
                    ref={virtualizer.measureElement}
                    className={cn(
                      'flex items-start gap-1.5 px-[13px] py-2.5 border-b transition-colors select-none absolute left-0 right-0 top-0',
                      isActive ? 'bg-muted/70' : 'hover:bg-muted/50',
                      onItemClick && 'cursor-pointer',
                    )}
                    style={{ transform: `translateY(${virtual.start}px)` }}
                    onClick={() => onItemClick?.(item)}
                  >
                    {onSelectOne && (
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onSelectOne(id)}
                        onClick={e => e.stopPropagation()}
                        className="mt-[5px] cursor-pointer"
                      />
                    )}
                    <div className="flex-1 min-w-0">{renderItem(item)}</div>
                  </div>
                )
              })}
            </div>
            {infinite && (
              <>
                <div ref={sentinelRef} className="h-1" />
                {infinite.isFetchingNextPage && (
                  <div className="px-3 py-3 text-center text-xs text-muted-foreground">Loading more...</div>
                )}
                {!infinite.hasNextPage && data.length > 0 && (
                  <div className="px-3 py-3 text-center text-xs text-muted-foreground/70">
                    {infinite.total != null ? `${infinite.total.toLocaleString()} items` : 'End'}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
