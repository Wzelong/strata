import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '../../lib/utils'

const MAX_HEIGHT = 200
const MOBILE_BREAKPOINT = 768

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
  const [mobile, setMobile] = useState(false)
  const [focused, setFocused] = useState(false)

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
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
  const minHeight = mobile ? (focused ? 84 : 56) : undefined

  return (
    <div className={cn('relative flex items-end bg-background px-1 py-1', className)}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || streaming}
        rows={1}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="flex-1 resize-none bg-transparent px-3 py-2 text-base md:text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50 transition-[min-height] duration-150"
        style={{ maxHeight: MAX_HEIGHT, minHeight }}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSend}
        className={cn(
          'mb-1.5 mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-full transition-colors',
          canSend ? 'bg-foreground text-background hover:bg-foreground/80 cursor-pointer' : 'bg-muted text-muted-foreground cursor-default',
        )}
      >
        <ArrowUp className="size-3.5" />
      </button>
    </div>
  )
}
