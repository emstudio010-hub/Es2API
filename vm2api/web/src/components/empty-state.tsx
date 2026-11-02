import { Link, type LinkProps } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

export function EmptyState({
  reason,
  actionLabel,
  to,
  onAction,
}: {
  reason: string
  actionLabel?: string
  to?: LinkProps['to']
  onAction?: () => void
}) {
  const action = actionLabel ? (
    to ? (
      <Button asChild>
        <Link to={to} onClick={onAction}>
          {actionLabel}
        </Link>
      </Button>
    ) : onAction ? (
      <Button onClick={onAction}>{actionLabel}</Button>
    ) : null
  ) : null

  return (
    <div className='flex flex-col items-center justify-center gap-4 px-6 py-16 text-center'>
      <p className='text-sm text-muted-foreground'>{reason}</p>
      {action}
    </div>
  )
}
