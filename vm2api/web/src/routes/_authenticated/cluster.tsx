import { createFileRoute } from '@tanstack/react-router'
import { ClusterPage } from '@/features/cluster'

export const Route = createFileRoute('/_authenticated/cluster')({
  component: ClusterPage,
})
