import { ChevronDown, RotateCcw } from 'lucide-react'
import type { ChatModel } from '../../types/chat'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu'

const MODELS: ChatModel[] = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']

interface ChatHeaderProps {
  model: ChatModel
  onModelChange: (model: ChatModel) => void
  onReset: () => void
  canReset: boolean
}

export function ChatHeader({ model, onModelChange, onReset, canReset }: ChatHeaderProps) {
  return (
    <div className="shrink-0 h-10 border-b px-3 flex items-center justify-between">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer outline-none">
            <span>{model}</span>
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {MODELS.map(m => (
            <DropdownMenuItem
              key={m}
              selected={m === model}
              onSelect={() => onModelChange(m)}
            >
              {m}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={onReset}
        disabled={!canReset}
        aria-label="New chat"
        className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        <RotateCcw className="size-3.5" />
      </button>
    </div>
  )
}
