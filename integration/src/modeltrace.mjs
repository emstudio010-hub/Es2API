import crypto from 'node:crypto'
import { traceDefaults, validateTraceConfig } from './modeltrace-config.mjs'
import { numberFingerprintBank, compareNumberFingerprint } from './number-fingerprint.mjs'
import { publicTraceError } from './trace-response.mjs'

const TIME_TRIGGERS = new Set(['interval', 'both', 'requests_and_interval', 'active_interval'])
const COUNT_TRIGGERS = new Set(['requests', 'both', 'requests_and_interval'])
const requiresUsageBridge = trigger => !['interval', 'manual'].includes(trigger)
function timeValue(value) {
  if (value == null || value === '') return null
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && time >= 0 && time <= 8640000000000000 ? time : null
}

function normalizedName(value) {
  const name = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9._:/-]{0,149}$/i.test(name)) throw Object.assign(new Error('模型名称无效'), { status: 400, code: 'invalid_model' })
  return name
}

function similarity(left, right) {
  const features = text => {
    const normalized = String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
    const result = new Map()
    const words = normalized.match(/[\p{L}\p{N}]+/gu) || []
    for (const word of words) result.set(`w:${word}`, (result.get(`w:${word}`) || 0) + 1)
    const chars = ` ${normalized} `
    for (let i = 0; i + 3 <= chars.length; i++) {
      const gram = `c:${chars.slice(i, i + 3)}`
      result.set(gram, (result.get(gram) || 0) + 1)
    }
    return result
  }
  const a = features(left), b = features(right)
  let dot = 0, normA = 0, normB = 0
  for (const value of a.values()) normA += value * value
  for (const value of b.values()) normB += value * value
  for (const [key, value] of a) dot += value * (b.get(key) || 0)
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Hash only public execution context. The hash is used to prevent an old
 * sample run from changing scheduling state after its slot, binding, policy,
 * or reference bank has drifted. It intentionally contains no credential
 * material beyond the already-public fingerprint.
 */
function traceContext(account, config, bank, model) {
  const slot = account?.slot || null
  const snapshot = {
    model,
    bank_revision: bank?.revision || null,
    account_status: account?.status || null,
    schedulable: account?.schedulable === true,
    deletion_pending: account?.deletion_pending === true,
    slot_binding_stale: account?.slot_binding_stale === true,
    provision_generation: Number(account?.provision_generation || 1),
    vm_id: account?.vm_id || null,
    credential_fingerprint: account?.credential?.fingerprint || null,
    binding: account?.binding || null,
    slot: slot ? {
      id: slot.id || null,
      status: slot.status || null,
      ready: slot.ready === true,
      health: slot.health || null,
      egress: slot.egress || null,
    } : null,
    config,
  }
  return crypto.createHash('sha256').update(stableJson(snapshot)).digest('hex')
}

export function compareResponses(samples, references, expectedModel, confidenceThreshold = 0.8) {
  const expected = normalizedName(expectedModel)
  const modelNames = [...new Set(references.map(row => row.model))].sort()
  if (!modelNames.includes(expected)) return { status: 'unlisted_model', expected_model: expected, actionable: false, used_outputs: samples.length }
  const byChallenge = new Map()
  for (const row of references) {
    if (!byChallenge.has(row.challenge_id)) byChallenge.set(row.challenge_id, new Map())
    byChallenge.get(row.challenge_id).set(row.model, row.response)
  }
  const scores = modelNames.map(model => {
    const observed = samples.map(sample => {
      const reference = byChallenge.get(sample.challenge_id)?.get(model)
      return typeof reference === 'string' ? similarity(sample.text, reference) : null
    }).filter(value => value !== null)
    return { model, score: observed.length ? observed.reduce((sum, n) => sum + n, 0) / observed.length : 0, samples: observed.length }
  }).sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))
  const prediction = scores[0]?.model || null
  const confidence = scores[0]?.score || 0
  const status = samples.length < 3 ? 'insufficient_samples' : confidence < confidenceThreshold ? 'inconclusive' : prediction === expected ? 'match' : 'suspected_mismatch'
  return { status, expected_model: expected, prediction, confidence, scores, used_outputs: samples.length,
    actionable: status === 'suspected_mismatch' }
}

