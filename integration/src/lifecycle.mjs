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

function assertSlot(binding, id, status = null) {
  if (String(id) !== buildVmProvisionRequest(binding).id || (status && status.id !== String(id))) {
    throw Object.assign(new Error('执行槽与账号不匹配，已拒绝操作'), { code: 'vm2_slot_binding_mismatch', status: 409 })
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
        created = await this.vm2.createSlot(binding, operationKey('create'))
        vmId = vmIdFrom(created)
      }
      if (!vmId) throw Object.assign(new Error('VM2 create response did not include vm id'), { code: 'vm2_missing_vm_id' })
      assertSlot(binding, vmId)
      this.onState({ ...publicLifecycleResult({ accountId, vmId, phase: 'slot_created', status: 'pending', credential }),
        slot: { id: vmId, status: 'provisioning', ready: false } })
      await this.vm2.importCredential(vmId, credential, operationKey('import'))
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
}

export { buildCodexImportRequest }
