export type ClusterColorMap = Map<string, string>

export interface CodeUnitNode {
  id: string
  qualname: string
  symbol_name: string
  title?: string | null
  text?: string
  author?: string
  created_at?: number
  reply_count?: number
  thread_title?: string
  kind: string
  cluster_label: string | null
  hub_score: number
  thread_root_id?: string
  parent_id?: string | null
  x2d: number
  y2d: number
  x3d: number
  y3d: number
  z3d: number
}

export interface GraphEdge {
  source: string
  target: string
  edge_type: string
}

export interface GraphData {
  nodes: CodeUnitNode[]
  edges: GraphEdge[]
  meta?: {
    postCount: number
    commentCount: number
    clusterCount: number
    clusterSizeByLabel?: Record<string, number>
  }
}

export type HighlightSource = 'explorer' | 'graph' | 'chat' | 'impact'

export interface GraphHighlight {
  source: HighlightSource
  nodeIds: Set<string>
  edgeKeys: Set<string>
}

export type ImpactStatus = 'changed' | 'added' | 'deleted' | 'ripple' | 'unaffected'
