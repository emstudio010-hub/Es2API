import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createIntegrationUsageReporter, attachIntegrationUsage } from '../../src/lib/protocol/integration-usage.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const event = { event_id: 'server-event-1', source: 'vm2', vm_id: 'es2-account-a', model: 'gpt-6.1-sol', upstream_model: 'gpt-6.1-sol', success: true }
async function panel(reporter, { method = 'GET', route = '/api/panel/integration/usage-events', role = 'admin', kind = 'session', body = {} } = {}) {
  const result = {}
  const handler = createPanelHandler({
    cfg: { paths: { project: os.tmpdir() }, limits: { max_body_bytes: 1024 * 1024 } },
    integrationUsageReporter: reporter,
    requireAuth(req, res) {
      if (kind === 'unauthorized') { result.status = 401; return false }
      req.apiKeyKind = kind
      req.panelRole = role
      if (kind === 'session') req.panelUser = 'test-user'
      return true
    },
    json(_res, status, payload) { Object.assign(result, { status, payload }); return true },
    readBody: async () => body,
  })
  await handler({ method }, {}, new URL(`http://localhost${route}`))
  return result
}

test('pull outbox retains allowlisted events across restart and acknowledges idempotently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2-usage-outbox-'))
  const filename = path.join(root, 'outbox.sqlite')
  let db = new DatabaseSync(filename)
  try {
    const first = createIntegrationUsageReporter({ mode: 'pull', db, fetchImpl: () => { throw new Error('pull mode must not push') } })
    first.publish({ ...event, prompt: 'private prompt', authorization: 'private-token' })
    first.publish(event)
    assert.equal(first.snapshot().pending, 1)
    db.close()
    db = new DatabaseSync(filename)
    const second = createIntegrationUsageReporter({ mode: 'pull', db })
    assert.deepEqual(second.pending(), [event])
    const read = await panel(second)
    assert.equal(read.status, 200)
    assert.deepEqual(read.payload.items, [event])
    assert.equal(read.payload.reporter.mode, 'pull')
    const ack = await panel(second, { method: 'POST', route: '/api/panel/integration/usage-events/ack', body: { event_ids: [event.event_id] } })
    assert.equal(ack.status, 200)
    assert.equal(ack.payload.deleted, 1)
    const repeat = await panel(second, { method: 'POST', route: '/api/panel/integration/usage-events/ack', body: { event_ids: [event.event_id] } })
    assert.equal(repeat.payload.deleted, 0)
    assert.equal(second.snapshot().pending, 0)
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('pending metadata and acknowledgements are denied to non-admin sessions and managed keys', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const reporter = createIntegrationUsageReporter({ mode: 'pull', db })
    reporter.publish(event)
    for (const auth of [{ kind: 'managed' }, { kind: 'session', role: 'user' }, { kind: 'session', role: 'super' }, { kind: 'unauthorized' }]) {
      for (const request of [{}, { method: 'POST', route: '/api/panel/integration/usage-events/ack', body: { event_ids: [event.event_id] } }]) {
        const result = await panel(reporter, { ...auth, ...request })
        assert.equal(result.status, auth.kind === 'unauthorized' ? 401 : 403)
        assert.equal(result.payload?.items, undefined)
      }
    }
    assert.equal(reporter.snapshot().pending, 1)
    assert.equal((await panel(reporter, { kind: 'master' })).status, 200)
    const badAck = await panel(reporter, { method: 'POST', route: '/api/panel/integration/usage-events/ack', body: { event_ids: ['invalid\n'] } })
    assert.equal(badAck.status, 400)
    assert.equal(reporter.snapshot().pending, 1)
  } finally { db.close() }
})

test('pull backlog is bounded and finish diagnostic counters explain skipped inference', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const reporter = createIntegrationUsageReporter({ mode: 'pull', db, outboxCapacity: 1, warn() {} })
    assert.equal(reporter.publish(event), true)
    assert.equal(reporter.publish({ ...event, event_id: 'server-event-2' }), false)
    const res = Object.assign(new EventEmitter(), { statusCode: 200 })
    attachIntegrationUsage({ apiKeyKind: 'managed', headers: {} }, res, {},
      { final_state: 'verified', inference_completed: false, vm_id: event.vm_id, model: event.model }, reporter)
    res.emit('finish')
    assert.equal(reporter.snapshot().dropped, 1)
    assert.deepEqual(reporter.snapshot().skipped, { inference_not_completed: 1 })
  } finally { db.close() }
  const unconfigured = createIntegrationUsageReporter({ mode: 'pull' })
  assert.equal(unconfigured.enabled, false)
  assert.equal(unconfigured.snapshot().configuration_error, 'usage_outbox_db_unavailable')
})

