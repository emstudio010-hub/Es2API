import crypto from 'node:crypto'
import {
  buildCodexImportRequest,
  buildVmProvisionRequest,
  normalizeAccountBinding,
  normalizeOpenAICredential,
  normalizeVmStatus,
  publicLifecycleResult,
} from './contract.mjs'

function idempotencyKey(prefix, accountId) {
  return `${prefix}:${String(accountId)}`
}

function vmIdFrom(payload) {
  return payload?.vm?.id || payload?.data?.vm?.id || payload?.vm_id || payload?.data?.vm_id || payload?.data?.id || payload?.id || null
}

function credentialBinding(binding, proxyId = binding.proxy_id) {
  return { account_id: binding.account_id, provision_generation: binding.provision_generation,
    proxy_id: proxyId, execution_backend: binding.execution_backend || 'kernel' }
}

function assertSlot(binding, id, status = null) {
  if (status && (status.execution_backend || 'kernel') !== (binding.execution_backend || 'kernel')) throw Object.assign(new Error('执行槽后端与账号配置不一致'), { code: 'vm2_execution_backend_mismatch', status: 409 })
  if (String(id) !== buildVmProvisionRequest(binding).id || (status && status.id !== String(id))) {
    throw Object.assign(new Error('执行槽与账号不匹配，已拒绝操作'), { code: 'vm2_slot_binding_mismatch', status: 409 })
  }
  if (binding.proxy_id && status?.egress?.bound && status.egress.proxy_id !== binding.proxy_id) {
    throw Object.assign(new Error('执行槽出口与账号固定 IP 不一致，已拒绝操作'), { code: 'vm2_exit_binding_mismatch', status: 409 })
  }
  if (status?.isolation?.account_id && (status.isolation.account_id !== binding.account_id ||
    (status.isolation.generation && status.isolation.generation !== binding.provision_generation))) {
    throw Object.assign(new Error('执行槽归属或创建代次与账号不匹配'), { code: 'vm2_slot_binding_mismatch', status: 409 })
  }
}

/**
 * Account lifecycle coordinator. It treats a slot as ready only after both
 * VM creation, credential import, and a ready status check succeed. Partial
 * slots are retained after failure so an operator can retry the same account
 * identity and inspect the actual failure state.
 */
export class AccountLifecycle {
  constructor({ vm2, onState = () => {} } = {}) {
    if (!vm2) throw new TypeError('vm2 client is required')
    this.vm2 = vm2
    this.onState = onState
  }

