import * as React from 'react'
import { DayPicker } from 'react-day-picker'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import 'react-day-picker/style.css'
import { cn } from '../../lib/utils'

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-0', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-4',
        month: 'space-y-3',
        month_caption: 'flex justify-center pt-1 relative items-center text-sm font-medium',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1',
        button_previous: 'absolute left-1 top-1 size-7 inline-flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer',
        button_next: 'absolute right-1 top-1 size-7 inline-flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground cursor-pointer',
        chevron: 'size-3.5',
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'text-muted-foreground rounded-md w-8 font-normal text-[0.7rem]',
        week: 'flex w-full mt-1',
        day: 'size-8 text-center text-xs p-0 relative',
        day_button: 'size-8 inline-flex items-center justify-center rounded-md hover:bg-accent hover:text-foreground transition-colors cursor-pointer aria-selected:opacity-100',
        range_start: 'rdp-range_start',
        range_end: 'rdp-range_end',
        range_middle: 'rdp-range_middle',
        selected: 'rdp-selected',
        today: 'font-semibold underline underline-offset-2',
        outside: 'text-muted-foreground/40',
        disabled: 'text-muted-foreground/40 cursor-not-allowed',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left' ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />,
      }}
      {...props}
    />
  )
}

export { Calendar }
