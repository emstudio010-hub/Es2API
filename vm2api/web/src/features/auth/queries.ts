import { queryOptions } from '@tanstack/react-query'
import type { MeResponse } from '@/types/panel-auth'
import { api } from '@/lib/api'

export function meQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: ['panel', 'me'] as const,
    queryFn: () => api<MeResponse>('/api/panel/me'),
    enabled,
    retry: false,
  })
}
