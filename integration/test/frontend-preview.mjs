// Local UI fixture only. Uses an in-memory database and never connects to VM2 or a provider.
// Run explicitly: node test/frontend-preview.mjs
import http from 'node:http'
import crypto from 'node:crypto'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace } from '../src/modeltrace.mjs'
import { createIntegrationServer } from '../src/server.mjs'

const token = crypto.randomBytes(32).toString('hex')
const store = new Store({ encryptionKey: crypto.randomBytes(32) })
const pool = new AccountPool({ store, lifecycle: {
  async provision(binding) {
    return { vm_id: `fixture-${binding.account_id}`, slot: {
      ready: true, status: 'running', health: { ok: true }, egress: { ip: '192.0.2.10' },
      timezone: 'Asia/Shanghai',
    } }
  },
  async remove() {},
  async inspect() { return { ready: true, status: 'running', health: { ok: true }, egress: { ip: '192.0.2.10' } } },
} })
const trace = new ModelTrace({ store, accountPool: pool, runner: async ({ model, challenge, signal }) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 800)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
  return { text: `${model} fixture response ${challenge.id}` }
} })
pool.beforeRemoveAccount = id => trace.cancelAccountAndWait(id)
const challenges = [1, 2, 3].map(i => ({ id: `preview-${i}`, prompt: `Fixture challenge ${i}` }))
trace.installBank({ challenges, models: ['fixture-model-a', 'fixture-model-b'].map(id => ({ id,
  responses: challenges.map(challenge => ({ challenge_id: challenge.id, text: `${id} fixture response ${challenge.id}` })),
})) })
trace.configureGlobal({ ...trace.getGlobalConfig(), model: 'fixture-model-a' })
pool.createGroup({ id: 'preview-pool', name: '本地预览账号池' })
await pool.importAccount({ account_id: 'preview-pool-account', name: '预览共享账号', mode: 'pool',
  group_ids: ['preview-pool'], credential: { access_token: 'fixture-only-not-a-provider-token-1' } })
await pool.importAccount({ account_id: 'preview-lease-account', name: '预览租赁账号', mode: 'lease',
  credential: { access_token: 'fixture-only-not-a-provider-token-2' } })
const integration = createIntegrationServer({ store, accountPool: pool, modeltrace: trace, managementToken: token })
await new Promise(resolve => integration.listen(0, '127.0.0.1', resolve))
const user = { id: 1, email: 'preview@example.test', username: '本地预览', role: 'admin', balance: 0, concurrency: 1, status: 'active' }
const publicSettings = { site_name: 'Es2API · 本地夹具预览', registration_enabled: false,
  turnstile_enabled: false, custom_menu_items: [], backend_mode_enabled: false,
  ops_monitoring_enabled: false, plugin_management_enabled: false }
function send(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ code: status < 400 ? 0 : status, data, message: status < 400 ? 'OK' : 'Preview session required' }))
}
const preview = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  if (pathname === '/api/v1/settings/public') return send(res, publicSettings)
  if (pathname === '/setup/status') return send(res, { needs_setup: false })
  if (pathname === '/api/v1/auth/login') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 4096) return send(res, null, 413)
      chunks.push(chunk)
    }
    let input
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(res, null, 400) }
    if (input.email !== 'preview@example.test' || input.password !== 'preview-only') return send(res, null, 401)
    return send(res, { access_token: 'local-preview-session', token_type: 'Bearer', expires_in: 86400, user })
  }
  if (req.headers.authorization !== 'Bearer local-preview-session') return send(res, null, 401)
  if (pathname.startsWith('/api/v1/admin/integration/')) {
    const upstreamPath = req.url.replace('/api/v1/admin/integration/', '/api/v1/admin/')
    const forward = http.request({ hostname: '127.0.0.1', port: integration.address().port,
      path: upstreamPath, method: req.method, headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        ...(req.headers['idempotency-key'] ? { 'idempotency-key': req.headers['idempotency-key'] } : {}),
      },
    }, upstream => {
      res.writeHead(upstream.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      upstream.pipe(res)
    })
    forward.on('error', () => send(res, null, 502))
    req.pipe(forward)
    return
  }
  if (pathname === '/api/v1/auth/me') return send(res, user)
  if (pathname === '/api/v1/admin/settings') return send(res, publicSettings)
  if (pathname.includes('compliance')) return send(res, { acknowledged: true, required: false })
  if (pathname.includes('announcements')) return send(res, { items: [], total: 0 })
  if (pathname.includes('system')) return send(res, { version: 'local-preview', latest_version: 'local-preview' })
  return send(res, {})
})
await new Promise(resolve => preview.listen(18082, '127.0.0.1', resolve))
console.log('Local fixture API: http://127.0.0.1:18082 (memory only; no VM2/provider connection)')
async function shutdown() {
  preview.closeAllConnections()
  await new Promise(resolve => preview.close(resolve))
  await trace.close()
  integration.closeAllConnections()
  await new Promise(resolve => integration.close(resolve))
  store.close()
}
process.on('SIGINT', () => shutdown().then(() => process.exit(0)))
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)))
