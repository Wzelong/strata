import { useMemo, useState, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { Stars as DreiStars } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useTheme } from '../../hooks/use-theme'
import { buildClusterColorMap, highlightNode } from '../../lib/graph-utils'
import { NodeCloud } from './node-cloud'
import { ClusterLabels } from './graph-labels'
import { CameraRig } from './camera-rig'
import { EdgeLines } from './edge-lines'
import { GraphStats } from './graph-toggles'
import { NodeCard } from './node-card'
import { TimelineCard } from './timeline-card'
import type { GraphData, GraphHighlight, CodeUnitNode } from '../../types/graph'

export function GraphCanvas({
  highlightIds,
  hideCard,
  threadAnchorId,
  onReset: parentReset,
  onNodeSelect,
}: {
  highlightIds?: string[]
  hideCard?: boolean
  threadAnchorId?: string
  onReset?: () => void
  onNodeSelect?: (nodeId: string) => void
} = {}) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const bgColor = isDark ? '#0a0a0a' : '#ffffff'

  const [data, setData] = useState<GraphData | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<GraphHighlight | null>(null)
  const [cardIndex, setCardIndex] = useState(0)
  const [threadComments, setThreadComments] = useState<CodeUnitNode[]>([])
  const [tCurrent, setTCurrent] = useState<number>(Number.POSITIVE_INFINITY)

  useEffect(() => {
    fetch('/api/graph')
      .then(r => r.json())
      .then((d: GraphData) => setData(d))
      .catch(() => setData({ nodes: [], edges: [] }))
  }, [])

  useEffect(() => {
    if (!highlightIds || highlightIds.length === 0) { setHighlight(null); return }
    const expanded = new Set(highlightIds)
    if (data) {
      for (const e of data.edges) {
        if (highlightIds.includes(e.source)) expanded.add(e.target)
      }
    }
    setHighlight({ source: 'explorer', nodeIds: expanded, edgeKeys: new Set() })
    setCardIndex(0)
  }, [highlightIds, data])

  const clusterColors = useMemo(
    () => (data ? buildClusterColorMap(data.nodes, isDark) : new Map<string, string>()),
    [data, isDark],
  )

  const liveStats = useMemo(() => {
    if (!data) return { posts: 0, comments: 0, clusters: 0 }
    let posts = 0
    let comments = 0
    const clusterSet = new Set<string>()
    for (const n of data.nodes) {
      if (n.created_at != null && n.created_at > tCurrent) continue
      if (n.kind === 'post') posts++
      else if (n.kind === 'comment') comments++
      if (n.cluster_label) clusterSet.add(n.cluster_label)
    }
    return { posts, comments, clusters: clusterSet.size }
  }, [data, tCurrent])

  const posMap = useMemo(() => {
    const map = new Map<string, [number, number, number]>()
    if (data) for (const n of data.nodes) map.set(n.id, [n.x3d, n.y3d, n.z3d])
    return map
  }, [data])

  const createdAtById = useMemo(() => {
    const m = new Map<string, number>()
    if (data) for (const n of data.nodes) if (n.created_at != null) m.set(n.id, n.created_at)
    return m
  }, [data])

  const timeBounds = useMemo(() => {
    if (!data) return null
    let min = Infinity
    let max = -Infinity
    for (const n of data.nodes) {
      if (n.created_at == null) continue
      if (n.created_at < min) min = n.created_at
      if (n.created_at > max) max = n.created_at
    }
    return min === Infinity ? null : { min, max }
  }, [data])

  useEffect(() => {
    if (timeBounds) setTCurrent(timeBounds.max)
  }, [timeBounds])

  const commentParentEdges = useMemo(() => {
    if (!data || !highlight) return []
    const edges: { source: string; target: string }[] = []
    for (const n of data.nodes) {
      if (n.kind !== 'comment' || !highlight.nodeIds.has(n.id) || !n.thread_root_id) continue
      if ((n.created_at ?? 0) > tCurrent) continue
      if ((createdAtById.get(n.thread_root_id) ?? 0) > tCurrent) continue
      edges.push({ source: n.id, target: n.thread_root_id })
    }
    return edges
  }, [data, highlight, tCurrent, createdAtById])

  const highlightedClusterLabels = useMemo(() => {
    if (!data || !highlight) return undefined
    const labels = new Set<string>()
    for (const n of data.nodes) {
      if (n.cluster_label && highlight.nodeIds.has(n.id)) labels.add(n.cluster_label)
    }
    return labels
  }, [data, highlight])

  const selectedNode = useMemo(() => {
    if (!data || !selectedNodeId) return null
    return data.nodes.find(n => n.id === selectedNodeId) ?? null
  }, [data, selectedNodeId])

  const focusNodes: CodeUnitNode[] | null = useMemo(() => {
    if (!data) return null
    if (selectedNode) return [selectedNode]
    if (!highlight) return null
    const all = data.nodes.filter(n => highlight.nodeIds.has(n.id))
    if (highlightIds && highlightIds.length > 1 && cardIndex > 0) {
      const target = data.nodes.find(n => n.id === highlightIds[cardIndex])
      if (target) return [target]
    }
    return all
  }, [data, selectedNode, highlight, highlightIds, cardIndex])

  const threadPostNode = useMemo<CodeUnitNode | null>(() => {
    if (!data) return null
    if (selectedNode?.kind === 'post') return selectedNode
    if (threadAnchorId) {
      const n = data.nodes.find(n => n.id === threadAnchorId)
      return n?.kind === 'post' ? n : null
    }
    return null
  }, [data, selectedNode, threadAnchorId])

  useEffect(() => {
    if (!threadPostNode) { setThreadComments([]); return }
    let cancelled = false
    fetch(`/api/threads/${threadPostNode.id}`)
      .then(r => r.json())
      .then((r: { comments: CodeUnitNode[] }) => { if (!cancelled) setThreadComments(r.comments ?? []) })
      .catch(() => { if (!cancelled) setThreadComments([]) })
    return () => { cancelled = true }
  }, [threadPostNode])

  const cardNodes = useMemo<CodeUnitNode[]>(() => {
    if (!data) return []
    if (threadPostNode) return [threadPostNode, ...threadComments]
    if (selectedNode) return [selectedNode]
    if (!highlightIds) return []
    const byId = new Map(data.nodes.map(n => [n.id, n]))
    return highlightIds.map(id => byId.get(id)).filter((n): n is CodeUnitNode => !!n)
  }, [data, threadPostNode, threadComments, selectedNode, highlightIds])

  const safeCardIndex = Math.min(cardIndex, Math.max(0, cardNodes.length - 1))
  const currentCardNode = cardNodes[safeCardIndex] ?? null

  const handleNodeClick = useCallback((nodeId: string) => {
    if (!data) return
    if (!hideCard && !threadAnchorId && highlightIds && highlightIds.length > 0) {
      const idx = highlightIds.indexOf(nodeId)
      if (idx >= 0) { setCardIndex(idx); return }
    }
    const node = data.nodes.find(n => n.id === nodeId)
    const targetId = node?.kind === 'comment' && node.thread_root_id ? node.thread_root_id : nodeId
    if (onNodeSelect) { onNodeSelect(targetId); return }
    setSelectedNodeId(targetId)
    setHighlight(highlightNode(data, targetId, 1))
    setCardIndex(0)
  }, [data, highlightIds, onNodeSelect, hideCard, threadAnchorId])

  const handleReset = useCallback(() => {
    setSelectedNodeId(null)
    setHighlight(null)
    parentReset?.()
  }, [parentReset])

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Loading graph...
      </div>
    )
  }

  return (
    <div className="flex-1 relative" style={{ backgroundColor: bgColor }}>
      <GraphStats
        postCount={liveStats.posts}
        commentCount={liveStats.comments}
        clusterCount={liveStats.clusters}
        isHighlighted={!!highlight}
        onReset={handleReset}
      />
      {timeBounds && (
        <TimelineCard
          minTs={timeBounds.min}
          maxTs={timeBounds.max}
          tCurrent={tCurrent}
          onChange={setTCurrent}
        />
      )}
      <Canvas
        camera={{ position: [0, 0, 0], near: 0.01, far: 1000 }}
        gl={{
          antialias: true,
          toneMapping: isDark ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping,
          toneMappingExposure: 1,
        }}
      >
        <color attach="background" args={[bgColor]} />
        <ambientLight intensity={isDark ? 0.2 : 1.5} />
        {isDark && (
          <DreiStars radius={200} depth={40} count={5000} factor={4} saturation={0} fade speed={1} />
        )}

        <NodeCloud
          nodes={data.nodes}
          clusterColors={clusterColors}
          isDark={isDark}
          highlight={highlight}
          onNodeClick={handleNodeClick}
          bgColor={bgColor}
          tCurrent={tCurrent}
        />

        <ClusterLabels
          nodes={data.nodes}
          clusterColors={clusterColors}
          isDark={isDark}
          onlyLabels={highlightedClusterLabels}
          tCurrent={tCurrent}
        />

        {commentParentEdges.length > 0 && (
          <EdgeLines edges={commentParentEdges} posMap={posMap} isDark={isDark} />
        )}

        <CameraRig nodes={data.nodes} focusNodes={focusNodes} />

        {isDark && (
          <EffectComposer>
            <Bloom
              kernelSize={5}
              luminanceThreshold={0.6}
              luminanceSmoothing={0.4}
              intensity={0.35}
              radius={0.4}
            />
          </EffectComposer>
        )}
      </Canvas>
      {!hideCard && currentCardNode && (
        <NodeCard
          node={currentCardNode}
          clusterColor={currentCardNode.cluster_label ? clusterColors.get(currentCardNode.cluster_label) : undefined}
          orphanColor={isDark ? '#94a3b8' : '#64748b'}
          index={safeCardIndex}
          total={cardNodes.length}
          onPrev={() => setCardIndex(i => Math.max(0, i - 1))}
          onNext={() => setCardIndex(i => Math.min(cardNodes.length - 1, i + 1))}
        />
      )}
    </div>
  )
}