export function validateModeltraceBank(input) {
  const challenges = Array.isArray(input?.challenges) ? input.challenges : []
  const models = Array.isArray(input?.models) ? input.models : []
  if (challenges.length < 3 || challenges.length > 100) throw Object.assign(new Error('挑战集需要包含 3–100 项'), { status: 400, code: 'invalid_bank' })
  const ids = new Set()
  const normalizedChallenges = challenges.map((item, index) => {
    const id = String(item?.id || '').trim()
    const prompt = String(item?.prompt || '').trim()
    if (!id || id.length > 100 || ids.has(id) || !prompt || prompt.length > 12000) throw Object.assign(new Error(`挑战项 ${index + 1} 格式无效`), { status: 400, code: 'invalid_bank' })
    ids.add(id)
    return { id, prompt }
  })
  if (models.length < 2 || models.length > 100) throw Object.assign(new Error('参考库需要包含 2–100 个模型'), { status: 400, code: 'invalid_bank' })
  const modelIds = new Set()
  const normalizedModels = models.map(model => {
    const id = normalizedName(model?.id)
    if (modelIds.has(id) || !Array.isArray(model.responses)) throw Object.assign(new Error('参考模型重复或响应列表格式无效'), { status: 400, code: 'invalid_bank' })
    modelIds.add(id)
    const responses = model.responses.map(item => {
      const challenge_id = String(item?.challenge_id || '')
      const text = String(item?.text || '').trim()
      if (!ids.has(challenge_id) || !text || text.length > 64000) throw Object.assign(new Error(`模型 ${id} 的参考响应无效`), { status: 400, code: 'invalid_bank' })
      return { challenge_id, text }
    })
    if (responses.length !== challenges.length || new Set(responses.map(item => item.challenge_id)).size !== challenges.length) {
      throw Object.assign(new Error(`模型 ${id} 必须为每个挑战提供一条参考响应`), { status: 400, code: 'invalid_bank' })
    }
    return { id, responses }
  })
  return { challenges: normalizedChallenges, models: normalizedModels }
}

export class ModelTrace {
  constructor({ store, accountPool, runner, usageBridgeConfigured = false, clock = () => Date.now(), random = Math.random, triggerRandom = Math.random } = {}) {
    if (!store || !accountPool) throw new TypeError('store and accountPool are required')
    Object.assign(this, { store, accountPool, runner, usageBridgeConfigured, clock, random, triggerRandom })
    this.jobs = new Map()
    this.closed = false
    if (!this.store.getSetting('modeltrace_config')) this.store.setSetting('modeltrace_config', { ...traceDefaults })
  }

  getGlobalConfig() { return validateTraceConfig(this.store.getSetting('modeltrace_config') || traceDefaults) }
  getAccountConfig(account) {
    const global = this.getGlobalConfig()
    const overrides = account.modeltrace?.overrides || {}
    const defaultEnabled = account.mode === 'lease' ? false : true
    const enabled = Object.prototype.hasOwnProperty.call(overrides, 'enabled') ? overrides.enabled === true : defaultEnabled
    const merged = validateTraceConfig({ ...global, ...overrides })
    return { ...merged, enabled: global.enabled && enabled }
  }

  selectModel(account, config = this.getAccountConfig(account)) {
    if (config.model_mode === 'most_used') {
      const activeBank = this.bank()
      const known = new Set([...activeBank.models, ...Object.keys(activeBank.aliases || {})])
      const selected = this.store.accountModelUsage(account.id)
        .filter(row => row.successful > 0 && row.upstream_model === row.model && known.has(row.model))
        .sort((a, b) => b.successful - a.successful || b.requests - a.requests || a.model.localeCompare(b.model))[0]
      if (selected) return { model: selected.model, source: 'most_used', successful_requests: selected.successful }
    }
    return { model: config.model, source: config.model_mode === 'most_used' ? 'fallback' : 'specified', successful_requests: 0 }
  }

  configureGlobal(input) {
    const config = validateTraceConfig({ ...this.getGlobalConfig(), ...(input || {}) })
    this.store.setSetting('modeltrace_config', config)
    for (const account of this.store.listAllAccounts()) {
      const effective = this.getAccountConfig(account)
      const state = { ...account.modeltrace.state, checkpoint: account.successful_requests,
        consecutive: 0, evidence_context: null,
        last_finished_at: this.lastFinishedAt(account),
        next_due: effective.enabled && TIME_TRIGGERS.has(effective.trigger) ? this.clock() + effective.interval_seconds * 1000 : null }
      this.store.updateAccount(account.id, { modeltrace_state: state })
    }
    return config
  }

