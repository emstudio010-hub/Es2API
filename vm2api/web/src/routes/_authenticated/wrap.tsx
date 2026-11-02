import { createFileRoute } from '@tanstack/react-router'
import { WrapSamplePage } from '@/features/wrap'

export const Route = createFileRoute('/_authenticated/wrap')({
  component: WrapSamplePage,
})
