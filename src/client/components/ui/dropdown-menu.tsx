import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = 'start',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  selected,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { selected?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'relative flex items-center gap-2 rounded-sm px-2 py-1 text-xs cursor-pointer outline-none select-none',
        'focus:bg-accent focus:text-accent-foreground hover:bg-accent',
        className,
      )}
      {...props}
    >
      <span className="flex-1 truncate">{props.children}</span>
      {selected && <Check className="size-3" />}
    </DropdownMenuPrimitive.Item>
  )
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem }
