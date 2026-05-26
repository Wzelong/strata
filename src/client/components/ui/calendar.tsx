import * as React from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { DayPicker, getDefaultClassNames, type DayButton } from 'react-day-picker'
import { cn } from '../../lib/utils'

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  components,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('bg-background p-3', className)}
      captionLayout={captionLayout}
      classNames={{
        root: cn('w-fit', defaultClassNames.root),
        months: cn('relative flex flex-col gap-4 md:flex-row', defaultClassNames.months),
        month: cn('flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn('absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1', defaultClassNames.nav),
        button_previous: cn(
          'inline-flex items-center justify-center rounded-md size-8 p-0 hover:bg-accent hover:text-accent-foreground cursor-pointer aria-disabled:opacity-50',
          defaultClassNames.button_previous,
        ),
        button_next: cn(
          'inline-flex items-center justify-center rounded-md size-8 p-0 hover:bg-accent hover:text-accent-foreground cursor-pointer aria-disabled:opacity-50',
          defaultClassNames.button_next,
        ),
        month_caption: cn(
          'flex h-8 w-full items-center justify-center',
          defaultClassNames.month_caption,
        ),
        caption_label: cn('text-sm font-medium select-none', defaultClassNames.caption_label),
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn(
          'w-8 text-center text-[0.8rem] font-normal text-muted-foreground select-none',
          defaultClassNames.weekday,
        ),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        day: cn(
          'relative h-8 w-8 p-0 text-center text-sm select-none',
          defaultClassNames.day,
        ),
        range_start: cn('rounded-l-md bg-accent', defaultClassNames.range_start),
        range_middle: cn('rounded-none bg-accent', defaultClassNames.range_middle),
        range_end: cn('rounded-r-md bg-accent', defaultClassNames.range_end),
        today: cn('rounded-md bg-accent text-accent-foreground', defaultClassNames.today),
        outside: cn('text-muted-foreground opacity-50', defaultClassNames.outside),
        disabled: cn('text-muted-foreground opacity-50', defaultClassNames.disabled),
        hidden: cn('invisible', defaultClassNames.hidden),
        selected: cn('', defaultClassNames.selected),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => {
          if (orientation === 'left') return <ChevronLeftIcon className="size-4" />
          return <ChevronRightIcon className="size-4" />
        },
        DayButton: CalendarDayButton,
        ...components,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <button
      ref={ref}
      data-selected={modifiers.selected && !modifiers.range_middle}
      data-range-middle={modifiers.range_middle}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-md text-sm font-normal transition-colors cursor-pointer',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'data-[selected=true]:bg-foreground data-[selected=true]:text-background data-[selected=true]:hover:bg-foreground',
        'data-[range-middle=true]:bg-accent data-[range-middle=true]:text-accent-foreground data-[range-middle=true]:rounded-none',
        className,
      )}
      {...props}
    />
  )
}

export { Calendar }
