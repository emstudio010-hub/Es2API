import crypto from 'node:crypto'
import { createGatewayCompletionObserver } from './gateway-response.mjs'

const TTL = 24 * 60 * 60 * 1000
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const incarnation = account => hash(`${account.created_at}:${account.credential?.fingerprint}`)
const denied = () => Object.assign(new Error('Session cannot continue on its original execution slot'), { status: 409, code: 'session_isolation_conflict' })

// Only hashes and routing identities are persisted. No prompts, credentials,
// raw conversation IDs, or response payloads belong in this index.
export class GatewayIsolation {
  constructor(store) {
    this.store = store
    store.db.exec(`CREATE TABLE IF NOT EXISTS gateway_bindings (
      scope TEXT NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL,
      account_id TEXT NOT NULL, vm_id TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL,
      expires_at INTEGER NOT NULL, PRIMARY KEY(scope,kind,identity)
    ); CREATE INDEX IF NOT EXISTS gateway_bindings_expiry ON gateway_bindings(expires_at);`)
    this.cleanupAt = 0
  }

  context(req, groupId, body = {}, fallback = crypto.randomUUID()) {
    const caller = req.headers['x-es2api-caller']
    if (typeof caller !== 'string' || !/^[a-f0-9]{64}$/.test(caller)) {
      throw Object.assign(new Error('A trusted caller namespace is required'), { status: 401, code: 'caller_namespace_required' })
    }
    const values = [req.headers['x-session-id'], req.headers['session_id'], req.headers['session-id'], req.headers['thread-id'],
      req.headers['conversation_id'], body.prompt_cache_key, body.conversation_id, body.session_id]
    const session = values.find(value => typeof value === 'string' && value.trim()) || fallback
    if (String(session).length > 4096 || (body.previous_response_id != null &&
      (typeof body.previous_response_id !== 'string' || !body.previous_response_id || body.previous_response_id.length > 512))) {
      throw Object.assign(new Error('Invalid continuation identity'), { status: 400, code: 'invalid_session_identity' })
    }
    const references = Array.isArray(body.input) ? body.input.filter(item => item?.type === 'item_reference').map(item => {
      if (typeof item.id !== 'string' || !item.id || item.id.length > 512) throw denied()
      return hash(item.id)
    }) : []
    return { scope: hash(groupId + ':' + caller), session: hash(session), previous: body.previous_response_id ? hash(body.previous_response_id) : null, references }
  }

  lookup(context, kind, identity) {
    if (!identity) return null
    return this.store.db.prepare('SELECT * FROM gateway_bindings WHERE scope=? AND kind=? AND identity=? AND expires_at>?')
      .get(context.scope, kind, identity, Date.now()) || null
  }

  assertAccount(account, binding = null) {
    if (!account || account.vm_id !== `es2-${account.id}` || account.slot?.id !== account.vm_id ||
      account.slot_binding_stale || !account.slot.ready || account.deletion_pending) throw denied()
    if (binding && (binding.account_id !== account.id || binding.vm_id !== account.vm_id || binding.generation !== account.provision_generation || (binding.incarnation && binding.incarnation !== incarnation(account)))) throw denied()
    return account
  }

  assertReferences(context, account) {
    for (const identity of context.references || []) {
      const binding = this.lookup(context, 'item', identity)
      if (!binding) throw denied()
      this.assertAccount(account, binding)
    }
  }

