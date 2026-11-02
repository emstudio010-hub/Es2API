import { createFileRoute } from '@tanstack/react-router'
import { ProxiesPage } from '@/features/proxies'

export const Route = createFileRoute('/_authenticated/proxies')({
  component: ProxiesPage,
})
