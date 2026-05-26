import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2 } from 'lucide-react'
import type { ChatMessageData } from '../../types/chat'
import { ReasoningSteps } from './reasoning-steps'
import { cn } from '../../lib/utils'

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
        'rounded-2xl py-2 text-sm',
        isUser ? 'max-w-[88%] bg-muted px-3.5' : 'max-w-[88%] w-[88%] bg-background px-1',
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
            {hasContent && (
              <div className="markdown break-words whitespace-normal">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              </div>
            )}
            {message.streaming && !hasContent && !hasRunningTool && (
              <div className="-ml-1 flex items-center gap-2 animate-in fade-in duration-300">
                <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">Thinking…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
