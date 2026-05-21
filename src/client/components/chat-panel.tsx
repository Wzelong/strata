import { MessageSquare } from 'lucide-react'

export function ChatPanel() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3">
      <MessageSquare className="h-10 w-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">AI assistant coming soon</p>
    </div>
  )
}
