import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'

function ringColor(tone: 'good' | 'usage', pct: number): string {
  if (tone === 'good')
    return pct <= 0 ? 'var(--status-none)' : 'var(--status-ok)'
  if (pct >= 100) return 'var(--status-bad)'
  if (pct >= 95) return 'var(--status-warn)'
  if (pct >= 85) return 'var(--status-caution)'
  return 'var(--status-ok)'
}

/** 小号进度环。对齐 index.html 的 `goodRing`/`quotaRing`（tone='good' 对应 goodRing）。 */
function KpiRing({
  pct,
  tone,
  size = 44,
}: {
  pct: number | null
  tone: 'good' | 'usage'
  size?: number
}) {
  if (pct == null) return null
  const p = Math.max(0, Math.min(100, Number(pct) || 0))
  const r = 18
  const c = 2 * Math.PI * r
  return (
    <svg
      viewBox='0 0 48 48'
      width={size}
      height={size}
      className='shrink-0'
      aria-hidden
    >
      <circle
        cx={24}
        cy={24}
        r={r}
        fill='none'
        stroke='var(--border)'
        strokeWidth={4}
      />
      <circle
        cx={24}
        cy={24}
        r={r}
        fill='none'
        stroke={ringColor(tone, p)}
        strokeWidth={4}
        strokeLinecap='round'
        strokeDasharray={c.toFixed(1)}
        strokeDashoffset={(c * (1 - p / 100)).toFixed(1)}
        transform='rotate(-90 24 24)'
      />
    </svg>
  )
}

/** KPI 卡（图标 + 标签 + 数值 + 环）。对齐 index.html 的 `kpi(label, valueHTML, ringPct, tone)`。 */
export function KpiCard({
  label,
  value,
  hint,
  ringPct,
  tone = 'usage',
  icon: Icon,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  ringPct?: number | null
  tone?: 'good' | 'usage'
  icon?: LucideIcon
}) {
  return (
    <Card className='gap-0 py-0 shadow-none'>
      <CardContent className='flex h-full items-center gap-3 px-4 py-3.5'>
        {Icon ? (
          <div className='hidden size-9 shrink-0 place-items-center rounded-lg bg-muted/70 sm:grid'>
            <Icon
              className='size-[18px] text-muted-foreground'
              strokeWidth={1.75}
              aria-hidden
            />
          </div>
        ) : null}
        <div className='min-w-0 flex-1'>
          <div className='text-[11.5px] leading-snug text-muted-foreground'>
            {label}
          </div>
          <div
            className={cn(
              'mt-0.5 text-[24px] leading-tight font-semibold tracking-tight tabular-nums'
            )}
          >
            {value}
          </div>
          {hint ? (
            <div className='mt-0.5 text-[11px] leading-snug text-muted-foreground'>
              {hint}
            </div>
          ) : null}
        </div>
        <KpiRing pct={ringPct ?? null} tone={tone} />
      </CardContent>
    </Card>
  )
}
