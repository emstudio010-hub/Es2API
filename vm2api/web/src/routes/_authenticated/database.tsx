import { createFileRoute } from '@tanstack/react-router'
import { DatabasePage } from '@/features/database'

export const Route = createFileRoute('/_authenticated/database')({
  component: DatabasePage,
})
