import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Bell, Hash, PenTool, Stamp, Ban, Check, X, Waypoints, Telescope, Sparkles } from 'lucide-react'
import { DataList, type FilterConfig } from './data-list'
import { AlertDetailPanel } from './alert-detail'
import { ChatPanel, type ChatSurface } from './chat-panel'
import type { ChatContext, ToolSideEffect } from '../types/chat'
import { fetchAlerts, fetchItems, fetchClusters, alertAction, type AlertListItem, type ItemListItem, type ClusterListItem } from '../lib/api'
import { buildClusterColorMap } from '../lib/graph-utils'
import { useTheme } from '../hooks/use-theme'
import { cn, formatRelativeTime, compactCount } from '../lib/utils'

type Tab = 'alerts' | 'items' | 'clusters'
type ContentView = 'list' | 'detail'

const PAGE_SIZE = 50

export function Dashboard() {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [tab, setTab] = useState<Tab>('alerts')
  const [contentView, setContentView] = useState<ContentView>('list')
  const [requestedDetailTab, setRequestedDetailTab] = useState<'overview' | 'explore' | 'chat' | null>(null)
  const [highlightRequest, setHighlightRequest] = useState<{ ids: string[]; version: number } | null>(null)
  const [alerts, setAlerts] = useState<AlertListItem[]>([])
  const [alertsLoading, setAlertsLoading] = useState(true)
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null)

  const [clusters, setClusters] = useState<ClusterListItem[]>([])
  const [clustersLoading, setClustersLoading] = useState(false)

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
      if (typeFilter === 'surface') filtered = filtered.filter(a => a.mode === 'surface')
      if (typeFilter === 'brigade') filtered = filtered.filter(a => a.mode === 'flag' && a.flagType === 'brigade')
      setAlerts(filtered)
    } catch { setAlerts([]) }
    setAlertsLoading(false)
  }, [statusFilter, confidenceFilter, typeFilter])

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
        type: 'post',
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
  }, [search])

  useEffect(() => { loadAlerts() }, [loadAlerts])

  const initialSelectionRef = useRef(false)
  useEffect(() => {
    if (initialSelectionRef.current) return
    if (alertsLoading) return
    if (alerts.length === 0) return
    initialSelectionRef.current = true
    setSelectedAlertId(alerts[0].id)
    setContentView('detail')
  }, [alerts, alertsLoading])

  const loadClusters = useCallback(async () => {
    setClustersLoading(true)
    try {
      setClusters(await fetchClusters())
    } catch { setClusters([]) }
    setClustersLoading(false)
  }, [])

  useEffect(() => {
    if (tab === 'clusters') loadClusters()
  }, [tab, loadClusters])

  useEffect(() => {
    if (tab === 'items') loadItemsPage(undefined, true)
  }, [tab])

  useEffect(() => {
    if (tab !== 'items' || !selectedItemId) return
    if (items.some(i => i.id === selectedItemId)) return
    if (itemsHasMore && !itemsFetchingMore && itemsCursor) loadItemsPage(itemsCursor, false)
  }, [selectedItemId, items, itemsHasMore, itemsFetchingMore, itemsCursor, tab, loadItemsPage])

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
      label: 'Type',
      value: typeFilter,
      options: [
        { value: 'surface', label: 'Surface' },
        { value: 'brigade', label: 'Brigade' },
      ],
      onChange: v => { setTypeFilter(v || null); setSelectedIds(new Set()) },
    },
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

  const itemFilters: FilterConfig[] = []

  const renderAlertItem = (alert: AlertListItem) => {
    const reviewed = alert.status === 'resolved' || alert.status === 'dismissed'
    const typeLabel = alert.mode === 'surface'
      ? 'Surface'
      : alert.flagType
        ? alert.flagType[0].toUpperCase() + alert.flagType.slice(1)
        : 'Flag'

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
          <div className="text-sm truncate">
            {(alert.anchorType === 'post' && alert.anchorTitle) ? alert.anchorTitle : alert.anchorText.slice(0, 80)}
          </div>
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
      <div className="text-sm truncate">
        {item.title || item.text.slice(0, 100)}
      </div>
      <div className="text-xs text-muted-foreground truncate mt-0.5">
        u/{item.authorName} · {formatRelativeTime(item.createdAt)} · {compactCount(item.commentCount ?? 0)} comments
      </div>
    </div>
  )

  const clusterColors = useMemo(() => {
    const pseudoNodes = clusters
      .filter(c => !c.isOrphan)
      .map(c => ({ cluster_label: c.label } as never))
    return buildClusterColorMap(pseudoNodes, isDark)
  }, [clusters, isDark])

  const orphanDotColor = isDark ? '#94a3b8' : '#64748b'

  const renderClusterRow = (cluster: ClusterListItem) => {
    const color = cluster.isOrphan ? orphanDotColor : clusterColors.get(cluster.label) ?? orphanDotColor
    return (
      <div className="flex items-start gap-1.5 min-w-0">
        <span className="size-3 shrink-0 inline-flex items-center justify-center mt-[5px]">
          <span className="size-1.5 rounded-full" style={{ background: color }} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{cluster.label}</div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {compactCount(cluster.postCount)} posts · {compactCount(cluster.commentCount)} comments
            {cluster.recentCount > 0 && ` · ${compactCount(cluster.recentCount)} in 24h`}
            {cluster.lastActivity > 0 && ` · ${formatRelativeTime(cluster.lastActivity)}`}
          </div>
        </div>
      </div>
    )
  }

  const sharedTabs = [
    { label: 'Alerts', value: 'alerts', icon: <Bell className="size-3.5" /> },
    { label: 'Posts', value: 'items', icon: <PenTool className="size-3.5" /> },
    { label: 'Topics', value: 'clusters', icon: <Hash className="size-3.5" /> },
  ]

  const switchTab = (t: string) => {
    setTab(t as Tab)
    setSelectedAlertId(null)
    setSelectedItemId(null)
    setSelectedClusterId(null)
    setContentView('list')
  }

  const openDetailView = (tab: 'explore' | 'chat') => {
    setSelectedAlertId(null)
    setSelectedItemId(null)
    setSelectedClusterId(null)
    setRequestedDetailTab(tab)
    setContentView('detail')
  }

  const highlightVersion = useRef(0)
  const handleAgentSideEffect = useCallback((effect: ToolSideEffect, source: ChatSurface) => {
    switch (effect.type) {
      case 'select_alert':
        setSelectedAlertId(effect.alert_id)
        setSelectedItemId(null)
        setSelectedClusterId(null)
        setTab('alerts')
        setContentView('detail')
        break
      case 'select_topic':
        setSelectedClusterId(effect.cluster_id)
        setSelectedAlertId(null)
        setSelectedItemId(null)
        setTab('clusters')
        setContentView('detail')
        break
      case 'select_post':
        setSelectedItemId(effect.post_id)
        setSelectedAlertId(null)
        setSelectedClusterId(null)
        setTab('items')
        setContentView('detail')
        break
      case 'select_comment':
        setSelectedItemId(effect.thread_root_id)
        setSelectedAlertId(null)
        setSelectedClusterId(null)
        setTab('items')
        setContentView('detail')
        break
      case 'highlight':
        highlightVersion.current += 1
        setHighlightRequest({ ids: effect.ids, version: highlightVersion.current })
        if (source === 'right-pane') setRequestedDetailTab('explore')
        setContentView('detail')
        break
    }
  }, [])

  const toolbarButtons = [
    {
      icon: <Telescope className="size-3.5" />,
      onClick: () => openDetailView('explore'),
      ariaLabel: 'View graph',
      className: 'lg:hidden',
    },
    {
      icon: <Sparkles className="size-3.5" />,
      onClick: () => openDetailView('chat'),
      ariaLabel: 'AI chat',
      className: 'lg:hidden',
    },
  ]

  const hasDetail = tab === 'alerts' && selectedAlertId

  const chatContext = useMemo<ChatContext>(() => {
    if (selectedAlertId) {
      const a = alerts.find(x => x.id === selectedAlertId)
      const label = a ? (a.anchorTitle || a.anchorText.slice(0, 80)) : selectedAlertId
      return { view: tab, focus: { kind: 'alert', id: selectedAlertId, label } }
    }
    if (selectedItemId) {
      const it = items.find(x => x.id === selectedItemId)
      const label = it ? (it.title || it.text.slice(0, 80)) : selectedItemId
      return { view: tab, focus: { kind: 'item', id: selectedItemId, label } }
    }
    if (selectedClusterId) {
      const c = clusters.find(x => x.id === selectedClusterId)
      return { view: tab, focus: { kind: 'topic', id: selectedClusterId, label: c?.label ?? selectedClusterId } }
    }
    return { view: tab }
  }, [tab, selectedAlertId, selectedItemId, selectedClusterId, alerts, items, clusters])

  return (
    <div className="flex h-full">
      {/* Left panel — list */}
      <div className={cn(
        'shrink-0 lg:w-[280px] flex-1 lg:flex-none border-r flex-col h-full min-h-0 relative',
        contentView !== 'list' ? 'hidden lg:flex' : 'flex',
      )}>
        {tab === 'alerts' ? (
          <DataList
            data={alerts}
            getItemId={a => a.id}
            renderItem={renderAlertItem}
            activeId={selectedAlertId ?? undefined}
            onItemClick={a => { setSelectedAlertId(a.id); setSelectedItemId(null); setSelectedClusterId(null); setContentView('detail') }}
            isLoading={alertsLoading}
            emptyIcon={<Bell className="size-6 text-muted-foreground" />}
            emptyMessage={alertsLoading ? 'Loading alerts...' : 'No alerts yet'}
            tabs={sharedTabs}
            activeTab={tab}
            onTabChange={switchTab}
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
            toolbarButtons={toolbarButtons}
            scrollToId={selectedAlertId}
          />
        ) : tab === 'items' ? (
          <DataList
            data={items}
            getItemId={i => i.id}
            renderItem={renderItemRow}
            activeId={selectedItemId ?? undefined}
            onItemClick={i => { setSelectedItemId(i.id); setSelectedAlertId(null); setSelectedClusterId(null); setContentView('detail') }}
            isLoading={itemsLoading}
            emptyIcon={<PenTool className="size-6 text-muted-foreground" />}
            emptyMessage={itemsLoading ? 'Loading items...' : 'No items ingested'}
            tabs={sharedTabs}
            activeTab={tab}
            onTabChange={switchTab}
            filters={itemFilters}
            searchValue={search}
            onSearchChange={setSearch}
            infinite={{
              hasNextPage: itemsHasMore,
              isFetchingNextPage: itemsFetchingMore,
              fetchNextPage: fetchNextItemsPage,
              total: itemsTotal,
            }}
            scrollToId={selectedItemId}
            toolbarButtons={toolbarButtons}
          />
        ) : (
          <DataList
            data={clusters}
            getItemId={c => c.id}
            renderItem={renderClusterRow}
            activeId={selectedClusterId ?? undefined}
            onItemClick={c => { setSelectedClusterId(c.id); setSelectedAlertId(null); setSelectedItemId(null); setContentView('detail') }}
            isLoading={clustersLoading}
            emptyIcon={<Hash className="size-6 text-muted-foreground" />}
            emptyMessage={clustersLoading ? 'Loading topics...' : 'No topics'}
            tabs={sharedTabs}
            activeTab={tab}
            onTabChange={switchTab}
            filters={[]}
            searchValue={search}
            onSearchChange={setSearch}
            toolbarButtons={toolbarButtons}
            scrollToId={selectedClusterId}
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
          itemId={selectedItemId}
          clusterId={selectedClusterId}
          listTab={tab}
          requestedTab={requestedDetailTab}
          onTabConsumed={() => setRequestedDetailTab(null)}
          highlightRequest={highlightRequest}
          chatContext={chatContext}
          onBack={() => { setSelectedAlertId(null); setSelectedItemId(null); setSelectedClusterId(null); setContentView('list') }}
          onStatusChange={loadAlerts}
          onGraphNodeSelect={id => { setSelectedAlertId(null); setSelectedClusterId(null); setSelectedItemId(id); setTab('items'); setContentView('detail') }}
          onAgentSideEffect={handleAgentSideEffect}
        />
      </div>

      {/* Right panel — AI chat (xl+ only) */}
      <div className="xl:w-[400px] xl:shrink-0 xl:flex-none min-w-0 flex-col h-full min-h-0 hidden xl:flex">
        <ChatPanel surface="right-pane" context={chatContext} onAgentSideEffect={handleAgentSideEffect} />
      </div>
    </div>
  )
}
