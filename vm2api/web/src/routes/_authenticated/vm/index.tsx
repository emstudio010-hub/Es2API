import { createFileRoute } from '@tanstack/react-router'
import { VmListPage } from '@/features/vm/list-page'

export const Route = createFileRoute('/_authenticated/vm/')({
  component: VmListPage,
})
