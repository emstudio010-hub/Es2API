import type { VmKernelHealth } from '@/types/panel-vm'
import { Field } from '@/features/vm/detail-section-primitives'

export function CodexKernelHealthFields({
  health,
}: {
  health?:
    | (VmKernelHealth & {
        proxy_ok?: boolean | null
        accounts?: number | null
        vm_id?: string | null
      })
    | null
}) {
  const up = Boolean(health?.reachable)
  return (
    <>
      <Field label='Codex 内核' compact>
        {up ? '可达' : health?.error_code || '不可达'}
      </Field>
      <Field label='版本' compact>
        {health?.worker_version || '—'}
      </Field>
      <Field label='SOCKS' compact>
        {health?.proxy_ok == null ? '—' : health.proxy_ok ? '已配置' : '缺失'}
      </Field>
      <Field label='凭证条数' compact>
        {health?.accounts == null ? '—' : String(health.accounts)}
      </Field>
    </>
  )
}
