import { queryOptions } from '@tanstack/react-query'
import type { BillingPayload } from '@/types/panel-billing'
import { api } from '@/lib/api'

export function billingQueryOptions(groupBy: 'vm' | 'key' = 'vm') {
  return queryOptions({
    queryKey: ['panel', 'billing', groupBy] as const,
    queryFn: () =>
      api<BillingPayload>(
        `/api/panel/billing?group_by=${encodeURIComponent(groupBy)}`
      ),
  })
}