test('real HTTP handleProtocol Codex completion reaches durable outbox then admin read and ack', async t => {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2-auto-finish-'))
  const vmId = 'vm-gpt-a'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vmId}.json`), JSON.stringify({ id: vmId, name: vmId, platform: 'openai', family: 'codex', status: 'running', schedulable: true, has_token: true }))
  fs.writeFileSync(path.join(root, 'vms', vmId, 'codex-credentials.json'), JSON.stringify({ accounts: [{ id: 'fixture-account', access_token: 'fixture-only', refresh_token: 'fixture-only', chatgpt_account_id: vmId }] }))
  const db = new DatabaseSync(':memory:')
  const reporter = createIntegrationUsageReporter({ mode: 'pull', db })
  const routing = { pool: { fallback_wait_timeout_ms: 3000 }, codex: { clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' }, protocols: { 'openai.responses': { enabled: true, mode: 'native' } } } }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  let providerFixtureCalls = 0
  const { handleProtocol } = createHandleProtocol({
    json, writeSSEHeaders: res => res.writeHead(200, { 'content-type': 'text/event-stream' }),
    readBody: async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)) },
    requireAuth(req) { req.apiKeyKind = 'managed'; req.apiKeyRecord = { id: 'fixture-key', category: 'oauth', group_type: 'openai', allowed_vms: [vmId], group_id: 1 }; return true },
    cfg: { rewrite: { enabled: false }, intercept: { rules: [] }, distill: { enabled: false }, limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 30000, stream_idle_timeout_ms: 30000 }, paths: { data: root, project: root } },
    requestLog: { start: () => ({ request_id: 'caller-reused-id', t0: Date.now() }), finish() {} },
    usageReporter: reporter,
    stickyRouter: { extractPoolKey: () => 'outbox-fixture', collectPoolKeys: () => ['outbox-fixture'], resolve: () => null },
    accountQuota: { sessions: null, ingestHeaders() {} }, apiKeyStore: { db, recordUsage() {}, release() {} },
    apiScheduler: {}, apiEndpointStore: {}, stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile, routingConfig: routing, groupsRepo: { rateMultiplier: () => 1 },
    codexOps: { writeCodexKernelConfig() {}, ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ onEvent }) => {
        providerFixtureCalls++
        const response = { id: 'fixture-response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 4, output_tokens: 1 } }
        if (providerFixtureCalls <= 2) {
          const line = `data: ${JSON.stringify({ type: 'response.completed', response })}`
          await onEvent(providerFixtureCalls === 2 ? `event: response.completed\n${line}\n\n` : line)
          return { ok: false, status: 200, terminalState: 'incomplete', usage: response.usage }
        }
        if (providerFixtureCalls === 3) return { ok: true, status: 200, body: response, usage: response.usage }
        if (providerFixtureCalls === 4) return { ok: true, status: 200, body: { response }, usage: response.usage }
        return { ok: false, status: 200, terminalState: 'incomplete', body: { ...response, status: 'incomplete' }, usage: response.usage }
      },
    },
  })
  const server = http.createServer((req, res) => { void handleProtocol(req, res, 'openai.responses', '/v1/responses') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  for (const stream of [false, true, false, false, false]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.4', input: 'OK', stream }) })
    assert.equal(response.status, 200)
    await response.text()
  }
  const pending = await panel(reporter)
  assert.equal(pending.status, 200)
  assert.equal(pending.payload.items.length, 4)
  assert.equal(new Set(pending.payload.items.map(item => item.event_id)).size, 4)
  assert.ok(pending.payload.items.every(item => item.vm_id === vmId && item.model === 'gpt-5.4' && item.success))
  assert.deepEqual(reporter.snapshot().skipped, { inference_not_completed: 1 })
  const acknowledged = await panel(reporter, { method: 'POST', route: '/api/panel/integration/usage-events/ack', body: { event_ids: pending.payload.items.map(item => item.event_id) } })
  assert.equal(acknowledged.payload.deleted, 4)
  assert.equal(reporter.snapshot().pending, 0)
})
