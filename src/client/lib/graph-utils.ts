import type { GraphEdge, GraphHighlight, CodeUnitNode, ClusterColorMap, GraphData } from '../types/graph.js'

const GOLDEN_ANGLE = 137.508

export function edgeKey(e: GraphEdge): string {
  return `${e.source}::${e.target}::${e.edge_type}`
}

export function buildAdjacency(edges: GraphEdge[]) {
  const outgoing = new Map<string, GraphEdge[]>()
  const incoming = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    const out = outgoing.get(e.source)
    if (out) out.push(e); else outgoing.set(e.source, [e])
    const inc = incoming.get(e.target)
    if (inc) inc.push(e); else incoming.set(e.target, [e])
  }
  return { outgoing, incoming }
}

function collectNeighbors(edges: GraphEdge[], seedIds: Set<string>, depth: number): { nodeIds: Set<string>; edgeKeys: Set<string> } {
  const nodeIds = new Set(seedIds)
  const collectedEdges = new Set<string>()
  const { outgoing, incoming } = buildAdjacency(edges)
  let frontier = new Set(seedIds)
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>()
    for (const id of frontier) {
      for (const e of outgoing.get(id) ?? []) {
        collectedEdges.add(edgeKey(e))
        if (!nodeIds.has(e.target)) { nodeIds.add(e.target); next.add(e.target) }
      }
      for (const e of incoming.get(id) ?? []) {
        collectedEdges.add(edgeKey(e))
        if (!nodeIds.has(e.source)) { nodeIds.add(e.source); next.add(e.source) }
      }
    }
    frontier = next
    if (frontier.size === 0) break
  }
  return { nodeIds, edgeKeys: collectedEdges }
}

export function highlightNode(data: GraphData, nodeId: string, depth = 1): GraphHighlight {
  const { nodeIds, edgeKeys } = collectNeighbors(data.edges, new Set([nodeId]), depth)
  return { source: 'graph', nodeIds, edgeKeys }
}

export interface ClusterEdge {
  source: string
  target: string
  edge_type: string
  clusterLabel: string
}

export function getIntraClusterEdges(nodes: CodeUnitNode[], edges: GraphEdge[]): ClusterEdge[] {
  const nodeCluster = new Map<string, string>()
  for (const n of nodes) if (n.cluster_label) nodeCluster.set(n.id, n.cluster_label)
  const result: ClusterEdge[] = []
  for (const e of edges) {
    const srcCluster = nodeCluster.get(e.source)
    const tgtCluster = nodeCluster.get(e.target)
    if (srcCluster && tgtCluster && srcCluster === tgtCluster) {
      result.push({ source: e.source, target: e.target, edge_type: e.edge_type, clusterLabel: srcCluster })
    }
  }
  return result
}

const labelHueCache = new Map<string, number>()

export function buildClusterColorMap(nodes: CodeUnitNode[], isDark = true): ClusterColorMap {
  const labels = [...new Set(nodes.map(n => n.cluster_label).filter((l): l is string => l !== null))].sort()
  for (const label of labels) {
    if (!labelHueCache.has(label)) {
      labelHueCache.set(label, (labelHueCache.size * GOLDEN_ANGLE) % 360)
    }
  }
  const map: ClusterColorMap = new Map()
  const L = isDark ? 0.74 : 0.58
  const C = isDark ? 0.16 : 0.17
  for (const label of labels) {
    const hue = labelHueCache.get(label)!
    map.set(label, oklchToHex(L, C, hue))
  }
  return map
}

function oklchToHex(L: number, C: number, h: number): string {
  const hRad = (h * Math.PI) / 180
  const a = C * Math.cos(hRad)
  const b = C * Math.sin(hRad)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l3 = l_ * l_ * l_, m3 = m_ * m_ * m_, s3 = s_ * s_ * s_
  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  let bv = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
  const toSRGB = (v: number) => {
    const x = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055
    return Math.max(0, Math.min(1, x))
  }
  r = toSRGB(r); g = toSRGB(g); bv = toSRGB(bv)
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(bv)}`
}
