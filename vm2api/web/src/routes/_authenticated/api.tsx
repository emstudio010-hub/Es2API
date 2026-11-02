import { createFileRoute } from '@tanstack/react-router'
import { ApiEndpointsPage } from '@/features/api-endpoints'

export const Route = createFileRoute('/_authenticated/api')({
  component: ApiEndpointsPage,
})
