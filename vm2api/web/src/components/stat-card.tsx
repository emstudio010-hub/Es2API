import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type StatCardTone = 'neutral' | 'caution' | 'warn' | 'bad'

const TONE_BAR: Record<Exclude<StatCardTone, 'neutral'>, string> = {
  caution: 'border-l-2 border-l-[color:var(--status-caution)]',
  warn: 'border-l-2 border-l-[color:var(--status-warn)]',
  bad: 'border-l-2 border-l-[color:var(--status-bad)]',
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: StatCardTone
}) {
  return (
    <Card className={cn('shadow-none', tone !== 'neutral' && TONE_BAR[tone])}>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className='text-2xl font-semibold tabular-nums'>{value}</div>
        {hint ? <p className='text-xs text-muted-foreground'>{hint}</p> : null}
      </CardContent>
    </Card>
  )
}
