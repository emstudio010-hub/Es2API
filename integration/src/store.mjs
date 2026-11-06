import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeOpenAICredential, publicCredentialStatus } from './contract.mjs'
import { assertVerifiedCodexIdentity } from '../../vm2api/src/lib/oauth/codex-provider-identity.mjs'

function credentialKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return value
  const text = String(value || '')
  const decoded = /^[a-f\d]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64url')
  if (decoded.length !== 32) throw new TypeError('credential encryption key must encode exactly 32 bytes')
  return decoded
}

function encryptJson(key, value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

function decryptJson(key, envelope) {
  const [version, ivText, tagText, dataText] = String(envelope || '').split('.')
  if (version !== 'v1' || !ivText || !tagText || !dataText) throw new Error('credential envelope is invalid')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  const plain = Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8')
  return JSON.parse(plain)
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function modeltraceBankRevision(challenges, models) {
  const snapshot = {
    challenges: challenges.map(({ id, prompt }) => ({ id, prompt })).sort((a, b) => a.id.localeCompare(b.id)),
    models: models.map(model => ({ id: model.id,
      responses: model.responses.map(({ challenge_id, text }) => ({ challenge_id, text }))
        .sort((a, b) => a.challenge_id.localeCompare(b.challenge_id)),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  }
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

function normalizeDeadline(value, field) {
  if (value == null || value === '') return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new Error(`${field} 必须是有效时间`), { status: 400, code: 'invalid_deadline' })
  }
  return date.toISOString()
}

function publicAccount(row) {
  const savedBinding = parseJson(row.binding_json, {})
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    group_ids: parseJson(row.group_ids, []),
    status: row.status,
    schedulable: row.schedulable === 1,
    concurrency: row.concurrency,
    priority: row.priority,
    provision_generation: Number(row.provision_generation || 1),
    binding: Object.keys(savedBinding).length ? savedBinding : {
      account_id: row.id,
      name: row.name,
      mode: row.mode,
      group_ids: parseJson(row.group_ids, []),
      group_strategy: row.mode === 'lease' ? 'per_slot' : 'shared',
      proxy_id: null,
      ip_policy: 'fixed',
      timezone: null,
      locale: 'en_US.UTF-8',
      max_concurrency: row.concurrency,
      max_rpm: null,
      max_sessions: null,
    },
    credential: {
      has_access_token: row.has_access_token === 1,
      has_refresh_token: row.has_refresh_token === 1,
      has_id_token: row.has_id_token === 1,
      has_api_key: row.has_api_key === 1,
      fingerprint: row.credential_fingerprint,
    },
    vm_id: row.vm_id || null,
    slot: parseJson(row.slot_json, null),
    slot_binding_stale: row.slot_binding_stale === 1,
    isolation: {
      slot_bound: row.vm_id === `es2-${row.id}` && parseJson(row.slot_json, null)?.id === row.vm_id && row.slot_binding_stale !== 1,
      credential_scope: 'account',
      session_scope: 'api_key_group_slot_generation',
      egress_policy: 'fixed_at_create',
      generation: Number(row.provision_generation || 1),
    },
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    deletion_pending: row.deletion_pending === 1,
    group_pause_restore: row.group_pause_restore === 1,
    dispatch: {
      inflight_requests: Number(row.inflight_requests || 0),
      last_used_at: row.last_used_at || null,
      rate_limited_until: row.rate_limited_until || null,
      overload_until: row.overload_until || null,
      temp_unschedulable_until: row.temp_unschedulable_until || null,
      temp_unschedulable_reason: row.temp_unschedulable_reason || null,
      last_health_check_at: row.last_health_check_at || null,
    },
    modeltrace: {
      overrides: parseJson(row.modeltrace_overrides, {}),
      state: parseJson(row.modeltrace_state, {}),
    },
    successful_requests: row.successful_requests,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export class Store {
  constructor({ filename = ':memory:', encryptionKey }) {
    this.key = credentialKey(encryptionKey)
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', strategy TEXT NOT NULL DEFAULT 'shared',
        lease_account_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS account_groups_lease_owner ON account_groups(lease_account_id) WHERE lease_account_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS pool_accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
        group_ids TEXT NOT NULL, credential_ciphertext TEXT NOT NULL,
        credential_fingerprint TEXT NOT NULL UNIQUE,
        has_access_token INTEGER NOT NULL, has_refresh_token INTEGER NOT NULL,
        has_id_token INTEGER NOT NULL, has_api_key INTEGER NOT NULL,
        vm_id TEXT, status TEXT NOT NULL, schedulable INTEGER NOT NULL DEFAULT 0,
        concurrency INTEGER NOT NULL, priority INTEGER NOT NULL,
        provision_generation INTEGER NOT NULL DEFAULT 1,
        binding_json TEXT NOT NULL DEFAULT '{}',
        slot_json TEXT, error_code TEXT, error_message TEXT,
        deletion_pending INTEGER NOT NULL DEFAULT 0,
        group_pause_restore INTEGER NOT NULL DEFAULT 0,
        slot_binding_stale INTEGER NOT NULL DEFAULT 0,
        inflight_requests INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        rate_limited_until TEXT,
        overload_until TEXT,
        temp_unschedulable_until TEXT,
        temp_unschedulable_reason TEXT,
        last_health_check_at TEXT,
        successful_requests INTEGER NOT NULL DEFAULT 0,
        modeltrace_overrides TEXT NOT NULL DEFAULT '{}',
        modeltrace_state TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pool_accounts_status ON pool_accounts(status, schedulable);
      CREATE INDEX IF NOT EXISTS pool_accounts_updated ON pool_accounts(updated_at DESC);
      CREATE TABLE IF NOT EXISTS control_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS modeltrace_runs (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS modeltrace_runs_account_time ON modeltrace_runs(account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS modeltrace_runs_time ON modeltrace_runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS modeltrace_challenges (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS modeltrace_references (
        model TEXT NOT NULL, challenge_id TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY(model,challenge_id),
        FOREIGN KEY(challenge_id) REFERENCES modeltrace_challenges(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS account_model_usage (
        account_id TEXT NOT NULL, model TEXT NOT NULL, upstream_model TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, successful INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account_id,model,upstream_model)
      );
      CREATE TABLE IF NOT EXISTS usage_event_receipts (
        event_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_request_leases (
        request_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        selection_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        acquired_at TEXT NOT NULL,
        released_at TEXT,
        outcome_json TEXT
      );
      CREATE INDEX IF NOT EXISTS account_request_leases_account ON account_request_leases(account_id,state);
      CREATE TABLE IF NOT EXISTS idempotency_records (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        account_id TEXT,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const columns = this.db.prepare('PRAGMA table_info(pool_accounts)').all().map(row => row.name)
    if (!columns.includes('binding_json')) this.db.exec("ALTER TABLE pool_accounts ADD COLUMN binding_json TEXT NOT NULL DEFAULT '{}'")
    const migrations = [
      ['provision_generation', 'ALTER TABLE pool_accounts ADD COLUMN provision_generation INTEGER NOT NULL DEFAULT 1'],
      ['group_pause_restore', 'ALTER TABLE pool_accounts ADD COLUMN group_pause_restore INTEGER NOT NULL DEFAULT 0'],
      ['slot_binding_stale', "ALTER TABLE pool_accounts ADD COLUMN slot_binding_stale INTEGER NOT NULL DEFAULT 0"],
      ['inflight_requests', "ALTER TABLE pool_accounts ADD COLUMN inflight_requests INTEGER NOT NULL DEFAULT 0"],
      ['last_used_at', 'ALTER TABLE pool_accounts ADD COLUMN last_used_at TEXT'],
      ['rate_limited_until', 'ALTER TABLE pool_accounts ADD COLUMN rate_limited_until TEXT'],
      ['overload_until', 'ALTER TABLE pool_accounts ADD COLUMN overload_until TEXT'],
      ['temp_unschedulable_until', 'ALTER TABLE pool_accounts ADD COLUMN temp_unschedulable_until TEXT'],
      ['temp_unschedulable_reason', 'ALTER TABLE pool_accounts ADD COLUMN temp_unschedulable_reason TEXT'],
      ['last_health_check_at', 'ALTER TABLE pool_accounts ADD COLUMN last_health_check_at TEXT'],
      ['provider_identity_key', 'ALTER TABLE pool_accounts ADD COLUMN provider_identity_key TEXT'],
      ['provider_identity_profile', 'ALTER TABLE pool_accounts ADD COLUMN provider_identity_profile TEXT'],
      ['provider_identity_verified_at', 'ALTER TABLE pool_accounts ADD COLUMN provider_identity_verified_at TEXT'],
    ]
    for (const [column, statement] of migrations) {
      if (!columns.includes(column)) this.db.exec(statement)
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS pool_accounts_provider_identity ON pool_accounts(provider_identity_key) WHERE provider_identity_key IS NOT NULL')
    const leaseColumns = this.db.prepare('PRAGMA table_info(account_request_leases)').all().map(row => row.name)
    if (!leaseColumns.includes('selection_hash')) this.db.exec("ALTER TABLE account_request_leases ADD COLUMN selection_hash TEXT NOT NULL DEFAULT ''")
    const recoveredAt = new Date().toISOString()
    this.db.prepare("UPDATE account_request_leases SET state='interrupted',released_at=?,outcome_json=? WHERE state='active'")
      .run(recoveredAt, JSON.stringify({ error_code: 'process_interrupted' }))
    this.db.prepare('UPDATE pool_accounts SET inflight_requests=0 WHERE inflight_requests<>0').run()
    // A probe may have reached the provider before a process restart. Never replay it.
    // Keep the indexed status column and returned JSON payload in sync.
    const interruptedAt = new Date().toISOString()
    const interruptedRuns = this.db.prepare("SELECT id,payload FROM modeltrace_runs WHERE status IN ('queued','running')").all()
    for (const row of interruptedRuns) {
      const run = parseJson(row.payload, { id: row.id })
      run.status = 'interrupted'
      run.finished_at = interruptedAt
      run.error = { code: 'process_interrupted', message: '服务在检测过程中重启；为避免重复调用，不会自动重放' }
      this.db.prepare('UPDATE modeltrace_runs SET status=?,updated_at=?,payload=? WHERE id=?')
        .run(run.status, interruptedAt, JSON.stringify(run), row.id)
    }
    this.db.prepare("UPDATE pool_accounts SET status='error',schedulable=0,error_code='process_interrupted',error_message='上次执行进程中断；可使用原账号 ID 重试' WHERE status='provisioning'")
      .run()
  }

  close() { this.db.close() }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createGroup({ id, name, platform = 'openai', strategy = 'shared', lease_account_id = null }) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO account_groups(id,name,platform,status,strategy,lease_account_id,created_at,updated_at)
      VALUES(?,?,?,'active',?,?,?,?)`).run(id, name, platform, strategy, lease_account_id, now, now)
    return this.getGroup(id)
  }

  getGroup(id) {
    const row = this.db.prepare('SELECT * FROM account_groups WHERE id=?').get(String(id))
    if (!row) return null
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM pool_accounts AS account
      WHERE EXISTS (SELECT 1 FROM json_each(account.group_ids) WHERE json_each.value=?)`).get(String(id)).n
    return { ...row, account_count: count }
  }

  listGroups() {
    const counts = new Map()
    for (const account of this.db.prepare('SELECT group_ids FROM pool_accounts').all()) {
      for (const id of parseJson(account.group_ids, [])) counts.set(id, (counts.get(id) || 0) + 1)
    }
    return this.db.prepare('SELECT * FROM account_groups ORDER BY name COLLATE NOCASE,id').all()
      .map(row => ({ ...row, account_count: counts.get(row.id) || 0 }))
  }

  updateGroup(id, fields) {
    const allowed = ['name', 'status', 'lease_account_id']
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key))
    if (!entries.length) return this.getGroup(id)
    const sets = entries.map(([key]) => `${key}=?`).join(',')
    this.db.prepare(`UPDATE account_groups SET ${sets},updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), new Date().toISOString(), String(id))
    return this.getGroup(id)
  }

  claimLeaseGroup(id, accountId) {
    const result = this.db.prepare("UPDATE account_groups SET lease_account_id=?,strategy='per_slot',updated_at=? WHERE id=? AND (lease_account_id IS NULL OR lease_account_id=?)")
      .run(String(accountId), new Date().toISOString(), String(id), String(accountId))
    return result.changes === 1
  }

  deleteGroup(id) {
    const group = this.getGroup(id)
    if (!group) return false
    if (group.account_count || group.lease_account_id) throw Object.assign(new Error('分组仍有关联账号或租赁保留关系'), { status: 409, code: 'group_in_use' })
    this.db.prepare('DELETE FROM account_groups WHERE id=?').run(String(id))
    return true
  }

  releaseLeaseGroups(accountId) {
    this.db.prepare("UPDATE account_groups SET lease_account_id=NULL,updated_at=? WHERE lease_account_id=?")
      .run(new Date().toISOString(), String(accountId))
  }

  replaceModeltraceBank({ challenges, models }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM modeltrace_references; DELETE FROM modeltrace_challenges;')
      const insertChallenge = this.db.prepare('INSERT INTO modeltrace_challenges(id,prompt,active) VALUES(?,?,1)')
      for (const challenge of challenges) insertChallenge.run(challenge.id, challenge.prompt)
      const insertReference = this.db.prepare('INSERT INTO modeltrace_references(model,challenge_id,response) VALUES(?,?,?)')
      for (const model of models) for (const response of model.responses) insertReference.run(model.id, response.challenge_id, response.text)
      const bank = { challenge_count: challenges.length, models: models.map(model => model.id).sort(),
        revision: modeltraceBankRevision(challenges, models), updated_at: new Date().toISOString() }
      this.setSetting('modeltrace_bank', bank)
      this.db.exec('COMMIT')
      return bank
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  modeltraceBank() {
    const challenges = this.db.prepare('SELECT id,prompt FROM modeltrace_challenges WHERE active=1 ORDER BY id').all()
    const models = this.db.prepare('SELECT DISTINCT model FROM modeltrace_references ORDER BY model').all().map(row => row.model)
    const saved = this.getSetting('modeltrace_bank')
    return { revision: saved?.revision || saved?.updated_at || null, challenges, models }
  }

  modeltraceReferences() {
    return this.db.prepare('SELECT model,challenge_id,response FROM modeltrace_references ORDER BY model,challenge_id').all()
  }

  addModelUsage({ account_id, model, upstream_model, successful }) {
    this.db.prepare(`INSERT INTO account_model_usage(account_id,model,upstream_model,requests,successful) VALUES(?,?,?,1,?)
      ON CONFLICT(account_id,model,upstream_model) DO UPDATE SET requests=requests+1,successful=successful+excluded.successful`)
      .run(String(account_id), String(model), String(upstream_model || model), Number(!!successful))
  }

  accountModelUsage(id) {
    return this.db.prepare('SELECT model,upstream_model,requests,successful FROM account_model_usage WHERE account_id=? ORDER BY successful DESC,requests DESC,model')
      .all(String(id))
  }

  accountForVm(vmId) {
    const rows = this.db.prepare('SELECT * FROM pool_accounts WHERE vm_id=?').all(String(vmId))
    if (rows.length > 1) throw Object.assign(new Error('执行槽绑定不唯一'), { status: 409, code: 'ambiguous_slot_binding' })
    return rows.length ? publicAccount(rows[0]) : null
  }

  recordModelUsage({ account_id, model, upstream_model, successful, event_id, at }) {
    return this.transaction(() => {
      if (event_id) {
        const hash = crypto.createHash('sha256').update(JSON.stringify([account_id, model, upstream_model, successful])).digest('hex')
        const prior = this.db.prepare('SELECT payload_hash FROM usage_event_receipts WHERE event_id=?').get(event_id)
        if (prior) {
          if (prior.payload_hash !== hash) throw Object.assign(new Error('调用事件内容与已接收记录不一致'), { status: 409, code: 'usage_event_conflict' })
          return { duplicate: true }
        }
        this.db.prepare('INSERT INTO usage_event_receipts(event_id,account_id,payload_hash,received_at) VALUES(?,?,?,?)')
          .run(event_id, account_id, hash, at)
      }
      this.addModelUsage({ account_id, model, upstream_model, successful })
      const count = successful ? this.incrementSuccessfulRequests(account_id) : this.getAccount(account_id).successful_requests
      const account = this.getAccount(account_id)
      if (successful) this.updateAccount(account_id, { modeltrace_state: { ...account.modeltrace.state, last_usage_at: at } })
      if (event_id) this.setSetting('modeltrace_usage_bridge', { last_event_at: at })
      return { duplicate: false, count }
    })
  }

  listAccountsNeedingIdentity() {
    return this.db.prepare('SELECT id,credential_fingerprint FROM pool_accounts WHERE provider_identity_key IS NULL ORDER BY id').all()
  }

  providerIdentityKey(id) {
    return this.db.prepare('SELECT provider_identity_key FROM pool_accounts WHERE id=?').get(String(id))?.provider_identity_key || null
  }

  bindProviderIdentity(id, credential, proof, { expectedFingerprint }) {
    const verified = assertVerifiedCodexIdentity(proof, credential)
    const normalized = normalizeOpenAICredential(credential)
    if (publicCredentialStatus(normalized).fingerprint !== expectedFingerprint) throw Object.assign(new Error('身份核对期间凭据已变化'),
      { status: 409, code: 'provider_identity_changed' })
    return this.transaction(() => {
      const row = this.db.prepare('SELECT credential_fingerprint,provider_identity_key FROM pool_accounts WHERE id=?').get(String(id))
      if (!row || row.credential_fingerprint !== expectedFingerprint || row.provider_identity_key && row.provider_identity_key !== verified.identity_key) {
        throw Object.assign(new Error('账号身份或凭据已变化，已保留原记录'), { status: 409, code: 'provider_identity_changed' })
      }
      try {
        this.db.prepare('UPDATE pool_accounts SET provider_identity_key=?,provider_identity_profile=?,provider_identity_verified_at=? WHERE id=? AND credential_fingerprint=?')
          .run(verified.identity_key, verified.profile, verified.verified_at, String(id), expectedFingerprint)
      } catch (error) {
        if (String(error?.message).includes('UNIQUE constraint failed: pool_accounts.provider_identity_key')) throw Object.assign(new Error('存量账号存在相同供应商身份，已保留两条记录和执行槽，请先处理重复账号'),
          { status: 409, code: 'provider_identity_legacy_duplicate' })
        throw error
      }
      return this.getAccount(id)
    })
  }

  createAccount(account, credential, proof) {
    const normalized = normalizeOpenAICredential(credential)
    const verified = assertVerifiedCodexIdentity(proof, normalized)
    const status = publicCredentialStatus(normalized)
    if (this.listAccountsNeedingIdentity().length) throw Object.assign(new Error('存量账号身份尚未确认，未创建新工作区；请先补全存量 OAuth'),
      { status: 409, code: 'provider_identity_inventory_incomplete' })
    const now = new Date().toISOString()
    const result = this.db.prepare(`INSERT INTO pool_accounts(
      id,name,mode,group_ids,credential_ciphertext,credential_fingerprint,
      has_access_token,has_refresh_token,has_id_token,has_api_key,
      status,schedulable,concurrency,priority,binding_json,modeltrace_overrides,created_at,updated_at,
      provider_identity_key,provider_identity_profile,provider_identity_verified_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?, 'provisioning',0,?,?,?,?,?,?,?,?,?)`).run(
      account.id, account.name, account.mode, JSON.stringify(account.group_ids), encryptJson(this.key, normalized),
      status.fingerprint, Number(status.has_access_token), Number(status.has_refresh_token),
      Number(status.has_id_token), Number(status.has_api_key), account.concurrency,
      account.priority, JSON.stringify(account.binding || {}), JSON.stringify(account.modeltrace_overrides), now, now,
      verified.identity_key, verified.profile, verified.verified_at,
    )
    return result.changes === 1 ? this.getAccount(account.id) : null
  }

  getAccount(id, { includeCredential = false } = {}) {
    const row = this.db.prepare('SELECT * FROM pool_accounts WHERE id=?').get(String(id))
    if (!row) return null
    const account = publicAccount(row)
    if (includeCredential) account.credentials = decryptJson(this.key, row.credential_ciphertext)
    return account
  }

  checkpointCredential(id, credential, { vmId, generation, handoffId, expectedFingerprint, identityProof }) {
    const normalized = normalizeOpenAICredential(credential)
    const verified = assertVerifiedCodexIdentity(identityProof, normalized)
    const status = publicCredentialStatus(normalized)
    return this.transaction(() => {
      const account = this.getAccount(id)
      const identity = this.db.prepare('SELECT provider_identity_key FROM pool_accounts WHERE id=?').get(String(id))
      if (!identity?.provider_identity_key || identity.provider_identity_key !== verified.identity_key) throw Object.assign(new Error('交接凭据与原供应商账号身份不符，已保留旧槽'),
        { status: 409, code: 'provider_identity_changed' })
      if (!account || account.vm_id !== vmId || account.provision_generation !== generation
        || account.credential.fingerprint !== expectedFingerprint) {
        throw Object.assign(new Error('账号在凭据交接期间已变化，未保存或删除执行槽'), { status: 409, code: 'credential_handoff_changed' })
      }
      const binding = { ...account.binding, credential_handoff: { id: handoffId, vm_id: vmId,
        generation, fingerprint: status.fingerprint, at: new Date().toISOString() } }
      let result
      try {
        result = this.db.prepare(`UPDATE pool_accounts SET credential_ciphertext=?,credential_fingerprint=?,
          has_access_token=?,has_refresh_token=?,has_id_token=?,has_api_key=?,binding_json=?,updated_at=?,
          provider_identity_profile=?,provider_identity_verified_at=?
          WHERE id=? AND vm_id=? AND provision_generation=? AND credential_fingerprint=?`).run(
          encryptJson(this.key, normalized), status.fingerprint, Number(status.has_access_token),
          Number(status.has_refresh_token), Number(status.has_id_token), Number(status.has_api_key),
          JSON.stringify(binding), new Date().toISOString(), verified.profile, verified.verified_at,
          String(id), vmId, generation, expectedFingerprint,
        )
      } catch (error) {
        if (String(error?.message).includes('UNIQUE constraint failed: pool_accounts.credential_fingerprint')) {
          throw Object.assign(new Error('交接凭据与另一账号重复，保留旧槽并停止重建'), { status: 409, code: 'credential_already_imported' })
        }
        throw error
      }
      if (result.changes !== 1) throw Object.assign(new Error('凭据交接未提交，未删除执行槽'), { status: 409, code: 'credential_handoff_changed' })
      return this.getAccount(id)
    })
  }

  listAccounts({ page = 1, page_size = 50, status, mode, group_id, search } = {}) {
    const size = Math.max(1, Math.min(200, Number(page_size) || 50))
    const current = Math.max(1, Number(page) || 1)
    const where = [], args = []
    for (const [column, value] of [['status', status], ['mode', mode]]) {
      if (value) { where.push(`${column}=?`); args.push(String(value)) }
    }
    if (group_id) {
      where.push('EXISTS (SELECT 1 FROM json_each(pool_accounts.group_ids) AS account_group WHERE account_group.value=?)')
      args.push(String(group_id))
    }
    if (search) { where.push('(instr(lower(name),lower(?))>0 OR instr(lower(id),lower(?))>0)'); args.push(String(search).slice(0, 120), String(search).slice(0, 120)) }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM pool_accounts${clause}`).get(...args).n
    const items = this.db.prepare(`SELECT * FROM pool_accounts${clause} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
      .all(...args, size, (current - 1) * size).map(publicAccount)
    return { items, total, page: current, page_size: size, pages: Math.ceil(total / size) }
  }

  listAllAccounts() {
    return this.db.prepare('SELECT * FROM pool_accounts ORDER BY id').all().map(publicAccount)
  }

  updateAccount(id, fields) {
    if (fields.vm_id != null && fields.vm_id !== `es2-${id}`) {
      throw Object.assign(new Error('执行槽只能绑定所属账号'), { status: 409, code: 'vm2_slot_binding_mismatch' })
    }
    const allowed = new Set(['name', 'group_ids', 'schedulable', 'concurrency', 'priority', 'status', 'vm_id', 'slot_json',
      'error_code', 'error_message', 'deletion_pending', 'group_pause_restore', 'slot_binding_stale', 'inflight_requests', 'last_used_at',
      'provision_generation',
      'rate_limited_until', 'overload_until', 'temp_unschedulable_until', 'temp_unschedulable_reason',
      'last_health_check_at', 'successful_requests', 'modeltrace_overrides', 'modeltrace_state', 'binding'])
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key))
    if (!entries.length) return this.getAccount(id)
    const values = entries.map(([key, value]) => {
      if (key === 'group_ids' || key === 'modeltrace_overrides' || key === 'modeltrace_state') return JSON.stringify(value)
      if (key === 'binding') return JSON.stringify(value)
      if (key === 'slot_json') return value == null ? null : JSON.stringify(value)
      if (key === 'schedulable' || key === 'deletion_pending' || key === 'group_pause_restore' || key === 'slot_binding_stale') return Number(value)
      return value
    })
    const sets = entries.map(([key]) => `${key === 'binding' ? 'binding_json' : key}=?`).join(',')
    this.db.prepare(`UPDATE pool_accounts SET ${sets},updated_at=? WHERE id=?`).run(...values, new Date().toISOString(), String(id))
    return this.getAccount(id)
  }

  deleteAccount(id) { return this.db.prepare('DELETE FROM pool_accounts WHERE id=?').run(String(id)).changes === 1 }

  getIdempotency(key, operation) {
    const row = this.db.prepare('SELECT * FROM idempotency_records WHERE key=? AND operation=?').get(String(key), String(operation))
    return row ? { ...row, response: parseJson(row.response_json, null) } : null
  }

  saveIdempotency({ key, operation, request_hash, account_id, response }) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO idempotency_records(key,operation,request_hash,account_id,response_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET operation=excluded.operation,request_hash=excluded.request_hash,
      account_id=excluded.account_id,response_json=excluded.response_json,updated_at=excluded.updated_at`)
      .run(String(key), String(operation), String(request_hash), account_id ? String(account_id) : null,
        JSON.stringify(response), now, now)
    return this.getIdempotency(key, operation)
  }

  listPoolCandidates({ group_ids = [], mode = null, now = new Date().toISOString() } = {}) {
    const requested = [...new Set((Array.isArray(group_ids) ? group_ids : []).map(value => String(value).trim()).filter(Boolean))]
    const nowMs = Date.parse(now)
    return this.listAllAccounts().filter(account => {
      if (mode && account.mode !== String(mode)) return false
      if (account.status !== 'ready' || !account.schedulable || account.deletion_pending || account.slot_binding_stale) return false
      if (!account.slot?.ready || !account.vm_id) return false
      if (account.dispatch.inflight_requests >= account.concurrency) return false
      if (requested.length && !requested.some(groupId => account.group_ids.includes(groupId))) return false
      if (account.group_ids.some(groupId => this.getGroup(groupId)?.status !== 'active')) return false
      for (const field of ['rate_limited_until', 'overload_until', 'temp_unschedulable_until']) {
        const value = account.dispatch[field]
        if (value && Number.isFinite(Date.parse(value)) && Date.parse(value) > nowMs) return false
      }
      return true
    }).sort((left, right) => {
      const priority = left.priority - right.priority
      if (priority) return priority
      const leftLoad = left.concurrency ? left.dispatch.inflight_requests / left.concurrency : 1
      const rightLoad = right.concurrency ? right.dispatch.inflight_requests / right.concurrency : 1
      if (leftLoad !== rightLoad) return leftLoad - rightLoad
      const leftUsed = left.dispatch.last_used_at ? Date.parse(left.dispatch.last_used_at) : 0
      const rightUsed = right.dispatch.last_used_at ? Date.parse(right.dispatch.last_used_at) : 0
      if (leftUsed !== rightUsed) return leftUsed - rightUsed
      return left.id.localeCompare(right.id)
    })
  }

  acquireRequest({ request_id, account_id = null, group_ids = [], mode = 'pool', now = new Date().toISOString() } = {}) {
    const requestId = String(request_id || '').trim()
    if (!/^[a-z0-9][a-z0-9._:-]{0,191}$/i.test(requestId)) {
      throw Object.assign(new Error('request_id 格式无效'), { status: 400, code: 'invalid_request_id' })
    }
    const selectedMode = String(mode || 'pool').trim().toLowerCase()
    const accountId = account_id == null ? null : String(account_id).trim()
    if (!['pool', 'lease'].includes(selectedMode)) throw Object.assign(new Error('mode 必须为 pool 或 lease'), { status: 400, code: 'invalid_mode' })
    if (selectedMode === 'lease' && !accountId) throw Object.assign(new Error('租赁模式必须指定 account_id'), { status: 400, code: 'lease_account_required' })
    const requestedGroups = [...new Set((Array.isArray(group_ids) ? group_ids : []).map(value => String(value).trim()).filter(Boolean))].sort()
    const selectionHash = crypto.createHash('sha256').update(JSON.stringify({ mode: selectedMode,
      account_id: accountId, group_ids: requestedGroups })).digest('hex')
    const acquire = () => {
      const existing = this.db.prepare('SELECT * FROM account_request_leases WHERE request_id=?').get(requestId)
      if (existing) {
        if (existing.selection_hash && existing.selection_hash !== selectionHash) {
          throw Object.assign(new Error('同一 request_id 不能改变账号选择条件'), { status: 409, code: 'idempotency_conflict' })
        }
        if (existing.state !== 'active') throw Object.assign(new Error('request_id 已释放，不能重复占用账号'), { status: 409, code: 'request_already_released' })
        const account = this.getAccount(existing.account_id)
        if (!account) throw Object.assign(new Error('request_id 绑定的账号已不存在'), { status: 409, code: 'request_account_missing' })
        return { account, request_id: requestId, reused: true, acquired_at: existing.acquired_at }
      }
      const candidates = this.listPoolCandidates({ group_ids: requestedGroups, mode: selectedMode, now })
        .filter(candidate => !accountId || candidate.id === accountId)
      for (const candidate of candidates) {
        const result = this.db.prepare(`UPDATE pool_accounts
          SET inflight_requests=inflight_requests+1,last_used_at=?,updated_at=?
          WHERE id=? AND status='ready' AND schedulable=1 AND deletion_pending=0
            AND slot_binding_stale=0 AND inflight_requests<concurrency`).run(now, now, candidate.id)
        if (result.changes !== 1) continue
        this.db.prepare("INSERT INTO account_request_leases(request_id,account_id,selection_hash,state,acquired_at) VALUES(?,?,?,'active',?)")
          .run(requestId, candidate.id, selectionHash, now)
        return { account: this.getAccount(candidate.id), request_id: requestId, reused: false, acquired_at: now }
      }
      throw Object.assign(new Error('账号池当前没有可调度账号'), { status: 503, code: 'pool_unavailable' })
    }
    return this.db.isTransaction ? acquire() : this.transaction(acquire)
  }

  releaseRequest(request_id, outcome = {}, now = new Date().toISOString()) {
    const requestId = String(request_id || '').trim()
    if (!requestId) throw Object.assign(new Error('request_id is required'), { status: 400, code: 'invalid_request_id' })
    return this.transaction(() => {
      const lease = this.db.prepare('SELECT * FROM account_request_leases WHERE request_id=?').get(requestId)
      if (!lease) return { request_id: requestId, released: false, reason: 'not_found' }
      if (lease.state !== 'active') return { request_id: requestId, account_id: lease.account_id, released: false, reason: `already_${lease.state}` }
      const safeOutcome = {
        success: outcome.success === true,
        error_code: outcome.error_code ? String(outcome.error_code).slice(0, 80) : null,
        rate_limited_until: normalizeDeadline(outcome.rate_limited_until, 'rate_limited_until'),
        overload_until: normalizeDeadline(outcome.overload_until, 'overload_until'),
        temp_unschedulable_until: normalizeDeadline(outcome.temp_unschedulable_until, 'temp_unschedulable_until'),
        temp_unschedulable_reason: outcome.temp_unschedulable_reason ? String(outcome.temp_unschedulable_reason).slice(0, 160) : null,
      }
      const current = this.getAccount(lease.account_id)
      const laterDeadline = (field, next) => {
        const prior = current?.dispatch?.[field] || null
        if (!next) return prior
        if (!prior) return next
        return Date.parse(next) > Date.parse(prior) ? next : prior
      }
      const rateLimitedUntil = laterDeadline('rate_limited_until', safeOutcome.rate_limited_until)
      const overloadUntil = laterDeadline('overload_until', safeOutcome.overload_until)
      const tempUntil = laterDeadline('temp_unschedulable_until', safeOutcome.temp_unschedulable_until)
      const tempReason = safeOutcome.temp_unschedulable_until && tempUntil === safeOutcome.temp_unschedulable_until
        ? safeOutcome.temp_unschedulable_reason : current?.dispatch?.temp_unschedulable_reason || null
      this.db.prepare("UPDATE account_request_leases SET state='released',released_at=?,outcome_json=? WHERE request_id=? AND state='active'")
        .run(now, JSON.stringify(safeOutcome), requestId)
      this.db.prepare(`UPDATE pool_accounts SET inflight_requests=MAX(0,inflight_requests-1),
          rate_limited_until=?,overload_until=?,temp_unschedulable_until=?,temp_unschedulable_reason=?,updated_at=? WHERE id=?`)
        .run(rateLimitedUntil, overloadUntil, tempUntil, tempReason, now, lease.account_id)
      return { request_id: requestId, account_id: lease.account_id, released: true, outcome: safeOutcome }
    })
  }

  poolStats({ group_id, mode, now = new Date().toISOString() } = {}) {
    const accounts = this.listAllAccounts().filter(account => {
      if (mode && account.mode !== String(mode)) return false
      if (group_id && !account.group_ids.includes(String(group_id))) return false
      return true
    })
    const available = this.listPoolCandidates({ group_ids: group_id ? [group_id] : [], mode, now }).length
    return {
      total: accounts.length,
      ready: accounts.filter(account => account.status === 'ready' && account.slot?.ready && !account.deletion_pending).length,
      schedulable: accounts.filter(account => account.schedulable && !account.deletion_pending).length,
      available,
      busy: accounts.filter(account => account.status === 'ready' && account.dispatch.inflight_requests >= account.concurrency).length,
      blocked: accounts.filter(account => ['rate_limited_until', 'overload_until', 'temp_unschedulable_until']
        .some(field => account.dispatch[field] && Date.parse(account.dispatch[field]) > Date.parse(now))).length,
      by_mode: {
        pool: accounts.filter(account => account.mode === 'pool').length,
        lease: accounts.filter(account => account.mode === 'lease').length,
      },
      as_of: now,
    }
  }

  getCredential(id) {
    const row = this.db.prepare('SELECT credential_ciphertext FROM pool_accounts WHERE id=?').get(String(id))
    return row ? decryptJson(this.key, row.credential_ciphertext) : null
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM control_settings WHERE key=?').get(key)
    return row ? parseJson(row.value, null) : null
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO control_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value))
  }

  incrementSuccessfulRequests(id) {
    this.db.prepare('UPDATE pool_accounts SET successful_requests=successful_requests+1,updated_at=? WHERE id=?')
      .run(new Date().toISOString(), String(id))
    return this.db.prepare('SELECT successful_requests FROM pool_accounts WHERE id=?').get(String(id))?.successful_requests ?? null
  }

  saveRun(run) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO modeltrace_runs(id,account_id,status,created_at,updated_at,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload`)
      .run(run.id, String(run.account_id), run.status, run.created_at || now, now, JSON.stringify(run))
  }

  getRun(id) {
    const row = this.db.prepare('SELECT payload FROM modeltrace_runs WHERE id=?').get(String(id))
    return row ? parseJson(row.payload, null) : null
  }

  listRuns({ account_id, status, reason, model, page = 1, page_size = 20 } = {}) {
    const size = Math.max(1, Math.min(100, Number(page_size) || 20))
    const current = Math.max(1, Number(page) || 1)
    const clauses = [], args = []
    if (account_id) { clauses.push('account_id=?'); args.push(String(account_id)) }
    if (status) { clauses.push('status=?'); args.push(String(status)) }
    if (reason) { clauses.push("json_extract(payload,'$.reason')=?"); args.push(String(reason)) }
    if (model) { clauses.push("json_extract(payload,'$.model')=?"); args.push(String(model)) }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM modeltrace_runs${where}`).get(...args).n
    const items = this.db.prepare(`SELECT payload FROM modeltrace_runs${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
      .all(...args, size, (current - 1) * size).map(row => parseJson(row.payload, null))
    return { items, total, page: current, page_size: size, pages: Math.ceil(total / size) }
  }

  runSummary({ account_id } = {}) {
    const where = account_id ? ' WHERE account_id=?' : ''
    const args = account_id ? [String(account_id)] : []
    const rows = this.db.prepare(`SELECT status,COUNT(*) AS count FROM modeltrace_runs${where} GROUP BY status`)
      .all(...args)
    const counts = {}
    for (const row of rows) counts[row.status] = Number(row.count)
    return counts
  }
}

export { publicAccount }