  configureAccount(id, input) {
    const account = this.accountPool.getAccount(id)
    const payload = { ...(input || {}) }
    const inherit = payload.inherit === true
    delete payload.inherit
    let overrides = validateTraceConfig(payload, { partial: true })
    if (inherit) overrides = {}
    else overrides = { ...(account.modeltrace.overrides || {}), ...overrides }
    const effective = this.getAccountConfig({ ...account, modeltrace: { overrides } })
    const state = { ...account.modeltrace.state, checkpoint: account.successful_requests,
      last_finished_at: this.lastFinishedAt(account),
      next_due: effective.enabled && TIME_TRIGGERS.has(effective.trigger)
        ? this.clock() + effective.interval_seconds * 1000 : null,
      consecutive: 0, evidence_context: null }
    this.store.updateAccount(id, { modeltrace_overrides: overrides, modeltrace_state: state })
    return { overrides, effective_config: effective }
  }

  bank() {
    const bank = this.store.modeltraceBank()
    if (!bank.challenges.length && !bank.models.length) return numberFingerprintBank()
    return { ...bank, ready: bank.challenges.length >= 3 && bank.models.length >= 2, source: 'administrator-import', method: 'text-similarity' }
  }

  readiness(account) {
    const bank = this.bank()
    const config = account ? this.getAccountConfig(account) : this.getGlobalConfig()
    const selection = account ? this.selectModel(account, config) : { model: config.model }
    const blockers = []
    if (typeof this.runner !== 'function') blockers.push('trace_runner_unavailable')
    if (!bank.ready) blockers.push('trace_bank_missing')
    if (!bank.models.includes(bank.aliases?.[selection.model] || selection.model)) blockers.push('trace_model_unlisted')
    if (bank.challenges.length < config.sample_count || (bank.calibrated_samples && config.sample_count !== bank.calibrated_samples)) blockers.push('trace_challenges_insufficient')
    if (account && !this.isSlotReady(account)) blockers.push('slot_not_ready')
    if (!account && !this.store.listAllAccounts().some(item => this.isSlotReady(item))) blockers.push('trace_account_missing')
    return { ready: blockers.length === 0, blockers, runner_configured: typeof this.runner === 'function', model: selection.model }
  }

  summary() {
    const counts = this.store.runSummary()
    const accounts = this.store.listAllAccounts().map(account => ({
      account_id: account.id,
      enabled: this.getAccountConfig(account).enabled,
      schedulable: account.schedulable,
      last_run_id: account.modeltrace.state?.last_run_id || null,
      last_status: account.modeltrace.state?.last_status || null,
      consecutive_mismatches: Number(account.modeltrace.state?.consecutive || 0),
      readiness: this.readiness(account),
      automation: this.automation(account),
    }))
    return {
      config: this.getGlobalConfig(),
      bank: this.bank(),
      readiness: this.readiness(),
      usage_bridge: { configured: this.usageBridgeConfigured, last_event_at: this.store.getSetting('modeltrace_usage_bridge')?.last_event_at || null,
        ...(this.store.getSetting('modeltrace_usage_bridge_poll') || {}) },
      active_runs: this.jobs.size,
      run_counts: counts,
      accounts,
      as_of: new Date(this.clock()).toISOString(),
    }
  }

  installBank(input) {
    const bank = validateModeltraceBank(input)
    const saved = this.store.replaceModeltraceBank(bank)
    for (const account of this.store.listAllAccounts()) {
      const state = { ...account.modeltrace.state, consecutive: 0, evidence_context: null }
      this.store.updateAccount(account.id, { modeltrace_state: state })
    }
    return saved
  }

