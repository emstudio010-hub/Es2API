import { cn } from '@/lib/utils'

export function CircularProgress({
  value,
  max,
  size = 48,
  strokeWidth = 4,
  label,
  showPercentage = true,
  className,
  toneClassName,
}: {
  value: number
  max: number
  size?: number
  strokeWidth?: number
  label?: string
  showPercentage?: boolean
  className?: string
  toneClassName?: string
}) {
  const percentage =
    max > 0 ? Math.min(Math.round((value / max) * 100), 100) : 0
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (percentage / 100) * circumference

  return (
    <div
      className={cn(
        'relative inline-flex items-center justify-center',
        className
      )}
    >
      <svg width={size} height={size} className='-rotate-90 transform'>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke='currentColor'
          strokeWidth={strokeWidth}
          fill='none'
          className='text-muted/30'
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke='currentColor'
          strokeWidth={strokeWidth}
          fill='none'
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap='round'
          className={cn(
            'transition-all duration-200 ease-in-out',
            toneClassName || 'text-primary'
          )}
        />
      </svg>
      <div className='absolute inset-0 flex flex-col items-center justify-center'>
        {showPercentage && (
          <span className={cn('text-xs font-semibold', toneClassName)}>
            {percentage}%
          </span>
        )}
        {label && (
          <span className='text-[10px] text-muted-foreground'>{label}</span>
        )}
      </div>
    </div>
  )
}
