import type { ChatContext, ChatModel, ChatStreamEvent } from '../types/chat.js'

interface StreamChatOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  model: ChatModel
  context?: ChatContext
  signal?: AbortSignal
  onEvent: (event: ChatStreamEvent) => void
}

export async function streamChat({ messages, model, context, signal, onEvent }: StreamChatOptions): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model, context }),
    signal,
  })
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', message: `HTTP ${res.status}` })
    onEvent({ type: 'done' })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const event = parseSSEBlock(block)
      if (event) onEvent(event)
    }
  }
}

function parseSSEBlock(block: string): ChatStreamEvent | null {
  let eventName = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  let payload: any
  try { payload = JSON.parse(dataLines.join('\n')) } catch { return null }
  return { type: eventName, ...payload } as ChatStreamEvent
}
