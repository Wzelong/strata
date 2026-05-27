import { useCallback, useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '../../lib/utils'

const MAX_HEIGHT = 200

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  streaming?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function ChatInput({ value, onChange, onSubmit, streaming, disabled, placeholder = 'Ask Strata...', className }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  useEffect(() => { resize() }, [value, resize])

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value)
    resize()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (value.trim() && !disabled && !streaming) onSubmit()
    }
  }

  const canSend = value.trim().length > 0 && !disabled && !streaming

  return (
    <div className={cn('flex items-end gap-1.5 border border-border bg-background rounded-lg px-2 py-1.5 focus-within:border-foreground/40 transition-colors', className)}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || streaming}
        rows={1}
        className="flex-1 min-w-0 resize-none bg-transparent px-1.5 py-1 text-base md:text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50"
        style={{ maxHeight: MAX_HEIGHT }}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSend}
        className={cn(
          'mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors',
          canSend ? 'bg-foreground text-background hover:bg-foreground/80 cursor-pointer' : 'bg-muted text-muted-foreground cursor-default',
        )}
      >
        <ArrowUp className="size-4" />
      </button>
    </div>
  )
}
