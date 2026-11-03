import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.mjs'
import { AccountPool } from './account-pool.mjs'
import { AccountLifecycle } from './lifecycle.mjs'
import { Vm2Client, createVm2TraceRunner, vm2LifecycleTimeout } from './vm2-client.mjs'
import { ModelTrace } from './modeltrace.mjs'
import { createIntegrationServer } from './server.mjs'
import { traceDefaults } from './modeltrace-config.mjs'
import { createUsagePoller } from './usage-poller.mjs'
import { createPoolGateway, createPoolUpgrade } from './gateway.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const managementToken = process.env.ES2API_MANAGEMENT_TOKEN || ''
const encryptionKey = process.env.ES2API_DATA_KEY || ''
if (managementToken.length < 32) throw new Error('ES2API_MANAGEMENT_TOKEN must contain at least 32 characters')
if (!encryptionKey) throw new Error('ES2API_DATA_KEY must be a 32-byte base64url or 64-character hex key')

const vm2BaseUrl = process.env.VM2API_BASE_URL || ''
if (!vm2BaseUrl) throw new Error('VM2API_BASE_URL is required')
if (!process.env.VM2API_PANEL_TOKEN && !(process.env.VM2API_PANEL_USERNAME && process.env.VM2API_PANEL_PASSWORD)) {
  throw new Error('Set VM2API_PANEL_TOKEN or both VM2API_PANEL_USERNAME and VM2API_PANEL_PASSWORD')
}
const vm2 = new Vm2Client({
  baseUrl: vm2BaseUrl,
  username: process.env.VM2API_PANEL_USERNAME,
  password: process.env.VM2API_PANEL_PASSWORD,
  controlToken: process.env.VM2API_PANEL_TOKEN,
  lifecycleTimeoutMs: vm2LifecycleTimeout(process.env.VM2API_LIFECYCLE_TIMEOUT_MS),
})
const store = new Store({ filename: process.env.ES2API_DB_PATH || path.resolve(root, '../data/es2api.sqlite'), encryptionKey })
const accountPool = new AccountPool({ store, lifecycle: new AccountLifecycle({ vm2, onState: state => {
  if (!state.account_id) return
  const fields = {}
  if (state.vm_id) fields.vm_id = state.vm_id
  if (state.slot) fields.slot_json = state.slot
  if (['slot_created', 'exit_bound'].includes(state.phase) && state.slot?.egress?.proxy_id) {
    const account = store.getAccount(state.account_id)
    if (account) fields.binding = { ...account.binding, proxy_id: state.slot.egress.proxy_id, timezone: state.slot.egress.timezone || account.binding.timezone }
  }
  if (state.phase === 'slot_created') { fields.status = 'provisioning'; fields.schedulable = false }
  if (state.phase === 'error') { fields.status = 'error'; fields.schedulable = false; fields.error_code = 'lifecycle_failed'; fields.error_message = 'VM2 槽位创建或导入失败' }
  if (Object.keys(fields).length) store.updateAccount(state.account_id, fields)
} }), traceDefaults })
const runner = vm2BaseUrl && process.env.VM2API_API_KEY
  ? createVm2TraceRunner({ baseUrl: vm2BaseUrl, apiKey: process.env.VM2API_API_KEY }) : null
const modeltrace = new ModelTrace({ store, accountPool, runner, usageBridgeConfigured: process.env.ES2API_USAGE_BRIDGE_ENABLED === 'true' })
const usagePoller = process.env.ES2API_USAGE_MODE === 'pull' ? createUsagePoller({ vm2, modeltrace, store }) : null
accountPool.beforeRemoveAccount = async accountId => modeltrace.cancelAccountAndWait(accountId)
const gateway = createPoolGateway({ accountPool, store, secret: managementToken, baseUrl: vm2BaseUrl, apiKey: process.env.VM2API_API_KEY })
const server = createIntegrationServer({ store, accountPool, modeltrace, managementToken, gateway, vm2 })
const upgrade = createPoolUpgrade({ accountPool, store, secret: managementToken, baseUrl: vm2BaseUrl, apiKey: process.env.VM2API_API_KEY })
server.on('upgrade', upgrade)
const host = process.env.ES2API_BIND_HOST || '127.0.0.1'
const port = Number(process.env.ES2API_BIND_PORT || 8082)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ES2API_BIND_PORT must be a valid TCP port')

const timer = setInterval(() => modeltrace.tick(), 5000)
timer.unref()
const usageTimer = usagePoller ? setInterval(() => { void usagePoller.poll() }, 2000) : null
usageTimer?.unref()
server.listen(port, host, () => console.log(`[es2api] integration backend listening on http://${host}:${port}`))

let closing = false
async function close(signal) {
  if (closing) return
  closing = true
  upgrade.close()
  clearInterval(timer)
  if (usageTimer) clearInterval(usageTimer)
  console.log(`[es2api] shutting down after ${signal}`)
  server.close(async () => {
    await gateway.close()
    await usagePoller?.close()
    await modeltrace.close()
    store.close()
    process.exit(0)
  })
}
process.once('SIGINT', () => void close('SIGINT'))
process.once('SIGTERM', () => void close('SIGTERM'))
