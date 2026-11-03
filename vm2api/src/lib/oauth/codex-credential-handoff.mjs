import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { withCodexCredentialLock, assertCodexIntegrationBinding } from './codex-credential-lock.mjs'
import { selectOAuthCredential } from './credential-import.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { readCodexAccountsStrict, isCodexVm } from '../vm/codex-slot.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { stopCodexKernelForCheckpoint } from '../transport/codex-kernel-stop.mjs'
import { codexKernelBinPath } from '../transport/codex-kernel-supervisor.mjs'

export async function checkpointCodexCredential(projectRoot, vmId, expected, stop) {
  return withCodexCredentialLock(projectRoot, vmId, async () => {
    const file = path.join(projectRoot, 'vms', `${vmId}.json`)
    let vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    assertCodexIntegrationBinding(vm, expected)
    if (slotHost(vm).kind !== 'local' || isKvmRuntime(vm) || process.platform !== 'linux') {
      throw Object.assign(new Error('凭据交接仅支持本机 Linux Docker 执行槽'), { status: 409, code: 'credential_handoff_runtime_unsupported' })
    }
    if (!isCodexVm(vm)) throw Object.assign(new Error('仅支持 Codex OAuth 凭据交接'), { status: 400, code: 'credential_kind_mismatch' })
    const handoff = vm.credential_handoff || { id: crypto.randomUUID(), at: new Date().toISOString() }
    // Persist the freeze before yielding. Restarts cannot resume rotation/boot.
    atomicWriteJson(file, { ...vm, credential_handoff: handoff, schedulable: false,
      schedule_disabled_reason: 'credential_handoff', updated_at: new Date().toISOString() }, { mode: 0o600 })
    const halted = await stop(vm, projectRoot, { credentialLockHeld: true,
      acknowledgedHandoffId: expected.acknowledged_handoff_id === handoff.id ? handoff.id : null })
    if (!halted?.ok) throw Object.assign(new Error('实例停止未确认，未读取或交接凭据'), { status: 409, code: 'credential_handoff_stop_unconfirmed' })
    const kernel = await stopCodexKernelForCheckpoint(projectRoot, vmId, codexKernelBinPath())
    if (!kernel.ok) throw Object.assign(new Error('宿主 Kernel 退出未确认，未读取或交接凭据'), { status: 409, code: 'credential_handoff_kernel_unconfirmed' })
    vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    assertCodexIntegrationBinding(vm, expected)
    if (vm.credential_handoff?.id !== handoff.id) throw Object.assign(new Error('凭据交接上下文已变化'), { status: 409, code: 'credential_handoff_changed' })
    atomicWriteJson(file, { ...vm, status: 'stopped', schedulable: false,
      schedule_disabled_reason: 'credential_handoff', updated_at: new Date().toISOString() }, { mode: 0o600 })
    const accounts = readCodexAccountsStrict(projectRoot, vmId)
    if (!accounts.length && expected.acknowledged_handoff_id === handoff.id) {
      // Deletion may have removed the home but failed while releasing the exit.
      // Only a control-plane receipt for this exact freeze permits continuing.
      return { vm_id: vmId, account_id: expected.account_id, provision_generation: expected.provision_generation,
        handoff_id: handoff.id, credential_missing: true }
    }
    if (accounts.length !== 1) throw Object.assign(new Error('凭据交接要求每槽恰好一个 OAuth 账号'), { status: 409, code: 'codex_account_count' })
    const selected = selectOAuthCredential(accounts[0])
    if (!selected || selected.tokens.api_key || (!selected.tokens.access_token && !selected.tokens.refresh_token)) {
      throw Object.assign(new Error('实例中没有可交接的 OAuth 凭据'), { status: 409, code: 'credential_handoff_missing' })
    }
    return { vm_id: vmId, account_id: expected.account_id, provision_generation: expected.provision_generation,
      handoff_id: handoff.id, credential: { access_token: selected.tokens.access_token || null,
        refresh_token: selected.tokens.refresh_token || null, id_token: selected.tokens.id_token || null,
        api_key: null, ...selected.metadata } }
  }, { allowHandoff: true })
}
