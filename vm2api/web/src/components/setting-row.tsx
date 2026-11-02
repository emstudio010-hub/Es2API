import { Label } from '@/components/ui/label'

/** 通用的「标签 + 说明 / 右侧控件」表单行，适用于 `divide-y` 容器。 */
export function SettingRow({
  label,
  desc,
  children,
}: {
  label: string
  desc?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className='flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0'>
      <div className='min-w-32 flex-1 space-y-0.5'>
        <Label>{label}</Label>
        {desc ? <p className='text-xs text-muted-foreground'>{desc}</p> : null}
      </div>
      <div className='ms-auto shrink-0'>{children}</div>
    </div>
  )
}
