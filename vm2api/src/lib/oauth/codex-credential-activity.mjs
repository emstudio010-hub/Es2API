import crypto from 'node:crypto'
import { withCodexKernelActivity } from '../transport/codex-kernel-activity.mjs'
import { assertCodexCredentialNotHandingOff } from './codex-credential-lock.mjs'
import { readCodexAccountsStrict } from '../vm/codex-slot.mjs'

const stamp = vm => JSON.stringify([vm.id, vm.integration_binding || null, vm.proxy?.id || null,
  vm.execution_backend || 'kernel', vm.created_at || vm.createdAt || null])
const changed = () => Object.assign(new Error('凭据或实例归属已变化，未发送旧快照请求；请重新同步'), {
  status: 409, code: 'codex_metadata_snapshot_changed',
})
const tokenStamp = account => crypto.createHash('sha256').update(JSON.stringify([
  account?.access_token || '', account?.refresh_token || '', account?.id_token || '',
  account?.chatgpt_account_id || '',
])).digest('hex')

// Metadata requests use the same shared activity resource as Kernel requests.
// Read/check credentials only after admission and retain this lease through
// response-body consumption and synchronous metadata writes. Refresh MUST be
// requested after this promise settles, otherwise it would drain its own lease.
export function withCodexCredentialActivity(projectRoot, vmId, operation, { expectedVm = null } = {}) {
  return withCodexKernelActivity(projectRoot, vmId, () => {
    const vm = assertCodexCredentialNotHandingOff(projectRoot, vmId)
    if (expectedVm && stamp(vm) !== stamp(expectedVm)) throw changed()
    readCodexAccountsStrict(projectRoot, vmId)
    return operation(vm)
  })
}

// Multi-account catalog callers retain their selected row across a failed
// attempt. Never send that row after another controller replaced its tokens.
export function assertCodexCredentialSnapshot(projectRoot, vmId, expected, fallback = null) {
  const rows = readCodexAccountsStrict(projectRoot, vmId)
  if (!(rows.length ? rows : [fallback || {}]).some(row => tokenStamp(row) === tokenStamp(expected))) throw changed()
}
