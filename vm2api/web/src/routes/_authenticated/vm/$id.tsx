import { createFileRoute } from '@tanstack/react-router'
import { VmDetailPage } from '@/features/vm/detail-page'

export const Route = createFileRoute('/_authenticated/vm/$id')({
  component: VmDetailPage,
})
