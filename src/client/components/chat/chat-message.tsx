import { useState, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessageData } from '../../types/chat'
import { ReasoningSteps } from './reasoning-steps'
import { cn } from '../../lib/utils'

const THINKING_VERBS = [
  'Thinking', 'Triaging', 'Investigating', 'Scanning', 'Connecting',
  'Reasoning', 'Correlating', 'Surfacing', 'Reviewing', 'Digging',
]

function ThinkingIndicator() {
  const [verb, setVerb] = useState(() => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)])
  useEffect(() => {
    const id = setInterval(() => {
      setVerb(prev => {
        let next = prev
        while (next === prev) next = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)]
        return next
      })
    }, 3000)
    return () => clearInterval(id)
  }, [])
  return (
    <span key={verb} className="inline-block animate-fade-in">
      <span className="text-sm shimmer-text">{verb}…</span>
    </span>
  )
}

function StreamingMarkdown({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n').filter(l => l.trim().length > 0), [content])
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (count >= lines.length) return
    const id = setTimeout(() => setCount(c => Math.min(c + 1, lines.length)), 60)
    return () => clearTimeout(id)
  }, [count, lines.length])
  return (
    <div className="markdown markdown-stream break-words whitespace-normal">
      {lines.slice(0, count).map((line, i) => (
        <div key={i} className="animate-fade-in">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{line}</ReactMarkdown>
        </div>
      ))}
    </div>
  )
}

interface ChatMessageProps {
  message: ChatMessageData
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const hasContent = !isUser && message.content.trim().length > 0
  const hasRunningTool = !isUser && message.toolCalls.some(t => t.status === 'running')

  return (
    <div className={cn('w-full', isUser ? 'flex flex-col items-end' : 'flex flex-col items-start')}>
      <div className={cn(
        'py-2 text-sm min-w-0 break-words',
        isUser ? 'max-w-[88%] bg-muted px-3.5 rounded-2xl whitespace-pre-wrap' : 'max-w-[88%] w-[88%] bg-background px-1',
      )}>
        {isUser ? (
          message.content
        ) : (
          <>
            {message.toolCalls.length > 0 && (
              <div className="-ml-1">
                <ReasoningSteps steps={message.toolCalls} />
              </div>
            )}
            {hasContent && <StreamingMarkdown content={message.content} />}
            {message.streaming && !hasContent && !hasRunningTool && (
              <div className="-ml-1">
                <ThinkingIndicator />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
