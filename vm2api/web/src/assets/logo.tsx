import { type SVGProps } from 'react'
import { cn } from '@/lib/utils'
export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  return <svg viewBox='0 0 1280 1280' xmlns='http://www.w3.org/2000/svg' className={cn('size-6', className)} {...props}><title>Es2API</title><image href='/es2api-icon.png' width='1280' height='1280' /></svg>
}
