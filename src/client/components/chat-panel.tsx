import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatContext, ChatMessageData, ChatModel, ToolCallData, ToolSideEffect } from '../types/chat'
import { streamChat } from '../lib/chat-stream'
import { ChatHeader } from './chat/chat-header'
import { WelcomeScreen } from './chat/welcome-screen'
import { ChatMessage } from './chat/chat-message'
import { ChatInput } from './chat/chat-input'

export type ChatSurface = 'right-pane' | 'detail-tab'

interface ChatPanelProps {
  surface?: ChatSurface
  context?: ChatContext
  onAgentSideEffect?: (effect: ToolSideEffect, source: ChatSurface) => void
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function ChatPanel({ surface = 'right-pane', context, onAgentSideEffect }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessageData[]>([])
  const [input, setInput] = useState('')
  const [model, setModel] = useState<ChatModel>('gpt-5.5')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setStreaming(false)
  }, [])


  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || streaming) return
    const userMessage: ChatMessageData = {
      id: makeId(),
      role: 'user',
      content: trimmed,
      toolCalls: [],
    }
    const assistantId = makeId()
    const assistantMessage: ChatMessageData = {
      id: assistantId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      streaming: true,
    }
    const nextHistory = [...messages, userMessage, assistantMessage]
    setMessages(nextHistory)
    setInput('')
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    const apiMessages = nextHistory
      .filter(m => !(m.role === 'assistant' && m.id === assistantId))
      .map(m => ({ role: m.role, content: m.content }))

    const updateAssistant = (mut: (msg: ChatMessageData) => ChatMessageData) => {
      setMessages(prev => prev.map(m => m.id === assistantId ? mut(m) : m))
    }

    try {
      await streamChat({
        messages: apiMessages,
        model,
        context,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            updateAssistant(m => ({ ...m, content: m.content + event.delta }))
          } else if (event.type === 'tool_start') {
            const step: ToolCallData = { id: event.tool_call_id, name: event.name, status: 'running' }
            updateAssistant(m => ({ ...m, toolCalls: [...m.toolCalls, step] }))
          } else if (event.type === 'tool_done') {
            updateAssistant(m => ({
              ...m,
              toolCalls: m.toolCalls.map(s => s.id === event.tool_call_id
                ? { ...s, status: 'done', args: event.args, summary: event.summary, preview: event.preview }
                : s),
            }))
            if (event.side_effect) {
              onAgentSideEffect?.(event.side_effect, surface)
            }
          } else if (event.type === 'error') {
            updateAssistant(m => ({ ...m, content: m.content + `\n\n_error: ${event.message}_` }))
          } else if (event.type === 'done') {
            updateAssistant(m => ({ ...m, streaming: false }))
          }
        },
      })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        updateAssistant(m => ({ ...m, content: m.content + `\n\n_error: ${String(err)}_`, streaming: false }))
      } else {
        updateAssistant(m => ({ ...m, streaming: false }))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [messages, model, streaming, context, onAgentSideEffect, surface])

  const handleSubmit = useCallback(() => send(input), [send, input])
  const handlePick = useCallback((text: string) => send(text), [send])

  return (
    <div className="flex flex-col h-full">
      <ChatHeader
        model={model}
        onModelChange={setModel}
        onReset={reset}
        canReset={messages.length > 0 || streaming}
      />
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <WelcomeScreen onPick={handlePick} />
        ) : (
          <div className="space-y-3">
            {messages.map(m => (
              <ChatMessage
                key={m.id}
                message={m}
              />
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t">
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          streaming={streaming}
        />
      </div>
    </div>
  )
}
