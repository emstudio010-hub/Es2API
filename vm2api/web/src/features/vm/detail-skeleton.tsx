import { Skeleton } from '@/components/ui/skeleton'
import { CardGridSkeleton } from '@/components/page-skeletons'

/** 对应：操作条 → 6 个 tab → 概览 KPI 卡 + 两列分区卡。 */
export function VmDetailSkeleton() {
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <Skeleton className='h-8 w-14' />
        <Skeleton className='h-6 w-20 rounded-full' />
        <Skeleton className='h-6 w-16 rounded-full' />
        <div className='ms-auto flex flex-wrap gap-2'>
          <Skeleton className='h-8 w-20' />
          <Skeleton className='h-8 w-20' />
        </div>
      </div>
      <div className='flex flex-wrap gap-1'>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={`tab-${i}`} className='h-9 w-14 rounded-md' />
        ))}
      </div>
      <CardGridSkeleton cards={4} />
      <CardGridSkeleton cards={2} className='grid gap-3 md:grid-cols-2' />
    </div>
  )
}
