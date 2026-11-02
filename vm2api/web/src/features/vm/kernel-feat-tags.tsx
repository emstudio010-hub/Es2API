import { Badge } from '@/components/ui/badge'
import { kernelProfile } from '@/features/vm/create-options'

export function KernelFeatTags({
  kernel,
  className,
}: {
  kernel?: string | null
  className?: string
}) {
  const profile = kernelProfile(kernel)
  if (!profile?.feats.length) return null
  return (
    <div className={className ?? 'flex flex-wrap gap-1'}>
      {profile.feats.map((f) => (
        <Badge key={f} variant='secondary' className='px-1.5 py-0 text-[10px]'>
          {f}
        </Badge>
      ))}
    </div>
  )
}
