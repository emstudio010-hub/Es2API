import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace } from '../src/modeltrace.mjs'
import { createVm2TraceRunner } from '../src/vm2-client.mjs'
import { createIntegrationServer } from '../src/server.mjs'

const golden = JSON.parse(fs.readFileSync(new URL('../resources/modeltrace/cpa-v2/golden.json', import.meta.url), 'utf8'))

test('HTTP run uses the pinned VM2 slot, three independent challenges, scoring and persisted redacted history', async t => {
  const requests = []
  const outputs = golden.find(row => row.expected.probability !== null && row.expected.prediction)?.outputs
  assert.equal(outputs.length, 3)
  const upstream = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) })
    const output = outputs[requests.length - 1]
    res.writeHead(200, { 'content-type': requests.length % 2 ? 'application/json' : 'text/event-stream' })
    const payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output.text }] }], usage: { output_tokens: 100 } }
    res.end(requests.length % 2 ? JSON.stringify(payload) : `data: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const store = new Store({ encryptionKey: 'ab'.repeat(32) })
  const pool = new AccountPool({ store, lifecycle: {
    async provision() { return { vm_id: 'pinned-vm', slot: { ready: true, status: 'running' } } }, async remove() {},
  } })
  const trace = new ModelTrace({ store, accountPool: pool, runner: createVm2TraceRunner({ baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'fixture-master-key' }) })
  pool.createGroup({ id: 'trace-test-group', name: 'Trace test' })
  await pool.importAccount({ account_id: 'trace-test-account', group_ids: ['trace-test-group'], credential: { access_token: 'fixture-oauth-secret' } })
  const server = createIntegrationServer({ store, accountPool: pool, modeltrace: trace, managementToken: 'test-management-token' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await trace.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); store.close() })
  const base = `http://127.0.0.1:${server.address().port}/api/v1/admin`
  const headers = { authorization: 'Bearer test-management-token', 'content-type': 'application/json' }
  const preflight = await (await fetch(`${base}/modeltrace/summary`, { headers })).json()
  assert.equal(preflight.data.bank.method, 'shared-detector-v2')
  assert.equal(preflight.data.accounts[0].readiness.ready, true)
  const response = await fetch(`${base}/modeltrace/run`, { method: 'POST', headers, body: JSON.stringify({ account_id: 'trace-test-account' }) })
  assert.equal(response.status, 202)
  const queued = (await response.json()).data
  await trace.wait(queued.id)
  const detail = await (await fetch(`${base}/modeltrace/runs/${queued.id}`, { headers })).json()
  assert.equal(requests.length, 3)
  assert.equal(new Set(requests.map(item => item.body.input)).size, 3)
  for (const row of requests) {
    assert.equal(row.path, '/v1/responses')
    assert.equal(row.headers['x-kin-vm'], 'pinned-vm')
    assert.equal(row.headers['x-es2api-modeltrace'], '1')
    assert.equal(row.headers.authorization, 'Bearer fixture-master-key')
    assert.equal(row.body.model, 'gpt-6.1-sol')
    assert.equal(row.body.store, false)
  }
  assert.notEqual(detail.data.status, 'error')
  assert.equal(detail.data.samples.length, 3)
  assert.equal(detail.data.applied_action, 'none')
  assert.equal(detail.data.result.method, 'shared-detector-v2')
  assert.equal(detail.data.result.expected_candidate, 'gpt-6-astra')
  assert.equal(detail.data.bank_revision, preflight.data.bank.revision)
  assert.ok(detail.data.samples.every(sample => !('text' in sample) && sample.sha256.length === 64))
  assert.equal(JSON.stringify(detail).includes('fixture-oauth-secret'), false)
  assert.equal(JSON.stringify(detail).includes('fixture-master-key'), false)
})

test('failed VM2 sampling is never automatically retried and raw errors are not persisted', async () => {
  let calls = 0
  const runner = createVm2TraceRunner({ baseUrl: 'http://vm2.test', apiKey: 'private-key', fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'private-token' } }), { status: 429 })
  } })
  await assert.rejects(() => runner({ account: { vm_id: 'vm-test' }, model: 'gpt-6.1-sol', challenge: { prompt: 'test' } }), error => error.code === 'trace_upstream_error' && !error.message.includes('private-token'))
  assert.equal(calls, 1)
})
