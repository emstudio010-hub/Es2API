import { queryOptions } from '@tanstack/react-query'
import type { ApiEndpointsPayload } from '@/types/panel-api-endpoints'
import { api } from '@/lib/api'

export function apiEndpointsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'api-endpoints'] as const,
    queryFn: () => api<ApiEndpointsPayload>('/api/panel/api-endpoints'),
  })
}
