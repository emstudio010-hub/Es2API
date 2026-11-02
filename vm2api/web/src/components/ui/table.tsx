import * as React from 'react'
import { cn } from '@/lib/utils'

const DensityContext = React.createContext<'default' | 'compact'>('default')

function Table({
  className,
  density = 'default',
  ...props
}: React.ComponentProps<'table'> & { density?: 'default' | 'compact' }) {
  return (
    <DensityContext.Provider value={density}>
      <div
        data-slot='table-container'
        className='relative w-full overflow-x-auto'
      >
        <table
          data-slot='table'
          data-density={density}
          className={cn('w-full caption-bottom text-sm', className)}
          {...props}
        />
      </div>
    </DensityContext.Provider>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot='table-header'
      className={cn('[&_tr]:border-b', className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot='table-body'
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot='table-footer'
      className={cn(
        'border-t bg-muted/50 font-medium [&>tr]:last:border-b-0',
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot='table-row'
      className={cn(
        'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        '[&_[data-row-actions]]:opacity-0 [&_[data-row-actions]]:transition-opacity',
        'focus-within:[&_[data-row-actions]]:opacity-100 hover:[&_[data-row-actions]]:opacity-100',
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  const density = React.useContext(DensityContext)
  return (
    <th
      data-slot='table-head'
      className={cn(
        'px-2 text-start align-middle font-medium whitespace-nowrap text-foreground *:[[role=checkbox]]:translate-y-0.5',
        density === 'compact' ? 'h-8 text-xs' : 'h-10',
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  const density = React.useContext(DensityContext)
  return (
    <td
      data-slot='table-cell'
      className={cn(
        'align-middle whitespace-nowrap *:[[role=checkbox]]:translate-y-0.5',
        density === 'compact' ? 'h-9 px-2 py-1' : 'p-2',
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot='table-caption'
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