  async provision(accountInput, credentialInput, { generation = 1, existingVmId = null } = {}) {
    const binding = normalizeAccountBinding({ ...accountInput, provision_generation: generation })
    const credential = normalizeOpenAICredential(credentialInput)
    const accountId = binding.account_id
    const generationKey = `g${Math.max(1, Number(generation) || 1)}`
    const operationKey = operation => idempotencyKey(`account-${operation}:${generationKey}`, accountId)
    this.onState(publicLifecycleResult({ accountId, phase: 'validated', status: 'pending', credential }))
    let created
    let vmId = existingVmId ? String(existingVmId) : null
    try {
      if (vmId) {
        if (vmId !== buildVmProvisionRequest(binding).id) {
          throw Object.assign(new Error('已记录的 VM2 槽位与账号绑定不匹配'), { code: 'vm2_slot_binding_mismatch' })
        }
        try {
          const existing = await this.vm2.getSlot(vmId)
          const inspected = existing?.id && typeof existing.ready === 'boolean' ? existing : normalizeVmStatus(existing)
          if (inspected.id !== vmId) {
            throw Object.assign(new Error('VM2 槽位查询返回了不匹配的账号槽位'), { code: 'vm2_slot_binding_mismatch' })
          }
          assertSlot(binding, vmId, inspected)
        } catch (error) {
          if (error.status !== 404) throw error
          vmId = null
        }
      }
      if (!vmId) {
        try {
          created = await this.vm2.createSlot(binding, operationKey('create'))
          vmId = vmIdFrom(created)
        } catch (error) {
          // A response can be lost after persistence. Adopt only a slot with
          // the matching account and generation, then resume the same identity.
          const candidate = buildVmProvisionRequest(binding).id
          let existing
          try { existing = await this.vm2.getSlot(candidate) } catch { throw error }
          if (!existing.isolation?.account_id) throw error
          assertSlot(binding, candidate, existing)
          vmId = candidate
        }
      }
      if (!vmId) throw Object.assign(new Error('VM2 create response did not include vm id'), { code: 'vm2_missing_vm_id' })
      assertSlot(binding, vmId)
      const createdSlot = created ? normalizeVmStatus(created) : null
      this.onState({ ...publicLifecycleResult({ accountId, vmId, phase: 'slot_created', status: 'pending', credential }),
        slot: { id: vmId, status: 'provisioning', ready: false, ...(createdSlot?.egress?.bound ? { egress: createdSlot.egress } : {}) } })
      // Reserve an exit before credentials are sent. Retrying an empty slot uses
      // the same canonical identity and the fixed-exit allocator.
      let allocatedStatus = await this.vm2.getSlot(vmId)
      assertSlot(binding, vmId, allocatedStatus)
      if (!allocatedStatus.egress?.bound) {
        await this.vm2.ensureSlotProxy(vmId)
        allocatedStatus = await this.vm2.getSlot(vmId)
      }
      assertSlot(binding, vmId, allocatedStatus)
      if (!allocatedStatus.egress?.bound || !allocatedStatus.egress.proxy_id) {
        throw Object.assign(new Error('账号池尚未绑定出口，无法导入凭据或启动'), { status: 409, code: 'dedicated_proxy_unavailable' })
      }
      this.onState({ ...publicLifecycleResult({ accountId, vmId, phase: 'exit_bound', status: 'pending', credential }), slot: allocatedStatus })
      await this.vm2.importCredential(vmId, credential, operationKey('import'), {
        ifMissing: true, binding: credentialBinding(binding, allocatedStatus.egress.proxy_id),
      })
      if (typeof this.vm2.startSlot === 'function') await this.vm2.startSlot(vmId, operationKey('start'))
      const rawStatus = await this.vm2.getSlot(vmId)
      const status = rawStatus?.id && typeof rawStatus.ready === 'boolean' ? rawStatus : normalizeVmStatus(rawStatus)
      assertSlot(binding, vmId, status)
      if (!status.ready) {
        throw Object.assign(new Error('VM2 slot is not ready after credential import'), { code: 'vm2_slot_not_ready' })
      }
      const result = publicLifecycleResult({ accountId, vmId, phase: 'ready', status: 'running', credential })
      this.onState({ ...result, slot: status })
      return { ...result, binding: buildVmProvisionRequest(binding), slot: status }
    } catch (error) {
      error.account_id = accountId
      error.vm_id = vmId === buildVmProvisionRequest(binding).id ? vmId : null
      this.onState({ ...publicLifecycleResult({ accountId, vmId: error.vm_id, phase: 'error', status: 'error', credential }),
        slot: error.vm_id ? { id: error.vm_id, status: 'error', ready: false } : null })
      throw error
    }
  }

  async remove(accountInput, vmId, { generation = 1 } = {}) {
    const binding = normalizeAccountBinding({ ...accountInput, provision_generation: generation })
    const id = String(vmId || '').trim()
    if (!id) throw new TypeError('vm_id is required')
    assertSlot(binding, id)
    const generationKey = `g${Math.max(1, Number(generation) || 1)}`
    try {
      const raw = await this.vm2.getSlot(id)
      assertSlot(binding, id, raw?.id && typeof raw.ready === 'boolean' ? raw : normalizeVmStatus(raw))
      // Include both the provision generation and VM id. A rebuilt account may
      // reuse the same logical account ID (and, in a test/VM2 retry, even the
      // same VM id); a delete key must never alias a previous slot operation.
      await this.vm2.deleteSlot(id, `account-delete:${generationKey}:${binding.account_id}:${id}`)
    } catch (error) {
      // A prior delete may have succeeded while the local database commit failed.
      if (error?.status !== 404) throw error
    }
    const result = publicLifecycleResult({ accountId: binding.account_id, vmId: id, phase: 'deleted', status: 'deleted' })
    this.onState(result)
    return result
  }