  automation(account) {
    const config = this.getAccountConfig(account)
    const state = account.modeltrace.state || {}
    const count = Math.max(0, account.successful_requests - Number(state.checkpoint || 0))
    const blocked = [...this.readiness(account).blockers]
    if (!config.enabled) blocked.push('auto_disabled')
    if (config.trigger === 'manual') blocked.push('auto_manual')
    if (!account.schedulable) blocked.push('account_unschedulable')
    if (requiresUsageBridge(config.trigger) && !this.usageBridgeConfigured) blocked.push('trace_usage_bridge_unconfigured')
    const cooldown = this.cooldown(account, config)
    const lastUsage = timeValue(state.last_usage_at)
    const nextDue = timeValue(state.next_due)
    return { enabled: config.enabled, trigger: config.trigger, every_requests: config.every_requests,
      sampling_probability: config.sampling_probability, idle_seconds: config.idle_seconds, cooldown_seconds: config.cooldown_seconds,
      cooldown_until: cooldown.until === null ? null : new Date(cooldown.until).toISOString(),
      cooldown_remaining_seconds: cooldown.remaining_seconds,
      idle_due_at: config.trigger === 'idle_return' && lastUsage !== null ? new Date(lastUsage + config.idle_seconds * 1000).toISOString() : null,
      successful_since_check: count,
      remaining_requests: COUNT_TRIGGERS.has(config.trigger) ? Math.max(0, config.every_requests - count) : null,
      next_due: nextDue !== null && TIME_TRIGGERS.has(config.trigger) ? new Date(nextDue).toISOString() : null,
      active_run_id: this.jobs.get(account.id)?.run.id || null, last_usage_at: state.last_usage_at || null,
      blocked_reasons: blocked, ready: blocked.length === 0 }
  }

  lastFinishedAt(account) {
    const state = account.modeltrace?.state || {}
    const stored = timeValue(state.last_finished_at)
    if (stored !== null) return stored
    return state.last_run_id ? timeValue(this.store.getRun(state.last_run_id)?.finished_at) : null
  }

  cooldown(account, config = this.getAccountConfig(account)) {
    const lastFinished = this.lastFinishedAt(account)
    const until = config.cooldown_seconds > 0 && lastFinished !== null ? lastFinished + config.cooldown_seconds * 1000 : null
    return { until, remaining_seconds: until === null ? 0 : Math.max(0, Math.ceil((until - this.clock()) / 1000)) }
  }

  ensureTimeSchedule(account, config) {
    const state = account.modeltrace.state || {}
    if (!TIME_TRIGGERS.has(config.trigger) || timeValue(state.next_due) !== null) return account
    const baseline = this.lastFinishedAt(account) ?? this.clock()
    const next = { ...state, next_due: baseline + config.interval_seconds * 1000 }
    // Old accounts may already have valid usage. Initializing their clock must
    // not move the successful-request checkpoint or discard that activity.
    this.store.updateAccount(account.id, { modeltrace_state: next })
    return { ...account, modeltrace: { ...account.modeltrace, state: next } }
  }

  async recordUsage({ account_id, vm_id, event_id, model, upstream_model, success, source }) {
    if (source === 'vm2' || vm_id != null || event_id != null) {
      if (typeof event_id !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(event_id) || typeof vm_id !== 'string' || !vm_id || vm_id.length > 200) {
        throw Object.assign(new Error('调用事件必须包含有效事件 ID 和执行槽 ID'), { status: 400, code: 'invalid_usage_event' })
      }
      const bound = this.store.accountForVm(vm_id)
      if (!bound) return null // VM2 may also serve slots outside this account pool.
      if (account_id && account_id !== bound.id) throw Object.assign(new Error('调用事件与执行槽绑定不一致'), { status: 409, code: 'usage_binding_conflict' })
      account_id = bound.id
    }
    const requestedModel = normalizedName(model)
    const selectedUpstreamModel = normalizedName(upstream_model || requestedModel)
    const account = this.accountPool.getAccount(account_id)
    const previousUsage = timeValue(account.modeltrace.state?.last_usage_at)
    const { duplicate } = this.store.recordModelUsage({ account_id, model: requestedModel, upstream_model: selectedUpstreamModel,
      successful: success === true, event_id, at: new Date(this.clock()).toISOString() })
    if (duplicate || success !== true || this.closed) return null
    let current = this.accountPool.getAccount(account_id)
    const config = this.getAccountConfig(current)
    if (!config.enabled || !this.isAutomaticReady(current) || this.jobs.has(String(account_id)) || config.trigger === 'manual') return null
    current = this.ensureTimeSchedule(current, config)
    if (this.cooldown(current, config).remaining_seconds > 0 || !this.readiness(current).ready) return null
    const state = current.modeltrace.state || {}
    const count = Math.max(0, current.successful_requests - Number(state.checkpoint || 0))
    const now = this.clock()
    const due = timeValue(state.next_due)
    const timeDue = due !== null && due <= now
    let reason = null
    if (['requests', 'both'].includes(config.trigger) && count >= config.every_requests) reason = 'requests'
    else if (config.trigger === 'requests_and_interval' && count >= config.every_requests && timeDue) reason = config.trigger
    else if (config.trigger === 'active_interval' && count > 0 && timeDue) reason = config.trigger
    else if (config.trigger === 'probability' && this.triggerRandom() < config.sampling_probability) reason = config.trigger
    else if (config.trigger === 'idle_return' && (previousUsage === null || now - previousUsage >= config.idle_seconds * 1000)) reason = config.trigger
    return reason ? this.enqueue(account_id, reason) : null
  }

