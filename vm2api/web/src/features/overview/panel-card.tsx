import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'

/**
 * 总览页统一的面板壳：标题行（title + meta + 右侧动作）+ 自排内容。
 * 取代此前「一堆同尺寸散卡」的做法——分区标题挂在面板上，说明跟动作走。
 */
export function PanelCard({
  title,
  meta,
  action,
  className,
  children,
}: {
  title: string
  meta?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn('gap-0 overflow-hidden py-0 shadow-none', className)}>
      <div className='flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2'>
        <div className='flex items-baseline gap-2'>
          <h3 className='text-[13px] font-semibold'>{title}</h3>
          {meta ? (
            <span className='text-[11px] text-muted-foreground'>{meta}</span>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}

/**
 * 面板内的指标格。配合 `gap-px bg-border/60` 的网格用：格与格之间露出
 * 1px 底色即 hairline，无需在每格上手排 border。
 */
export function StatCell({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  valueClassName?: string
}) {
  return (
    <div className='min-w-0 bg-card px-4 py-3'>
      <div className='text-[11.5px] text-muted-foreground'>{label}</div>
      <div
        className={cn(
          'mt-0.5 text-[20px] leading-tight font-semibold tracking-tight tabular-nums',
          valueClassName
        )}
      >
        {value}
      </div>
      {hint ? (
        <div className='mt-0.5 truncate text-[11px] text-muted-foreground'>
          {hint}
        </div>
      ) : null}
    </div>
  )
}
