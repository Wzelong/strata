export type ChatModel = 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.4-nano'

export interface ChatMessageData {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls: ToolCallData[]
  streaming?: boolean
}

export interface ToolCallData {
  id: string
  name: string
  args?: Record<string, unknown>
  summary?: string
  preview?: string
  status: 'running' | 'done' | 'error'
}

export type ToolSideEffect =
  | { type: 'select_alert'; alert_id: string }
  | { type: 'select_topic'; cluster_id: string; label: string }
  | { type: 'select_post'; post_id: string }
  | { type: 'select_comment'; comment_id: string; thread_root_id: string }
  | { type: 'highlight'; ids: string[] }

export interface ChatContext {
  view: 'alerts' | 'items' | 'clusters'
  detailTab?: 'overview' | 'explore' | 'chat'
  focus?: {
    kind: 'alert' | 'item' | 'topic'
    id: string
    label: string
  }
}

export type ChatStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; tool_call_id: string; name: string }
  | {
      type: 'tool_done'
      tool_call_id: string
      name: string
      args?: Record<string, unknown>
      summary?: string
      preview?: string
      side_effect?: ToolSideEffect
    }
  | { type: 'done' }
  | { type: 'error'; message: string }