  isAutomaticReady(account) {
    return this.isSlotReady(account) && account.schedulable
  }

  isSlotReady(account) {
    const slot = account?.slot || {}
    const statusReady = slot.status == null || slot.status === 'running'
    return account?.status === 'ready' && !account.deletion_pending && !account.slot_binding_stale &&
      slot.ready === true && statusReady && !!account.vm_id
  }

  tick() {
    if (this.closed) return
    for (let account of this.store.listAllAccounts()) {
      const config = this.getAccountConfig(account)
      if (!config.enabled || !this.isAutomaticReady(account) || !this.readiness(account).ready || !TIME_TRIGGERS.has(config.trigger) || this.jobs.has(account.id)) continue
      account = this.ensureTimeSchedule(account, config)
      if (this.cooldown(account, config).remaining_seconds > 0) continue
      const state = account.modeltrace.state || {}
      const count = Math.max(0, account.successful_requests - Number(state.checkpoint || 0))
      if (state.next_due > this.clock()) continue
      if (config.trigger === 'requests_and_interval' && count < config.every_requests) continue
      if (config.trigger === 'active_interval' && count < 1) continue
      const reason = ['interval', 'both'].includes(config.trigger) ? 'interval' : config.trigger
      try { this.enqueue(account.id, reason) } catch { /* persisted failure is reported by run() */ }
    }
  }

  enqueue(id, reason = 'manual') {
    if (this.closed) throw Object.assign(new Error('ModelTrace 正在关闭'), { status: 503, code: 'service_closing' })
    if (this.jobs.has(String(id))) return this.jobs.get(String(id)).run
    const account = this.accountPool.getAccount(id)
    if (!this.isSlotReady(account)) {
      throw Object.assign(new Error('账号执行槽未就绪'), { status: 409, code: 'slot_not_ready' })
    }
    const config = this.getAccountConfig(account)
    const selection = this.selectModel(account, config)
    if (typeof this.runner !== 'function') throw Object.assign(new Error('ModelTrace 执行器未配置'), { status: 503, code: 'trace_runner_unavailable' })
    if (reason !== 'manual' && !config.enabled) throw Object.assign(new Error('账号未启用自动检测'), { status: 409, code: 'trace_disabled' })
    if (reason !== 'manual' && this.cooldown(account, config).remaining_seconds > 0) throw Object.assign(new Error('账号仍在检测冷却期'), { status: 409, code: 'trace_cooldown' })
    if (!this.bank().ready) throw Object.assign(new Error('请先安装至少包含三个挑战和两个模型的参考指纹库'), { status: 409, code: 'trace_bank_missing' })
    const bank = this.bank()
    if (!bank.models.includes(bank.aliases?.[selection.model] || selection.model)) throw Object.assign(new Error(`参考库未包含目标模型 ${selection.model}`), { status: 409, code: 'trace_model_unlisted' })
    if (bank.challenges.length < config.sample_count || (bank.calibrated_samples && config.sample_count !== bank.calibrated_samples)) throw Object.assign(new Error('参考挑战不足，内置数字指纹库仅校准了三个独立样本'), { status: 409, code: 'trace_challenges_insufficient' })
    const controller = new AbortController()
    const run = { id: crypto.randomUUID(), account_id: String(id), reason, status: 'queued',
      created_at: new Date(this.clock()).toISOString(), model: selection.model, expected_model: selection.model, model_selection: selection,
      applied_action: 'none', sample_count: config.sample_count, bank_revision: bank.revision, method: bank.method }
    this.store.saveRun(run)
    const task = { run, controller }
    this.jobs.set(String(id), task)
    task.promise = this.executeRun(task).finally(() => this.jobs.delete(String(id)))
    return run
  }

