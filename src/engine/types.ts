import type OpenAI from 'openai'

export type Decision = 'pending' | 'approved' | 'removed' | 'distinguished'
export type Relationship = 'CONFIRMS' | 'CONTRADICTS' | 'UPDATES' | 'TEMPORAL' | 'UNRELATED'

export type Entity = {
  type: string
  surfaceText: string
}

export type Scope = 'global' | 'local'

export type Item = {
  id: string
  type: 'post' | 'comment'
  title?: string
  text: string
  textNormalized: string
  authorId: string
  authorName: string
  createdAt: number
  threadRootId: string
  parentId: string | null
  embedding: number[]
  entities: Entity[]
  decision: Decision
  decisionAt: number | null
  decisionBy: string | null
  decisionReason: string | null
  position3d?: [number, number, number]
  clusterId?: number
}

export type LayoutCluster = {
  id: number
  label: string
  size: number
}

export type RawItem = {
  id: string
  type: 'post' | 'comment'
  title?: string
  text: string
  authorId: string
  authorName: string
  createdAt: number
  threadRootId: string
  parentId: string | null
}

export type Rule = {
  id: string
  shortName: string
  description: string
  embedding: number[]
  priority: number
}

export type RuleInput = {
  id: string
  shortName: string
  description: string
  priority: number
}

export type Hit = {
  item: Item
  weight: number
}

export type Recommendation = {
  recommendation: 'remove' | 'approve' | 'skip'
  rationale: string
  ruleId: string | null
}

export type SearchFilter = {
  decision?: Decision[]
  maxAge?: number
  excludeIds?: Set<string>
}


export type StoredItem = Omit<Item, 'embedding'>

export type StoredRule = {
  id: string
  shortName: string
  description: string
  embedding: number[]
  priority: number
}

export type CostTracker = {
  track(usage: { input_tokens?: number; output_tokens?: number } | null | undefined): void
  total: number
}

export type AlertMode = 'surface' | 'flag'
export type AlertStatus = 'pending' | 'resolved' | 'dismissed'
export type AlertConfidence = 'high' | 'review'
export type FlagType = 'rule' | 'pattern' | 'brigade' | 'contradiction'

export type AlertEntity = {
  text: string
  clusterId: string
}

export type Alert = {
  id: string
  mode: AlertMode
  status: AlertStatus
  confidence: AlertConfidence
  connectionCount: number
  createdAt: number
  anchorId: string
  anchorAuthor: string
  anchorType: 'post' | 'comment'
  anchorTitle?: string
  anchorText: string
  anchorPermalink: string
  anchorEntities: AlertEntity[]
  reasoning?: string
  flagType?: FlagType
}

export type AlertConnection = {
  itemId: string
  author: string
  type: 'post' | 'comment'
  title?: string
  text: string
  permalink: string
  classification: 'confirms' | 'updates' | 'temporal' | 'contradicts'
  confidence: 'high' | 'review'
  entities: AlertEntity[]
  reasoning: string
  createdAt: number
  sameAuthor?: boolean
}

export type FlagResult = {
  type: FlagType
  confidence: AlertConfidence
  reasoning: string
  anchorId: string
  connectionItems: Item[]
  ruleId?: string
}
