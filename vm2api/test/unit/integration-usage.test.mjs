import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { attachIntegrationUsage, createIntegrationUsageReporter, integrationUsageEvent } from '../../src/lib/protocol/integration-usage.mjs'

const req = { apiKeyKind: 'managed', headers: { authorization: 'Bearer private-key' } }
const ctx = { request_id: 'req-test-1' }
const bag = { vm_id: 'es2-account-a', final_state: 'verified', model: 'gpt-6.1-sol', upstream_model: 'gpt-6-astra', inbound_body: { input: 'private prompt' }, error_code: null }
const expected = { event_id: 'req-test-1', source: 'vm2', vm_id: 'es2-account-a', model: 'gpt-6.1-sol', upstream_model: 'gpt-6-astra', success: true }
const reporterOptions = { url: 'http://127.0.0.1:18084/api/v1/admin/usage/success', token: 'x'.repeat(32), retryDelayMs: 1, warn: () => {} }

test('verified final slot/model attribution is allowlisted and request payloads stay private', () => {
  assert.deepEqual(integrationUsageEvent(req, { statusCode: 200 }, ctx, bag), expected)
  assert.equal(integrationUsageEvent({ ...req, apiKeyKind: undefined }, { statusCode: 200 }, ctx, bag), null)
  assert.equal(integrationUsageEvent(req, { statusCode: undefined }, ctx, bag), null)
  assert.equal(integrationUsageEvent(req, { statusCode: 200 }, ctx, { ...bag, vm_id: null }), null)
  assert.equal(integrationUsageEvent(req, { statusCode: 200 }, ctx, { ...bag, requested_model: 'bad model' }), null)
  assert.equal(integrationUsageEvent(req, { statusCode: 200 }, { request_id: 'bad\nheader' }, bag), null)
})

test('only trusted master requests may exclude ModelTrace and real health probes', () => {
  for (const headers of [{ 'x-es2api-modeltrace': '1' }, { 'x-kin-health-real': 'true' }]) {
    assert.deepEqual(integrationUsageEvent({ ...req, headers }, { statusCode: 200 }, ctx, bag), expected)
    assert.equal(integrationUsageEvent({ apiKeyKind: 'master', headers }, { statusCode: 200 }, ctx, bag), null)
  }
  assert.deepEqual(integrationUsageEvent({ apiKeyKind: 'master', headers: {} }, { statusCode: 200 }, ctx, bag), expected)
})

test('200 status on interrupted SSE, canceled, cached health, or failed output never counts', () => {
  for (const final_state of ['incomplete', 'cancelled', 'health-cache', 'warmup-intercept', 'error', null]) {
    assert.equal(integrationUsageEvent(req, { statusCode: 200 }, ctx, { ...bag, final_state }), null)
  }
  assert.equal(integrationUsageEvent(req, { statusCode: 502 }, ctx, bag), null)
  assert.equal(integrationUsageEvent(req, { statusCode: 200 }, ctx, { ...bag, error_code: 'stream_incomplete' }), null)
  assert.equal(integrationUsageEvent(req, { statusCode: 200 }, ctx, { ...bag, inference_completed: false }), null)
})

test('finish hook sends once and does not count connection close before completion', () => {
  const records = []
  const reporter = { enabled: true, publish: event => records.push(event) }
  const res = Object.assign(new EventEmitter(), { statusCode: 200 })
  attachIntegrationUsage(req, res, ctx, bag, reporter)
  assert.equal(records.length, 0)
  res.emit('finish')
  res.emit('finish')
  assert.equal(records.length, 1)
  assert.deepEqual({ ...records[0], event_id: expected.event_id }, expected)
  assert.notEqual(records[0].event_id, ctx.request_id)
  const closed = Object.assign(new EventEmitter(), { statusCode: 200 })
  attachIntegrationUsage(req, closed, ctx, bag, reporter)
  closed.emit('close')
  assert.equal(records.length, 1)
})

