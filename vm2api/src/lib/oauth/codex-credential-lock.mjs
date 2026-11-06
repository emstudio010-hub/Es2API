import fs from 'node:fs'
import path from 'node:path'
import { isValidVmId } from '../vm/vm-file.mjs'
import { withCodexSlotControl } from '../vm/codex-slot-coordination.mjs'
import { assertNoPendingCodexRefresh, inCodexRefreshCommit } from './codex-refresh-journal.mjs'

export function assertCodexCredentialNotHandingOff(projectRoot, vmId, { allowShutdown = false, allowRefreshRecovery = false } = {}) {
  if (!isValidVmId(vmId)) throw Object.assign(new Error('无效的执行槽 ID'), { status: 400, code: 'invalid_vm_id' })
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!allowRefreshRecovery) assertNoPendingCodexRefresh(projectRoot, vmId)
  if (vm.credential_handoff) throw Object.assign(new Error('凭据正在交接给重建任务；请重试完成重建'), {
    status: 409, code: 'codex_credential_handoff_pending',
  })
  if (!allowShutdown && vm.codex_shutdown && !inCodexRefreshCommit(projectRoot, vmId)) throw Object.assign(new Error('实例已进入停机或删除流程；请完成操作后显式启动'), {
    status: 409, code: 'codex_shutdown_pending',
  })
  return vm
}

// All host-side Codex token exchanges and writes use this same key. The kernel
// is stopped and confirmed before a handoff snapshot is read under this lock.
export function withCodexCredentialLock(projectRoot, vmId, operation, { allowHandoff = false, allowShutdown = false, allowRefreshRecovery = false } = {}) {
  if (!isValidVmId(vmId)) throw Object.assign(new Error('无效的执行槽 ID'), { status: 400, code: 'invalid_vm_id' })
  return withCodexSlotControl(projectRoot, vmId, () => {
    if (!allowHandoff) assertCodexCredentialNotHandingOff(projectRoot, vmId, { allowShutdown, allowRefreshRecovery })
    return operation()
  })
}

export function assertCodexIntegrationBinding(vm, expected) {
  const actual = vm?.integration_binding
  if (!expected || !actual || actual.proxy_exclusive !== true || vm.id !== `es2-${expected.account_id}` || actual.account_id !== expected.account_id
    || actual.provision_generation !== expected.provision_generation
    || !Number.isSafeInteger(expected.provision_generation) || expected.provision_generation < 1
    || !expected.proxy_id || vm.proxy?.id !== expected.proxy_id
    || (vm.execution_backend || 'kernel') !== expected.execution_backend) {
    throw Object.assign(new Error('执行槽归属、代次、后端或固定出口不匹配，已拒绝凭据交接'), {
      status: 409, code: 'vm2_credential_binding_mismatch',
    })
  }
}
