import crypto, { randomUUID } from 'node:crypto'
import {
  normalizeAccountBinding,
  normalizeOpenAICredential,
  publicCredentialStatus,
} from './contract.mjs'

function publicError(error, credential) {
  let message = String(error?.message || 'VM2 lifecycle operation failed').slice(0, 500)
  for (const value of Object.values(credential || {})) {
    if (typeof value === 'string' && value.length >= 6) message = message.split(value).join('[redacted]')
  }
  return { code: String(error?.code || 'lifecycle_failed').slice(0, 80), message }
}

function assertInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw Object.assign(new Error(`${field} 超出范围`), { status: 400, code: 'invalid_field' })
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export class AccountPool {
  constructor({ store, lifecycle, traceDefaults = { enabled: true }, beforeRemoveAccount = async () => {} } = {}) {
    if (!store || !lifecycle) throw new TypeError('store and lifecycle are required')
    Object.assign(this, { store, lifecycle, traceDefaults, beforeRemoveAccount })
    this.locks = new Map()
  }

  async withLock(id, operation) {
    const key = String(id)
    const previous = this.locks.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    this.locks.set(key, current)
    await previous.catch(() => {})
    try { return await operation() } finally {
      release()
      if (this.locks.get(key) === current) this.locks.delete(key)
    }
  }

  createGroup(input = {}) {
    const groupId = String(input.id || randomUUID()).trim()
    if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(groupId)) throw Object.assign(new Error('分组 ID 格式无效'), { status: 400, code: 'invalid_group_id' })
    const name = String(input.name || '').trim()
    const platform = String(input.platform || 'openai').trim().toLowerCase()
    const strategy = String(input.strategy || 'shared').trim().toLowerCase()
    if (!name || name.length > 100) throw Object.assign(new Error('分组名称需要为 1–100 个字符'), { status: 400, code: 'invalid_group' })
    if (platform !== 'openai') throw Object.assign(new Error('VM2 槽位分组仅接受 OpenAI 账号'), { status: 400, code: 'invalid_group' })
    if (!['shared', 'per_slot'].includes(strategy)) throw Object.assign(new Error('分组策略无效'), { status: 400, code: 'invalid_group' })
    try {
      return this.store.createGroup({ id: groupId, name, platform, strategy, lease_account_id: null })
    } catch (error) {
      if (String(error?.message).includes('UNIQUE constraint failed: account_groups.id')) {
        throw Object.assign(new Error('分组已存在'), { status: 409, code: 'group_exists' })
      }
      throw error
    }
  }

  listGroups() { return this.store.listGroups() }

  updateGroup(id, input = {}) {
    const current = this.store.getGroup(id)
    if (!current) throw Object.assign(new Error('分组不存在'), { status: 404, code: 'group_not_found' })
    const fields = {}
    if ('name' in input) {
      fields.name = String(input.name || '').trim()
      if (!fields.name || fields.name.length > 100) throw Object.assign(new Error('分组名称需要为 1–100 个字符'), { status: 400, code: 'invalid_group' })
    }
    if ('status' in input) {
      if (!['active', 'inactive'].includes(input.status)) throw Object.assign(new Error('分组状态无效'), { status: 400, code: 'invalid_group' })
      fields.status = input.status
    }
    const updated = this.store.updateGroup(id, fields)
    if (fields.status === 'inactive') {
      for (const account of this.store.listAllAccounts()) {
        if (!account.group_ids.includes(String(id))) continue
        this.store.updateAccount(account.id, { group_pause_restore: account.group_pause_restore || account.schedulable,
          schedulable: false })
      }
    } else if (fields.status === 'active') {
      for (const account of this.store.listAllAccounts()) {
        if (!account.group_ids.includes(String(id)) || !account.group_pause_restore) continue
        if (account.group_ids.some(groupId => this.store.getGroup(groupId)?.status !== 'active')) continue
        const state = account.modeltrace?.state || {}
        const canRestore = account.status === 'ready' && account.slot?.ready === true && !account.deletion_pending &&
          !account.slot_binding_stale && !state.auto_paused
        this.store.updateAccount(account.id, { group_pause_restore: false, schedulable: canRestore,
          ...(canRestore ? { error_code: null, error_message: null } : {}) })
      }
    }
    return updated
  }

  deleteGroup(id) {
    if (!this.store.deleteGroup(id)) throw Object.assign(new Error('分组不存在'), { status: 404, code: 'group_not_found' })
    return { deleted: true, id: String(id) }
  }

  resolveBinding(input, accountId) {
    let binding = normalizeAccountBinding({ ...input, account_id: accountId })
    if (binding.mode === 'lease' && binding.group_ids.length === 0) {
      const autoGroupId = `lease-${binding.account_id}`
      const group = this.store.getGroup(autoGroupId) || this.store.createGroup({ id: autoGroupId, name: autoGroupId,
        platform: 'openai', strategy: 'per_slot', lease_account_id: binding.account_id })
      binding = normalizeAccountBinding({ ...input, account_id: accountId, group_ids: [group.id] })
    }
    if (binding.mode === 'lease' && binding.group_ids.length !== 1) {
      throw Object.assign(new Error('租赁模式必须且只能绑定一个独立分组'), { status: 400, code: 'lease_group_required' })
    }
    for (const id of binding.group_ids) {
      const group = this.store.getGroup(id)
      if (!group) throw Object.assign(new Error(`分组 ${id} 不存在`), { status: 400, code: 'group_not_found' })
      if (group.platform !== 'openai') throw Object.assign(new Error('分组平台与账号不匹配'), { status: 400, code: 'group_platform_mismatch' })
      if (group.status !== 'active') throw Object.assign(new Error(`分组 ${id} 已停用`), { status: 409, code: 'group_inactive' })
      if (binding.mode === 'lease') {
        if (group.strategy !== 'per_slot') throw Object.assign(new Error('租赁账号需要独立槽位分组'), { status: 409, code: 'lease_group_strategy' })
        if (group.lease_account_id && group.lease_account_id !== binding.account_id) throw Object.assign(new Error('租赁分组已归属其他账号'), { status: 409, code: 'lease_group_in_use' })
        if (!this.store.claimLeaseGroup(id, binding.account_id)) throw Object.assign(new Error('租赁分组已被其他账号占用'), { status: 409, code: 'lease_group_in_use' })
      } else if (group.strategy === 'per_slot' && group.lease_account_id !== binding.account_id) {
        throw Object.assign(new Error('租赁专属分组不能加入共享账号池'), { status: 409, code: 'lease_group_reserved' })
      }
    }
    return binding
  }

  insertProvisioning(input, credential, idempotency = null) {
    const accountId = String(input.account_id ?? input.id ?? '').trim()
    if (!/^[a-z0-9][a-z0-9_-]{0,75}$/i.test(accountId) || accountId.toLowerCase().endsWith('-chat')) throw Object.assign(new Error('account_id 格式无效（最多 76 个字母、数字、下划线或连字符，不能以 -chat 结尾）'), { status: 400, code: 'invalid_account_id' })
    if (this.store.getAccount(accountId)) throw Object.assign(new Error('账号已存在'), { status: 409, code: 'account_exists' })
    const normalized = normalizeOpenAICredential(credential)
    const status = publicCredentialStatus(normalized)
    const concurrency = input.concurrency ?? input.max_concurrency ?? 2
    const priority = input.priority ?? 50
    assertInteger(concurrency, 'concurrency', 1, 256)
    assertInteger(priority, 'priority', 0, 100000)
    let binding
    let account
    let inserted
    try {
      inserted = this.store.transaction(() => {
        binding = this.resolveBinding({ ...input, max_concurrency: concurrency }, accountId)
        if (binding.name.length > 160) throw Object.assign(new Error('账号名称需要为 1–160 个字符'), { status: 400, code: 'invalid_name' })
        account = {
          id: binding.account_id,
          name: binding.name,
          mode: binding.mode,
          group_ids: binding.group_ids,
          binding,
          concurrency,
          priority,
          credential: status,
          modeltrace_overrides: { enabled: binding.mode === 'pool' },
        }
        const saved = this.store.createAccount(account, normalized)
        if (idempotency) this.store.saveIdempotency({ ...idempotency, account_id: accountId,
          response: { account_id: accountId, status: 'provisioning' } })
        return saved
      })
    }
    catch (error) {
      if (String(error?.message).includes('UNIQUE constraint failed: pool_accounts.credential_fingerprint')) {
        throw Object.assign(new Error('该凭据已存在于账号池'), { status: 409, code: 'credential_already_imported' })
      }
      if (String(error?.message).includes('UNIQUE constraint failed: pool_accounts.id')) {
        throw Object.assign(new Error('账号已存在'), { status: 409, code: 'account_exists' })
      }
      throw error
    }
    return { account, binding, inserted }
  }

  async importAccount(input = {}, { idempotencyKey = null } = {}) {
    const key = idempotencyKey ? String(idempotencyKey).trim() : ''
    if (key && !/^[a-z0-9][a-z0-9._:-]{0,191}$/i.test(key)) {
      throw Object.assign(new Error('Idempotency-Key 格式无效'), { status: 400, code: 'invalid_idempotency_key' })
    }
    const requestHash = key ? crypto.createHash('sha256').update(stableJson(input)).digest('hex') : null
    const accountId = String(input.account_id ?? input.id ?? randomUUID())
    return this.withLock(accountId, async () => {
      const execute = async () => {
      if (key) {
        const existing = this.store.getIdempotency(key, 'account-import')
        if (existing) {
          if (existing.request_hash !== requestHash) throw Object.assign(new Error('同一 Idempotency-Key 不能复用不同请求'), { status: 409, code: 'idempotency_conflict' })
          if (existing.response?.error) throw Object.assign(new Error(existing.response.error.message), {
            status: existing.response.error.status || 502, code: existing.response.error.code || 'lifecycle_failed',
          })
          const saved = existing.account_id ? this.store.getAccount(existing.account_id) : null
          if (saved) return saved
          if (existing.response) return existing.response
        }
      }
      const credentialInput = input.credential ?? input.credentials ?? input.tokens ?? input.auth_json
      const normalized = normalizeOpenAICredential(credentialInput)
      const created = this.insertProvisioning({ ...input, account_id: accountId }, normalized, key ? {
        key, operation: 'account-import', request_hash: requestHash,
      } : null)
      try {
        const result = await this.runProvision(created.account.id, created.binding, normalized)
        if (key) this.store.saveIdempotency({ key, operation: 'account-import', request_hash: requestHash, account_id: accountId, response: result })
        return result
      } catch (error) {
        if (key) this.store.saveIdempotency({ key, operation: 'account-import', request_hash: requestHash, account_id: accountId,
          response: { error: { status: error.status || 502, code: error.code || 'lifecycle_failed', message: String(error.message || '导入失败').slice(0, 500) } } })
        throw error
      }
      }
      return key ? this.withLock(`idempotency:${key}`, execute) : execute()
    })
  }

  async runProvision(id, binding, credential) {
    try {
      const current = this.store.getAccount(id)
      const result = await this.lifecycle.provision(binding, credential, {
        generation: current?.provision_generation || 1,
        existingVmId: current?.vm_id || null,
      })
      if (result?.slot?.ready !== true) {
        throw Object.assign(new Error('VM2 槽位创建完成但健康状态未就绪'), { code: 'slot_not_ready', status: 502 })
      }
      const latest = this.store.getAccount(id)
      if (!latest || latest.status === 'deleting' || latest.deletion_pending) {
        throw Object.assign(new Error('账号在槽位创建期间进入删除流程'), { code: 'lifecycle_context_changed', status: 409 })
      }
      return this.store.updateAccount(id, {
        vm_id: result.vm_id,
        status: 'ready',
        schedulable: this.store.getAccount(id).group_ids.length > 0 && this.store.getAccount(id).group_ids.every(groupId => this.store.getGroup(groupId)?.status === 'active'),
        slot_json: { status: 'running', ready: true, verified: true, ...result.slot },
        slot_binding_stale: false,
        error_code: null,
        error_message: null,
        deletion_pending: false,
      })
    } catch (error) {
      const safe = publicError(error, credential)
      const existing = this.store.getAccount(id)
      const vmId = error.vm_id || existing?.vm_id || null
      this.store.updateAccount(id, {
        vm_id: vmId,
        status: 'error',
        schedulable: false,
        slot_json: vmId ? { id: vmId, status: 'error', ready: false, cleanup_pending: false } : null,
        error_code: safe.code,
        error_message: safe.message,
      })
      throw Object.assign(new Error(safe.message), { status: error.status || 502, code: safe.code, account_id: id })
    }
  }

  async retryProvision(id) {
    return this.withLock(id, () => this.retryProvisionUnlocked(id))
  }

  async retryProvisionUnlocked(id) {
    const account = this.store.getAccount(id, { includeCredential: true })
    if (!account) throw Object.assign(new Error('账号不存在'), { status: 404, code: 'account_not_found' })
    const staleRebind = account.slot_binding_stale && !!account.vm_id
    if (!staleRebind && !['error', 'provisioning'].includes(account.status)) throw Object.assign(new Error('只有失败或中断的创建任务可以重试'), { status: 409, code: 'invalid_lifecycle_state' })
    if (staleRebind && account.dispatch.inflight_requests > 0) {
      throw Object.assign(new Error('执行槽仍有在途请求，暂时不能重建绑定'), { status: 409, code: 'account_busy' })
    }
    const binding = normalizeAccountBinding({ ...(account.binding || {}), account_id: account.id,
      name: account.name, mode: account.mode, group_ids: account.group_ids, max_concurrency: account.concurrency })
    if (staleRebind && account.vm_id) {
      this.store.updateAccount(id, { status: 'provisioning', schedulable: false })
      try {
        await this.lifecycle.remove({ account_id: account.id, mode: account.mode, group_ids: account.group_ids }, account.vm_id,
          { generation: account.provision_generation })
      } catch (error) {
        const safe = publicError(error)
        this.store.updateAccount(id, { status: 'error', schedulable: false, error_code: safe.code,
          error_message: `旧执行槽删除未确认：${safe.message}`, slot_binding_stale: true })
        throw Object.assign(new Error(safe.message), { status: error.status || 502, code: safe.code })
      }
      this.store.updateAccount(id, { vm_id: null, slot_json: null, slot_binding_stale: false,
        provision_generation: account.provision_generation + 1 })
    }
    this.store.updateAccount(id, { status: 'provisioning', schedulable: false, error_code: null, error_message: null })
    return this.runProvision(id, binding, account.credentials)
  }

  async removeAccount(id) {
    return this.withLock(id, () => this.removeAccountUnlocked(id))
  }

  async removeAccountUnlocked(id) {
    const account = this.store.getAccount(id)
    if (!account) throw Object.assign(new Error('账号不存在'), { status: 404, code: 'account_not_found' })
    if (account.dispatch.inflight_requests > 0) {
      throw Object.assign(new Error('账号仍有在途请求，等待请求释放后再删除'), { status: 409, code: 'account_busy' })
    }
    this.store.updateAccount(id, { status: 'deleting', schedulable: false, deletion_pending: true })
    try {
      await this.beforeRemoveAccount(String(id))
      if (account.vm_id) await this.lifecycle.remove({ account_id: account.id, mode: account.mode, group_ids: account.group_ids }, account.vm_id,
        { generation: account.provision_generation })
      this.store.transaction(() => {
        this.store.deleteAccount(id)
        this.store.releaseLeaseGroups(id)
      })
      return { deleted: true, id: String(id), vm_id: account.vm_id }
    } catch (error) {
      const safe = publicError(error)
      this.store.updateAccount(id, { status: 'error', schedulable: false, deletion_pending: true,
        error_code: safe.code, error_message: `执行槽删除未确认：${safe.message}` })
      throw Object.assign(new Error(safe.message), { status: error.status || 502, code: safe.code })
    }
  }

  async retryDelete(id) {
    return this.withLock(id, async () => {
      const account = this.store.getAccount(id)
      if (!account) throw Object.assign(new Error('账号不存在'), { status: 404, code: 'account_not_found' })
      if (!account.deletion_pending) throw Object.assign(new Error('账号没有待完成的删除任务'), { status: 409, code: 'invalid_lifecycle_state' })
      return this.removeAccountUnlocked(id)
    })
  }

  updateAccount(id, input = {}) {
    if (this.locks.has(String(id))) {
      throw Object.assign(new Error('账号生命周期操作正在进行，暂时不能修改配置'), { status: 409, code: 'lifecycle_busy' })
    }
    const account = this.store.getAccount(id)
    if (!account) throw Object.assign(new Error('账号不存在'), { status: 404, code: 'account_not_found' })
    if (account.deletion_pending || ['provisioning', 'deleting'].includes(account.status)) {
      throw Object.assign(new Error('账号生命周期操作正在进行，暂时不能修改配置'), { status: 409, code: 'lifecycle_busy' })
    }
    const fields = {}
    let requestedGroups = null
    if ('name' in input) {
      fields.name = String(input.name || '').trim()
      if (!fields.name || fields.name.length > 160) throw Object.assign(new Error('账号名称需要为 1–160 个字符'), { status: 400, code: 'invalid_name' })
    }
    let effectiveGroupIds = account.group_ids
    const bindingPatch = {}
    if (Object.prototype.hasOwnProperty.call(input, 'proxy_id') || Object.prototype.hasOwnProperty.call(input, 'timezone')) {
      throw Object.assign(new Error('执行槽 IP 和时区只允许在创建容器时选择；需要变更时请删除并重新导入账号'), {
        status: 409,
        code: 'slot_ip_immutable',
      })
    }
    for (const field of ['locale', 'max_rpm', 'max_sessions']) {
      if (Object.prototype.hasOwnProperty.call(input, field)) bindingPatch[field] = input[field]
    }
    if ('group_ids' in input) {
      if (!Array.isArray(input.group_ids)) throw Object.assign(new Error('group_ids 必须为数组'), { status: 400, code: 'invalid_group_ids' })
      requestedGroups = [...new Set(input.group_ids.map(value => String(value).trim()).filter(Boolean))]
      if (account.mode === 'lease' && JSON.stringify(requestedGroups) !== JSON.stringify(account.group_ids)) {
        throw Object.assign(new Error('租赁账号不能迁移已有槽位分组'), { status: 409, code: 'lease_group_locked' })
      }
      effectiveGroupIds = requestedGroups
    }
    // Group membership is a control-plane scheduling decision. It can change
    // without rebuilding the VM2 execution slot; egress and slot limits are
    // execution binding fields and do require an explicit retry/rebuild.
    const slotBindingChanged = Object.keys(bindingPatch).length > 0 ||
      Object.prototype.hasOwnProperty.call(input, 'concurrency')
    if ('concurrency' in input) {
      assertInteger(input.concurrency, 'concurrency', 1, 256)
      fields.concurrency = input.concurrency
    }
    if ('priority' in input) { assertInteger(input.priority, 'priority', 0, 100000); fields.priority = input.priority }
    if ('schedulable' in input) {
      if (typeof input.schedulable !== 'boolean') throw Object.assign(new Error('schedulable 必须为布尔值'), { status: 400, code: 'invalid_schedulable' })
      if (input.schedulable && (account.status !== 'ready' || account.slot_binding_stale ||
        account.slot?.ready !== true || !account.vm_id || effectiveGroupIds.length === 0 ||
        !effectiveGroupIds.every(groupId => this.store.getGroup(groupId)?.status === 'active'))) {
        throw Object.assign(new Error('账号槽位未就绪或未分组，不能加入可调度池'), { status: 409, code: 'account_not_schedulable' })
      }
      if (requestedGroups && effectiveGroupIds.length === 0) fields.schedulable = false
      else fields.schedulable = input.schedulable
    }
    if (requestedGroups && effectiveGroupIds.length === 0) fields.schedulable = false
    return this.store.transaction(() => {
      const bindingInput = { ...(account.binding || {}), ...bindingPatch,
        mode: account.mode, group_ids: requestedGroups || account.group_ids,
        name: fields.name || account.name, max_concurrency: fields.concurrency || account.concurrency }
      const binding = (requestedGroups || Object.keys(bindingPatch).length)
        ? this.resolveBinding(bindingInput, id)
        : { ...bindingInput, account_id: id }
      if (requestedGroups) fields.group_ids = binding.group_ids
      if (requestedGroups || Object.keys(bindingPatch).length || Object.prototype.hasOwnProperty.call(input, 'concurrency')) {
        const previousBinding = JSON.stringify(account.binding || {})
        const nextBinding = JSON.stringify(binding)
        fields.binding = binding
        if (account.vm_id && slotBindingChanged && previousBinding !== nextBinding) {
          fields.slot_binding_stale = true
          fields.schedulable = false
          fields.error_code = 'slot_rebind_required'
          fields.error_message = '账号绑定字段已变更，需要重试以重建执行槽'
        }
      } else if ('name' in input || 'concurrency' in input) {
        fields.binding = { ...bindingInput, account_id: id }
      }
      if (fields.slot_binding_stale && input.schedulable === true) {
        throw Object.assign(new Error('账号绑定已变化，请先重试执行槽再加入可调度池'), { status: 409, code: 'account_rebind_required' })
      }
      return this.store.updateAccount(id, fields)
    })
  }

  async syncAccount(id) {
    return this.withLock(id, async () => {
      const account = this.store.getAccount(id)
      if (!account) throw Object.assign(new Error('账号不存在'), { status: 404, code: 'account_not_found' })
      if (!account.vm_id || typeof this.lifecycle.inspect !== 'function') {
        throw Object.assign(new Error('账号没有可同步的执行槽'), { status: 409, code: 'slot_not_available' })
      }
      try {
        const status = await this.lifecycle.inspect({ ...account.binding, provision_generation: account.provision_generation }, account.vm_id)
        const ready = status?.ready === true && (status.status == null || status.status === 'running') && status.health?.ok !== false
        const schedulable = ready && !account.slot_binding_stale && account.group_ids.length > 0 &&
          account.group_ids.every(groupId => this.store.getGroup(groupId)?.status === 'active') &&
          !(account.modeltrace?.state || {}).auto_paused
        return this.store.updateAccount(id, {
          status: ready ? 'ready' : 'error', schedulable, slot_json: status,
          last_health_check_at: new Date().toISOString(), error_code: ready ? null : 'slot_not_ready',
          error_message: ready ? null : '执行槽健康检查未通过',
        })
      } catch (error) {
        const safe = publicError(error)
        return this.store.updateAccount(id, { status: 'error', schedulable: false,
          last_health_check_at: new Date().toISOString(), error_code: safe.code, error_message: safe.message })
      }
    })
  }

  acquireRequest(input = {}) { return this.store.acquireRequest(input) }
  releaseRequest(requestId, outcome = {}) { return this.store.releaseRequest(requestId, outcome) }
  poolStats(filters = {}) { return this.store.poolStats(filters) }

  listAccounts(filters) { return this.store.listAccounts(filters) }
  getAccount(id) {
    const account = this.store.getAccount(id)
    if (!account) throw Object.assign(new Error('账号不存在'), { status: 404, code: 'account_not_found' })
    return account
  }
}