  select(context, group, accountPool, pinnedAccount = null) {
    // Synchronous transaction prevents concurrent first turns from selecting
    // different slots for the same caller/session.
    return this.store.transaction(() => {
      const prior = this.lookup(context, 'response', context.previous)
      if (context.previous && !prior) throw denied()
      const session = this.lookup(context, 'session', context.session)
      if (session && prior && (session.account_id !== prior.account_id || session.generation !== prior.generation || session.vm_id !== prior.vm_id)) throw denied()
      const firstReference = context.references.length ? this.lookup(context, 'item', context.references[0]) : null
      if (context.references.length && !firstReference) throw denied()
      const binding = prior || session || firstReference
      if (pinnedAccount) {
        this.assertAccount(this.store.getAccount(pinnedAccount.id), { account_id: pinnedAccount.id,
          vm_id: pinnedAccount.vm_id, generation: pinnedAccount.provision_generation, incarnation: incarnation(pinnedAccount) })
        if (binding) this.assertAccount(pinnedAccount, binding)
        if (group.strategy === 'per_slot' && group.lease_account_id !== pinnedAccount.id) throw denied()
      }
      const requested = pinnedAccount?.id || binding?.account_id || (group.strategy === 'per_slot' ? group.lease_account_id : null)
      if (binding) this.assertAccount(this.store.getAccount(requested), binding)
      // Store.acquireRequest already owns a transaction; select it through its
      // transaction-free implementation while this outer transaction is held.
      const lease = accountPool.acquireRequest({ request_id: crypto.randomUUID(), group_ids: [group.id],
        mode: group.strategy === 'per_slot' ? 'lease' : 'pool', ...(requested ? { account_id: requested } : {}) })
      this.assertAccount(lease.account, binding)
      this.assertReferences(context, lease.account)
      this.remember(context, 'session', context.session, lease.account)
      return lease
    })
  }

  remember(context, kind, identity, account) {
    if (!identity) return
    this.assertAccount(account)
    const prior = this.lookup(context, kind, identity)
    if (prior) this.assertAccount(account, prior)
    if (Date.now() >= this.cleanupAt) {
      this.store.db.prepare('DELETE FROM gateway_bindings WHERE expires_at<=?').run(Date.now())
      this.cleanupAt = Date.now() + 60000
    }
    const exists = this.store.db.prepare('SELECT 1 FROM gateway_bindings WHERE scope=? AND kind=? AND identity=?').get(context.scope, kind, identity)
    if (!exists && this.store.db.prepare('SELECT COUNT(*) AS n FROM gateway_bindings').get().n >= 200000) throw Object.assign(new Error('Session registry is at capacity'), { status: 503, code: 'session_registry_full' })
    this.store.db.prepare(`INSERT INTO gateway_bindings(scope,kind,identity,account_id,vm_id,generation,incarnation,expires_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,kind,identity) DO UPDATE SET account_id=excluded.account_id,vm_id=excluded.vm_id,generation=excluded.generation,incarnation=excluded.incarnation,expires_at=excluded.expires_at`)
      .run(context.scope, kind, identity, account.id, account.vm_id, account.provision_generation, incarnation(account), Date.now() + TTL)
  }

  observe(context, account, payload) {
    const response = payload?.response || payload
    if ((payload?.type?.startsWith('response.') || response?.object === 'response') && typeof response.id === 'string' && response.id.length <= 512) {
      this.remember(context, 'response', hash(response.id), account)
    }
    const items = [...(Array.isArray(response?.output) ? response.output : []), ...(payload?.item ? [payload.item] : [])]
    for (const item of items) if (typeof item?.id === 'string' && item.id.length <= 512) this.remember(context, 'item', hash(item.id), account)
  }

  upstreamHeaders(context, account) {
    const id = hash(`${context.scope}:${context.session}:${account.vm_id}:${account.provision_generation}:${incarnation(account)}`)
    return { 'x-session-id': id, 'session-id': id, session_id: id, conversation_id: id }
  }

  upstreamBody(context, account, body) {
    const result = { ...body }
    const id = this.upstreamHeaders(context, account)['x-session-id']
    const cli = account.binding?.execution_backend === 'codex-cli'
    for (const key of ['session_id', 'conversation_id', 'thread_id', ...(!cli ? ['prompt_cache_key'] : [])]) {
      if (Object.hasOwn(result, key)) result[key] = id
    }
    // CLI exec is ephemeral and rejects cache keys. Caller-provided unsupported
    // fields remain intact for capability validation; never inject our own key.
    if (!cli) result.prompt_cache_key = id
    return result
  }
}

export function responseObserver(isolation, context, account, contentType, options = {}) {
  return createGatewayCompletionObserver({ contentType, ...options,
    observe: payload => isolation.observe(context, account, payload) })
}
