export type SyntheticCorpus = {
  subredditName: 'citysafety'
  rules: Rule[]
  items: CorpusItem[]
  groundTruth: GroundTruth
}

export type Rule = {
  id: string
  shortName: string
  description: string
  priority: number
}

export type CorpusItem = {
  id: string
  type: 'post' | 'comment'
  text: string
  authorId: string
  authorName: string
  createdAt: number
  threadRootId: string
  parentId: string | null
}

export type BrigadePattern = {
  patternId: string
  targetEntity: { type: string; canonical: string }
  itemIds: string[]
  windowMs: number
}

export type GroundTruth = {
  buriedConnections: BuriedConnection[]
  scamPatterns: ScamPattern[]
  ruleViolations: RuleViolation[]
  standouts: string[]
  distractors: string[]
  brigadePatterns?: BrigadePattern[]
}

export type BuriedConnection = {
  caseItemId: string
  connections: ConnectionEntry[]
}

export type ConnectionEntry = {
  connectedItemId: string
  difficulty: 'easy' | 'medium' | 'hard' | 'very-hard'
  expectedRelationship: 'CONFIRMS' | 'UPDATES' | 'TEMPORAL'
}

export type ScamPattern = {
  patternId: string
  sharedEntity: { type: string; canonical: string }
  itemIds: string[]
}

export type RuleViolation = {
  itemId: string
  violatesRule: string
}

// JSON Schemas for structured output (strict mode requires additionalProperties: false + all required)

type JsonSchema = Record<string, unknown>

export const distractorSchema: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          mentionedEntity: { type: 'string' },
          authorName: { type: 'string' },
        },
        required: ['text', 'mentionedEntity', 'authorName'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

export const scamPatternSchema: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          authorName: { type: 'string' },
        },
        required: ['text', 'authorName'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

export const ruleViolationSchema: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          authorName: { type: 'string' },
        },
        required: ['text', 'authorName'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

export const standoutSchema: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          authorName: { type: 'string' },
        },
        required: ['text', 'authorName'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

export const threadSchema: JsonSchema = {
  type: 'object',
  properties: {
    post: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        authorName: { type: 'string' },
      },
      required: ['text', 'authorName'],
      additionalProperties: false,
    },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          authorName: { type: 'string' },
          replyToIndex: { type: ['integer', 'null'] },
        },
        required: ['text', 'authorName', 'replyToIndex'],
        additionalProperties: false,
      },
    },
  },
  required: ['post', 'comments'],
  additionalProperties: false,
}

export const judgeSchema: JsonSchema = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          realism: { type: 'integer' },
          coherence: { type: 'integer' },
          onTopic: { type: 'integer' },
        },
        required: ['index', 'realism', 'coherence', 'onTopic'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
}