test('caller-provided duplicate and invalid request ids cannot suppress usage events', () => {
  const events = []
  for (const requestId of ['same-client-request', 'same-client-request', 'invalid\nclient-id']) {
    const response = Object.assign(new EventEmitter(), { statusCode: 200 })
    attachIntegrationUsage({ ...req, headers: { 'x-request-id': requestId } }, response,
      { request_id: requestId }, bag, { enabled: true, publish: event => events.push(event) })
    response.emit('finish')
  }
  assert.equal(events.length, 3)
  assert.equal(new Set(events.map(event => event.event_id)).size, 3)
  assert.ok(events.every(event => /^[0-9a-f-]{36}$/.test(event.event_id)))
})

test('callback retries preserve the exact event and never block the finish listener', async () => {
  const calls = []
  const reporter = createIntegrationUsageReporter({ ...reporterOptions, fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return new Response('', { status: calls.length === 1 ? 503 : 200 })
  } })
  assert.equal(reporter.publish(expected), true)
  assert.equal(calls.length, 0)
  await reporter.flush()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.body, calls[1].options.body)
  assert.deepEqual(JSON.parse(calls[0].options.body), expected)
  assert.equal(calls[0].options.headers.authorization, `Bearer ${'x'.repeat(32)}`)
  assert.equal(calls[0].options.redirect, 'error')
  assert.deepEqual(reporter.snapshot(), { accepted: 1, delivered: 1, failed: 0, dropped: 0, pending: 0, enabled: true, mode: 'push', skipped: {}, configuration_error: null })
})

test('queue is bounded, failed callback attempts are bounded and diagnostics contain no secrets', async () => {
  const warnings = []
  let calls = 0
  const reporter = createIntegrationUsageReporter({ ...reporterOptions, capacity: 1, warn: value => warnings.push(value), fetchImpl: async () => {
    calls++
    throw new Error('private-key private prompt')
  } })
  assert.equal(reporter.publish(expected), true)
  assert.equal(reporter.publish({ ...expected, event_id: 'req-2' }), false)
  await reporter.flush()
  assert.equal(calls, 3)
  assert.deepEqual(reporter.snapshot(), { accepted: 1, delivered: 0, failed: 1, dropped: 1, pending: 0, enabled: true, mode: 'push', skipped: {}, configuration_error: null })
  assert.equal(warnings.length, 1)
  assert.doesNotMatch(warnings.join(''), /private-key|private prompt/)
})

test('callback rejection is not retried and absent configuration makes no request', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response('', { status: 400 }) }
  const reporter = createIntegrationUsageReporter({ ...reporterOptions, fetchImpl })
  reporter.publish(expected)
  await reporter.flush()
  assert.equal(calls, 1)
  for (const config of [{ url: '', token: '' }, { url: 'https://bad:secret@example.test', token: 'x'.repeat(32) }]) {
    const disabled = createIntegrationUsageReporter({ ...config, fetchImpl })
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.publish(expected), false)
    await disabled.flush()
  }
  assert.equal(calls, 1)
})

test('real HTTP JSON and SSE response completion deliver only metadata to the callback', async t => {
  const received = []
  const callback = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received.push({ auth: request.headers.authorization, event: JSON.parse(Buffer.concat(chunks)) })
    response.writeHead(200).end('{}')
  })
  await new Promise(resolve => callback.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => callback.close(resolve)))
  const reporter = createIntegrationUsageReporter({ ...reporterOptions, url: `http://127.0.0.1:${callback.address().port}/api/v1/admin/usage/success` })
  const gateway = http.createServer((request, response) => {
    request.apiKeyKind = 'managed'
    attachIntegrationUsage(request, response, { request_id: `req-${request.url.slice(1)}` }, bag, reporter)
    response.writeHead(200, { 'content-type': request.url === '/sse' ? 'text/event-stream' : 'application/json' })
    response.end(request.url === '/sse' ? 'data: {"type":"response.completed"}\n\n' : '{"output":"private answer"}')
  })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  for (const route of ['json', 'sse']) {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/${route}`)
    assert.equal(response.status, 200)
    await response.text()
  }
  await reporter.flush()
  assert.equal(received.length, 2)
  assert.deepEqual(received.map(row => ({ ...row.event, event_id: expected.event_id })), [expected, expected])
  assert.notEqual(received[0].event.event_id, received[1].event.event_id)
  assert.ok(received.every(row => row.auth === `Bearer ${'x'.repeat(32)}`))
})
