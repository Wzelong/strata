import { useState, useEffect, useCallback, useRef } from 'react'
import { Bell, Database, Stamp, Ban, Check, X, Waypoints } from 'lucide-react'
import { DataList, type FilterConfig } from './data-list'
import { AlertDetailPanel } from './alert-detail'
import { ChatPanel } from './chat-panel'
import { fetchAlerts, fetchItems, alertAction, type AlertListItem, type ItemListItem } from '../lib/api'
import { cn, formatRelativeTime } from '../lib/utils'

type Tab = 'alerts' | 'items'
type ContentView = 'list' | 'detail'

const PAGE_SIZE = 50

export function Dashboard() {
  const [tab, setTab] = useState<Tab>('alerts')
  const [contentView, setContentView] = useState<ContentView>('list')
  const [alerts, setAlerts] = useState<AlertListItem[]>([])
  const [alertsLoading, setAlertsLoading] = useState(true)
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null)

  // Items — infinite scroll state
  const [items, setItems] = useState<ItemListItem[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsCursor, setItemsCursor] = useState<number | null>(null)
  const [itemsHasMore, setItemsHasMore] = useState(true)
  const [itemsTotal, setItemsTotal] = useState(0)
  const [itemsFetchingMore, setItemsFetchingMore] = useState(false)

  // Filters
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [confidenceFilter, setConfidenceFilter] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Debounce search for items
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const loadAlerts = useCallback(async () => {
    setAlertsLoading(true)
    try {
      const { alerts: data } = await fetchAlerts({ status: statusFilter as any, limit: 50 })
      let filtered = data
      if (confidenceFilter) filtered = filtered.filter(a => a.confidence === confidenceFilter)
      setAlerts(filtered)
    } catch { setAlerts([]) }
    setAlertsLoading(false)
  }, [statusFilter, confidenceFilter])

  const loadItemsPage = useCallback(async (cursor?: number, reset = false) => {
    if (reset) {
      setItemsLoading(true)
      setItems([])
      setItemsCursor(null)
      setItemsHasMore(true)
    } else {
      setItemsFetchingMore(true)
    }

    try {
      const page = await fetchItems({
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
        type: typeFilter || undefined,
        search: search || undefined,
      })
      if (reset) {
        setItems(page.items)
      } else {
        setItems(prev => [...prev, ...page.items])
      }
      setItemsCursor(page.nextCursor)
      setItemsHasMore(page.nextCursor !== null && page.items.length === PAGE_SIZE)
      setItemsTotal(page.total)
    } catch {
      setItemsHasMore(false)
    }

    setItemsLoading(false)
    setItemsFetchingMore(false)
  }, [typeFilter, search])

  useEffect(() => { loadAlerts() }, [loadAlerts])

  useEffect(() => {
    if (tab === 'items') loadItemsPage(undefined, true)
  }, [tab, typeFilter])

  // Debounced search for items
  useEffect(() => {
    if (tab !== 'items') return
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      loadItemsPage(undefined, true)
    }, 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [search])

  useEffect(() => { setSelectedIds(new Set()) }, [tab])

  const fetchNextItemsPage = useCallback(() => {
    if (itemsCursor && itemsHasMore && !itemsFetchingMore) {
      loadItemsPage(itemsCursor, false)
    }
  }, [itemsCursor, itemsHasMore, itemsFetchingMore, loadItemsPage])

  const handleBulkResolve = async () => {
    for (const id of selectedIds) await alertAction(id, 'resolved')
    setSelectedIds(new Set())
    loadAlerts()
  }

  const handleBulkDismiss = async () => {
    for (const id of selectedIds) await alertAction(id, 'dismissed')
    setSelectedIds(new Set())
    loadAlerts()
  }

  const alertFilters: FilterConfig[] = [
    {
      label: 'Status',
      value: statusFilter,
      options: [
        { value: 'pending', label: 'Pending' },
        { value: 'resolved', label: 'Resolved' },
        { value: 'dismissed', label: 'Dismissed' },
      ],
      onChange: v => { setStatusFilter(v || null); setSelectedIds(new Set()) },
    },
    {
      label: 'Confidence',
      value: confidenceFilter,
      options: [
        { value: 'high', label: 'High' },
        { value: 'review', label: 'Review' },
      ],
      onChange: v => { setConfidenceFilter(v || null); setSelectedIds(new Set()) },
    },
  ]

  const itemFilters: FilterConfig[] = [
    {
      label: 'Type',
      value: typeFilter,
      options: [
        { value: 'post', label: 'Post' },
        { value: 'comment', label: 'Comment' },
      ],
      onChange: v => setTypeFilter(v || null),
    },
  ]

  const renderAlertItem = (alert: AlertListItem) => {
    const reviewed = alert.status === 'resolved' || alert.status === 'dismissed'
    const typeLabel = alert.mode === 'flag'
      ? `Flag · ${alert.flagType ?? 'unknown'}`
      : 'Surface'

    return (
      <div className="flex items-start gap-1.5 min-w-0">
        <span className="size-3 shrink-0 inline-flex items-center justify-center mt-[5px]">
          {reviewed ? (
            alert.status === 'resolved'
              ? <Check className="size-3" />
              : <X className="size-3" />
          ) : (
            <span className={cn(
              'size-1.5 rounded-full',
              alert.confidence === 'high' ? 'bg-green-500' : 'bg-amber-500',
            )} />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{alert.anchorText.slice(0, 80)}</div>
          <div className="text-xs text-muted-foreground truncate mt-0.5 flex items-center gap-1">
            <span>{typeLabel}</span>
            <span>·</span>
            <Waypoints className="size-3" />
            <span>{alert.connectionCount}</span>
            <span>·</span>
            <span>{formatRelativeTime(alert.createdAt)}</span>
          </div>
        </div>
      </div>
    )
  }

  const renderItemRow = (item: ItemListItem) => (
    <div className="min-w-0">
      <div className="text-sm truncate">{item.text.slice(0, 100)}</div>
      <div className="text-xs text-muted-foreground truncate mt-0.5">
        {item.type} · u/{item.authorName} · {formatRelativeTime(item.createdAt)}
      </div>
    </div>
  )

  const hasDetail = tab === 'alerts' && selectedAlertId

  return (
    <div className="flex h-full">
      {/* Left panel — list */}
      <div className={cn(
        'shrink-0 lg:w-[280px] flex-1 lg:flex-none border-r flex-col h-full min-h-0 overflow-hidden',
        contentView !== 'list' ? 'hidden lg:flex' : 'flex',
      )}>
        {tab === 'alerts' ? (
          <DataList
            data={alerts}
            getItemId={a => a.id}
            renderItem={renderAlertItem}
            activeId={selectedAlertId ?? undefined}
            onItemClick={a => { setSelectedAlertId(a.id); setContentView('detail') }}
            isLoading={alertsLoading}
            emptyIcon={<Bell className="size-6 text-muted-foreground" />}
            emptyMessage={alertsLoading ? 'Loading alerts...' : 'No alerts yet'}
            tabs={[
              { label: 'Alerts', value: 'alerts', icon: <Bell className="size-3.5" /> },
              { label: 'Items', value: 'items', icon: <Database className="size-3.5" /> },
            ]}
            activeTab={tab}
            onTabChange={t => { setTab(t as Tab); setSelectedAlertId(null); setContentView('list') }}
            filters={alertFilters}
            searchValue={search}
            onSearchChange={setSearch}
            selectedIds={selectedIds}
            onSelectOne={id => {
              const next = new Set(selectedIds)
              if (next.has(id)) next.delete(id); else next.add(id)
              setSelectedIds(next)
            }}
            onSelectAll={() => {
              if (selectedIds.size === alerts.length) setSelectedIds(new Set())
              else setSelectedIds(new Set(alerts.map(a => a.id)))
            }}
            allSelected={selectedIds.size === alerts.length && alerts.length > 0}
            onClearSelection={() => setSelectedIds(new Set())}
            bulkActions={[
              { icon: <Stamp className="size-3" />, onClick: handleBulkResolve, ariaLabel: 'Resolve selected' },
              { icon: <Ban className="size-3" />, onClick: handleBulkDismiss, ariaLabel: 'Dismiss selected' },
            ]}
          />
        ) : (
          <DataList
            data={items}
            getItemId={i => i.id}
            renderItem={renderItemRow}
            isLoading={itemsLoading}
            emptyIcon={<Database className="size-6 text-muted-foreground" />}
            emptyMessage={itemsLoading ? 'Loading items...' : 'No items ingested'}
            tabs={[
              { label: 'Alerts', value: 'alerts', icon: <Bell className="size-3.5" /> },
              { label: 'Items', value: 'items', icon: <Database className="size-3.5" /> },
            ]}
            activeTab={tab}
            onTabChange={t => { setTab(t as Tab); setSelectedAlertId(null); setContentView('list') }}
            filters={itemFilters}
            searchValue={search}
            onSearchChange={setSearch}
            infinite={{
              hasNextPage: itemsHasMore,
              isFetchingNextPage: itemsFetchingMore,
              fetchNextPage: fetchNextItemsPage,
              total: itemsTotal,
            }}
          />
        )}
      </div>

      {/* Center panel — detail (always visible at lg+) */}
      <div className={cn(
        'flex-1 min-w-0 border-r flex-col h-full min-h-0',
        contentView === 'list' ? 'hidden lg:flex' : 'flex',
      )}>
        <AlertDetailPanel
          alertId={selectedAlertId}
          onBack={() => { setSelectedAlertId(null); setContentView('list') }}
          onStatusChange={loadAlerts}
        />
      </div>

      {/* Right panel — AI chat (xl+ only) */}
      <div className="xl:w-[400px] xl:shrink-0 xl:flex-none min-w-0 flex-col h-full min-h-0 hidden xl:flex">
        <ChatPanel />
      </div>
    </div>
  )
}
