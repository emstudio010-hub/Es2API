import type { UsageCacheMetrics } from '@/types/panel-database'
import { EmptyState } from '@/components/empty-state'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import {
  formatMetricNumber,
  formatMetricPercent,
  formatMetricTime,
} from './metrics'

function ttlLabel(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value % 60_000 === 0) return `${value / 60_000} 分钟`
  return `${Math.round(value / 1000)} 秒`
}

function Detail({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 text-sm font-medium tabular-nums'>
        {formatMetricNumber(value)}
      </dd>
    </div>
  )
}

export function UsageCacheMetricsPanel({
  metrics,
}: {
  metrics: UsageCacheMetrics | null
}) {
  if (!metrics) {
    return (
      <PanelCard title='官方用量缓存' meta='进程内实例指标'>
        <EmptyState reason='网关当前未提供用量缓存统计；数据库快照仍可继续查看。' />
      </PanelCard>
    )
  }

  return (
    <PanelCard
      title='官方用量缓存'
      meta={`实例内累计 · 起点 ${formatMetricTime(metrics.since)}`}
      action={
        <span className='text-[11px] text-muted-foreground tabular-nums'>
          {formatMetricNumber(metrics.requests)} 次 load
        </span>
      }
    >
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-4'>
        <StatCell
          label='直接命中率'
          value={formatMetricPercent(metrics.hit_rate)}
          hint='成功命中 + 负缓存命中'
        />
        <StatCell
          label='复用率'
          value={formatMetricPercent(metrics.reuse_rate)}
          hint='直接命中 + singleflight'
        />
        <StatCell
          label='有效条目'
          value={`${formatMetricNumber(metrics.entries_fresh)} / ${formatMetricNumber(metrics.entries_total)}`}
          hint={`${formatMetricNumber(metrics.entries_stale)} 条已过期`}
        />
        <StatCell
          label='上游失败 / Fetch'
          value={`${formatMetricNumber(metrics.upstream_failures)} / ${formatMetricNumber(metrics.upstream_fetches)}`}
          hint={`${formatMetricNumber(metrics.inflight)} 个进行中`}
          valueClassName={
            metrics.upstream_failures > 0
              ? 'text-[color:var(--status-bad)]'
              : undefined
          }
        />
      </div>

      <dl className='grid grid-cols-2 gap-x-5 gap-y-3 border-t px-4 py-3 sm:grid-cols-4 xl:grid-cols-6'>
        <Detail label='成功命中' value={metrics.success_hits} />
        <Detail label='负缓存命中' value={metrics.error_hits} />
        <Detail label='未命中' value={metrics.misses} />
        <Detail label='请求合并' value={metrics.singleflight_joins} />
        <div>
          <dt className='text-[11px] text-muted-foreground'>成功 TTL</dt>
          <dd className='mt-0.5 text-sm font-medium tabular-nums'>
            {ttlLabel(metrics.success_ttl_ms)}
          </dd>
        </div>
        <div>
          <dt className='text-[11px] text-muted-foreground'>失败 TTL</dt>
          <dd className='mt-0.5 text-sm font-medium tabular-nums'>
            {ttlLabel(metrics.error_ttl_ms)}
          </dd>
        </div>
      </dl>

      <p className='border-t px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground'>
        负缓存命中表示复用了近期上游失败，不等同于业务成功；累计计数随网关进程或缓存实例重建归零。
      </p>
    </PanelCard>
  )
}
