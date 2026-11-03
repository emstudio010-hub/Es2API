import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteJson } from './vm-file.mjs'
import { withCodexCredentialLock } from '../oauth/codex-credential-lock.mjs'
import { stopConfiguredCodexKernel } from '../oauth/codex-kernel-credential-owner.mjs'
import { withCodexKernelPause } from '../transport/codex-kernel-activity.mjs'
import { codexCliJobs } from '../transport/codex-cli-state.mjs'

// Keep intent on disk until explicit start or record deletion. Node restarts,
// stale request snapshots and quota recovery must not resurrect the process.
export async function shutdownCodexSlot(vm, projectRoot, action, halt, { credentialLockHeld = false } = {}) {
  const operation = async () => {
    const file = path.join(projectRoot, 'vms', `${vm.id}.json`)
    let record = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (record.id !== vm.id) throw Object.assign(new Error('执行槽记录归属不匹配'), { code: 'codex_shutdown_identity_mismatch' })
    if (record.codex_shutdown?.action === 'delete' && action !== 'delete') {
      throw Object.assign(new Error('实例删除尚未完成，请继续删除'), { code: 'codex_delete_pending' })
    }
    const intent = record.codex_shutdown?.action === action ? record.codex_shutdown
      : { id: crypto.randomUUID(), action, at: new Date().toISOString() }
    atomicWriteJson(file, { ...record, codex_shutdown: { ...intent, confirmed: false },
      status: action === 'delete' ? 'deleting' : 'stopping', schedulable: false,
      schedule_disabled_reason: record.credential_handoff ? 'credential_handoff' : 'codex_shutdown',
      updated_at: new Date().toISOString() }, { mode: 0o600 })
    codexCliJobs.get(vm.id)?.cancel('codex_cli_cancelled')
    let result
    return withCodexKernelPause(projectRoot, vm.id, async () => {
      // Docker's absence proves container children are gone, but host pipe
      // finalizers must also release before a caller can remove their files.
      const deadline = Date.now() + 5000
      while (codexCliJobs.has(vm.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      if (codexCliJobs.has(vm.id)) throw Object.assign(new Error('CLI 请求尚未释放，已保留目录和出口'), { code: 'codex_cli_busy' })
      record = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (record.codex_shutdown?.id !== intent.id || record.codex_shutdown.action !== action) {
        throw Object.assign(new Error('实例停机上下文已变化'), { code: 'codex_shutdown_changed' })
      }
      atomicWriteJson(file, { ...record, codex_shutdown: { ...intent, confirmed: true },
        status: action === 'delete' ? 'deleting' : 'stopped', schedulable: false,
        ...(vm.runtime ? { runtime: vm.runtime } : {}), updated_at: new Date().toISOString() }, { mode: 0o600 })
      return result
    }, { beforeDrain: async () => {
      await stopConfiguredCodexKernel(projectRoot, vm.id)
      result = await halt()
      if (!result?.ok) throw Object.assign(new Error('容器退出或移除未确认，已保留实例数据和出口'), { code: result?.code || 'codex_container_stop_unconfirmed' })
    } })
  }
  try {
    if (!projectRoot) throw Object.assign(new Error('缺少执行槽根目录，无法确认停机'), { code: 'codex_project_root_required' })
    return await (credentialLockHeld ? operation() : withCodexCredentialLock(projectRoot, vm.id, operation, { allowHandoff: true, allowShutdown: true }))
  } catch (error) {
    return { ok: false, code: error.code || 'codex_shutdown_unconfirmed', error: '实例退出尚未确认，账号记录、凭据和固定出口已保留；请重试原操作' }
  }
}
