import { queryOptions } from '@tanstack/react-query'
import type { Dashboard } from '@/types/panel-overview'
import type { UsagePayload } from '@/types/panel-usage'
import { api } from '@/lib/api'

export function dashboardQueryOptions(refetchInterval?: number) {
  return queryOptions({
    queryKey: ['panel', 'dashboard'] as const,
    queryFn: () => api<Dashboard>('/api/panel/dashboard'),
    ...(refetchInterval
      ? { refetchInterval, refetchOnWindowFocus: false }
      : {}),
  })
}

export function usageQueryOptions(refetchInterval?: number) {
  return queryOptions({
    queryKey: ['panel', 'usage'] as const,
    queryFn: () => api<UsagePayload>('/api/panel/usage'),
    ...(refetchInterval
      ? { refetchInterval, refetchOnWindowFocus: false }
      : {}),
  })
}