  async executeRun(task) {
    const { run, controller } = task
    const account = this.accountPool.getAccount(run.account_id)
    const config = this.getAccountConfig(account)
    const bank = this.bank()
    const references = this.store.modeltraceReferences()
    const referenceByChallenge = new Map()
    for (const row of references) {
      if (!referenceByChallenge.has(row.challenge_id)) referenceByChallenge.set(row.challenge_id, [])
      referenceByChallenge.get(row.challenge_id).push(row)
    }
    const context = traceContext(account, config, bank, run.model)
    run.status = 'running'; run.started_at = new Date(this.clock()).toISOString(); this.store.saveRun(run)
    const previous = account.modeltrace.state || {}
    this.store.updateAccount(run.account_id, { modeltrace_state: { ...previous, checkpoint: account.successful_requests,
      next_due: null } })
    let sampleContext = null
    let phase = 'sampling'
    try {
      if (typeof this.runner !== 'function') throw Object.assign(new Error('ModelTrace 执行器未配置'), { code: 'trace_runner_unavailable' })
      const candidates = [...bank.challenges]
      const picked = []
      while (picked.length < config.sample_count && candidates.length) {
        const index = Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))
        picked.push(candidates.splice(index, 1)[0])
      }
      const samples = []
      for (const challenge of picked) {
        sampleContext = { sample_index: samples.length + 1, challenge_id: challenge.id,
          completed_samples: samples.length, timeout_ms: config.timeout_ms }
        const sampleStarted = this.clock()
        run.progress = { ...sampleContext, phase, total_samples: config.sample_count,
          sample_started_at: new Date(sampleStarted).toISOString() }
        this.store.saveRun(run)
        if (controller.signal.aborted) throw Object.assign(new Error('检测已取消'), { code: 'trace_canceled' })
        const currentAccount = this.store.getAccount(run.account_id)
        if (!this.isSlotReady(currentAccount)) throw Object.assign(new Error('检测期间执行槽状态已变化'), { code: 'trace_context_changed' })
        const output = await this.runner({ account: currentAccount, model: run.model, challenge, signal: controller.signal, timeout_ms: config.timeout_ms })
        if (controller.signal.aborted) throw Object.assign(new Error('检测已取消'), { code: 'trace_canceled' })
        const text = typeof output?.text === 'string' ? output.text : ''
        if (!text || text.length > 64000) throw Object.assign(new Error('检测样本为空或超过长度限制'), { code: 'invalid_trace_sample' })
        samples.push({ challenge_id: challenge.id, expected_count: challenge.expected_count, text, sha256: crypto.createHash('sha256').update(text).digest('hex'), length: text.length, duration_ms: Math.max(0, this.clock() - sampleStarted), usage: output.usage || null })
        run.samples = samples.map(({ text, ...sample }) => sample)
        run.progress.completed_samples = samples.length
        this.store.saveRun(run)
      }
      phase = 'comparison'
      run.progress = { phase, completed_samples: samples.length, total_samples: config.sample_count }
      const result = bank.method === 'shared-detector-v2'
        ? compareNumberFingerprint(samples, run.model, config.confidence_threshold)
        : { ...compareResponses(samples, references, run.model, config.confidence_threshold), method: 'text-similarity' }
      run.result = result
      run.samples = samples.map(({ text, ...sample }) => sample)
      run.status = result.status
      run.finished_at = new Date(this.clock()).toISOString()
      run.duration_ms = this.clock() - Date.parse(run.started_at)
      const currentAccount = this.store.getAccount(run.account_id)
      const currentConfig = currentAccount ? this.getAccountConfig(currentAccount) : config
      const currentBank = this.bank()
      const currentContext = traceContext(currentAccount, currentConfig, currentBank, run.model)
      phase = 'action'
      run.progress.phase = phase
      if (!this.isSlotReady(currentAccount) || currentContext !== context) {
        run.action_skipped_reason = '检测期间策略、目标模型、指纹库或执行槽状态发生变化；本次结果不执行账号动作'
        if (currentAccount) this.store.updateAccount(run.account_id, { modeltrace_state: { ...(currentAccount.modeltrace.state || {}),
          checkpoint: currentAccount.successful_requests, last_run_id: run.id, last_status: run.status,
          consecutive: 0, evidence_context: null } })
      } else {
        this.applyAction(run, config, context)
      }
    } catch (error) {
      run.status = controller.signal.aborted ? 'canceled' : 'error'
      run.error = { ...publicTraceError(error, controller.signal.aborted), phase,
        ...(phase === 'sampling' && sampleContext ? { ...sampleContext,
          sample_duration_ms: Math.max(0, this.clock() - Date.parse(run.progress.sample_started_at)) } : {}) }
      // Sampling/comparison failures cannot produce attribution. If an action
      // write fails after comparison, retain the result and any recorded action.
      if (phase !== 'action') delete run.result
      run.finished_at = new Date(this.clock()).toISOString()
      run.duration_ms = this.clock() - Date.parse(run.started_at)
      const currentAccount = this.store.getAccount(run.account_id)
      if (currentAccount) {
        const state = currentAccount.modeltrace.state || {}
        this.store.updateAccount(run.account_id, { modeltrace_state: { ...state, checkpoint: currentAccount.successful_requests,
          last_run_id: run.id, last_status: run.status, consecutive: 0, evidence_context: null } })
      }
    }
    if (run.progress) run.progress.phase = 'finished'
    const finishedAccount = this.store.getAccount(run.account_id)
    if (finishedAccount) {
      const effective = this.getAccountConfig(finishedAccount)
      const finishedAt = timeValue(run.finished_at) ?? this.clock()
      this.store.updateAccount(run.account_id, { modeltrace_state: { ...finishedAccount.modeltrace.state,
        last_finished_at: finishedAt,
        next_due: effective.enabled && TIME_TRIGGERS.has(effective.trigger) ? finishedAt + effective.interval_seconds * 1000 : null } })
    }
    this.store.saveRun(run)
    return run
  }

  applyAction(run, config, context) {
    const account = this.accountPool.getAccount(run.account_id)
    const prior = account.modeltrace.state || {}
    const consecutive = run.status === 'suspected_mismatch'
      ? (prior.evidence_context === context ? Number(prior.consecutive || 0) : 0) + 1
      : 0
    const state = { ...prior, checkpoint: account.successful_requests, last_run_id: run.id,
      last_status: run.status, consecutive, evidence_context: context }
    if (run.result?.actionable && consecutive >= config.consecutive_mismatches) {
      if (config.action === 'deprioritize' && !prior.deprioritized) {
        state.deprioritized = true
        state.original_priority = account.priority
        this.store.updateAccount(run.account_id, { priority: Math.min(100000, account.priority + 10) })
        run.applied_action = 'deprioritize'
      }
      if (config.action === 'pause' && !prior.auto_paused) {
        state.auto_paused = true
        state.original_schedulable = account.schedulable
        this.store.updateAccount(run.account_id, { schedulable: false })
        run.applied_action = 'pause'
      }
    }
    this.store.updateAccount(run.account_id, { modeltrace_state: state })
  }

  cancel(id, runId = null) {
    const key = runId ? String(id) : (this.jobs.has(String(id)) ? String(id)
      : [...this.jobs.entries()].find(([, task]) => task.run.id === String(id))?.[0])
    const task = key ? this.jobs.get(key) : null
    if (!task) return false
    if (runId && task.run.id !== String(runId)) return false
    task.controller.abort()
    return true
  }

  async wait(id) {
    const key = this.jobs.has(String(id)) ? String(id) : [...this.jobs.entries()].find(([, task]) => task.run.id === String(id))?.[0]
    const task = key ? this.jobs.get(key) : null
    if (task) await task.promise
    return this.store.getRun(id)
  }

  run(id) { return this.enqueue(id, 'manual') }

  async cancelAccountAndWait(id) {
    const task = this.jobs.get(String(id))
    if (!task) return
    task.controller.abort()
    await task.promise
  }

  async close() {
    this.closed = true
    for (const task of this.jobs.values()) task.controller.abort()
    await Promise.all([...this.jobs.values()].map(task => task.promise))
  }
}
