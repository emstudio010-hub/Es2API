import type { DatabaseRuntimeMetrics } from '@/types/panel-database'
import { StatusMark } from '@/components/status-mark'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import {
  formatMetricBytes,
  formatMetricNumber,
  formatMetricPercent,
  formatMetricTime,
} from './metrics'

function latency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value < 10) return `${value.toFixed(2)}ms`
  return `${Math.round(value)}ms`
}

function synchronousLabel(value: number | null): string {
  if (value == null) return '—'
  return ['OFF', 'NORMAL', 'FULL', 'EXTRA'][value] || String(value)
}

function timeout(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}s`
  return `${value.toLocaleString()}ms`
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0'>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 truncate text-sm font-medium tabular-nums'>
        {value}
      </dd>
    </div>
  )
}

export function DatabaseOverview({
  metrics,
  sampledAt,
}: {
  metrics: DatabaseRuntimeMetrics
  sampledAt: string | null
}) {
  const pageUse =
    metrics.used_pages == null && metrics.page_count == null
      ? '—'
      : `${formatMetricNumber(metrics.used_pages)} / ${formatMetricNumber(metrics.page_count)}`

  return (
    <PanelCard
      title='数据库运行态'
      meta={sampledAt ? `采样于 ${formatMetricTime(sampledAt)}` : '当前快照'}
      action={
        <StatusMark
          variant='pill'
          tone={
            metrics.ok
              ? { key: 'ok', cls: 'ok', text: '探针正常' }
              : { key: 'bad', cls: 'bad', text: '探针失败' }
          }
        />
      }
    >
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3 xl:grid-cols-6'>
        <StatCell
          label='探针耗时'
          value={latency(metrics.probe_latency_ms)}
          hint='固定 SELECT 1'
        />
        <StatCell
          label='主库大小'
          value={formatMetricBytes(metrics.file_size_bytes)}
          hint='SQLite 主文件'
        />
        <StatCell
          label='WAL 大小'
          value={formatMetricBytes(metrics.wal_size_bytes)}
          hint={`SHM ${formatMetricBytes(metrics.shm_size_bytes)}`}
        />
        <StatCell
          label='空闲页比例'
          value={formatMetricPercent(metrics.free_ratio)}
          hint={`${formatMetricNumber(metrics.freelist_pages)} 空闲页`}
        />
        <StatCell
          label='页使用'
          value={pageUse}
          hint={formatMetricBytes(metrics.used_bytes)}
        />
        <StatCell
          label='Migration'
          value={metrics.latest_migration || '—'}
          hint={`${formatMetricNumber(metrics.migration_count)} 次 · ${formatMetricTime(metrics.latest_migration_at)}`}
        />
      </div>

      <dl className='grid grid-cols-2 gap-x-5 gap-y-3 border-t px-4 py-3 sm:grid-cols-3 xl:grid-cols-6'>
        <Detail label='引擎' value={metrics.engine.toUpperCase()} />
        <Detail
          label='Journal'
          value={metrics.journal_mode?.toUpperCase() || '—'}
        />
        <Detail
          label='Synchronous'
          value={synchronousLabel(metrics.synchronous)}
        />
        <Detail
          label='Foreign keys'
          value={
            metrics.foreign_keys == null
              ? '—'
              : metrics.foreign_keys
                ? 'ON'
                : 'OFF'
          }
        />
        <Detail label='Busy timeout' value={timeout(metrics.busy_timeout_ms)} />
        <Detail
          label='Page size'
          value={formatMetricBytes(metrics.page_size_bytes)}
        />
      </dl>

      <p className='border-t px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground'>
        当前 node:sqlite 接口不提供 SQLite 页缓存
        hit/miss；这里展示的是文件、页使用和只读探针，不把应用缓存冒充数据库缓存。
      </p>
    </PanelCard>
  )
}