  async checkpointCredential(accountInput, vmId, { generation = 1, acknowledgedHandoffId = null } = {}) {
    const binding = normalizeAccountBinding({ ...accountInput, provision_generation: generation })
    assertSlot(binding, vmId, await this.vm2.getSlot(vmId))
    const result = await this.vm2.checkpointCredential(vmId, { ...credentialBinding(binding), acknowledged_handoff_id: acknowledgedHandoffId })
    if (result.vm_id !== vmId || result.account_id !== binding.account_id
      || result.provision_generation !== generation || !/^[a-f0-9-]{36}$/i.test(result.handoff_id || '')) {
      throw Object.assign(new Error('凭据交接响应与账号归属不一致'), { status: 409, code: 'credential_handoff_changed' })
    }
    if (result.credential_missing === true && acknowledgedHandoffId === result.handoff_id) return { ...result, credential: null }
    return { ...result, credential: normalizeOpenAICredential(result.credential) }
  }

  async inspect(accountInput, vmId) {
    const binding = normalizeAccountBinding(accountInput)
    const id = String(vmId || '').trim()
    if (!id) throw new TypeError('vm_id is required')
    assertSlot(binding, id)
    const raw = await this.vm2.getSlot(id)
    const status = raw?.id && typeof raw.ready === 'boolean' ? raw : normalizeVmStatus(raw)
    assertSlot(binding, id, status)
    this.onState({ ...publicLifecycleResult({ accountId: binding.account_id, vmId: id,
      phase: 'health_checked', status: status.ready ? 'running' : 'error' }), slot: status })
    return status
  }

  async operate(accountInput, vmId, action) {
    if (!['start', 'stop', 'recover'].includes(action)) throw new TypeError('invalid slot action')
    const binding = normalizeAccountBinding(accountInput)
    const id = String(vmId || '')
    assertSlot(binding, id, await this.vm2.getSlot(id))
    const operationKey = `account-${action}:g${binding.provision_generation}:${binding.account_id}:${crypto.randomUUID()}`
    if (action === 'start') await this.vm2.startSlot(id, operationKey)
    else if (action === 'stop') await this.vm2.stopSlot(id, operationKey)
    else await this.vm2.recoverSlot(id, operationKey)
    const status = await this.vm2.getSlot(id)
    assertSlot(binding, id, status)
    if (action === 'stop' ? status.status !== 'stopped' : !status.ready) throw Object.assign(new Error('实例操作结果尚未确认，请同步状态后检查'), { status: 502, code: 'slot_action_unconfirmed' })
    return status
  }

  async recoverCredential(accountInput, vmId, identityKey) {
    const binding = normalizeAccountBinding(accountInput)
    const before = await this.vm2.getSlot(vmId)
    assertSlot(binding, vmId, before)
    if (before.credential_refresh_pending !== true) throw Object.assign(new Error('当前执行槽没有待恢复刷新记录，请同步状态后检查'), { status: 409, code: 'codex_refresh_not_pending' })
    if (before.credential_refresh_recovery_available !== true) throw Object.assign(new Error('尚未确认存在完整换票响应，未执行凭据恢复或重试换票；原记录已保留，请检查账号池状态'), {
      status: 409, code: before.credential_refresh_state === 'prepared' ? 'codex_refresh_outcome_unknown'
        : before.credential_refresh_state === 'incomplete' ? 'codex_refresh_response_incomplete' : 'codex_refresh_recovery_required',
    })
    await this.vm2.recoverCredential(vmId, credentialBinding(binding), identityKey)
    const status = await this.vm2.getSlot(vmId)
    assertSlot(binding, vmId, status)
    if (status.credential_refresh_pending) throw Object.assign(new Error('刷新日志仍待恢复，已保持暂停调度'), { status: 409, code: 'codex_refresh_recovery_required' })
    return status
  }
}

export { buildCodexImportRequest }
