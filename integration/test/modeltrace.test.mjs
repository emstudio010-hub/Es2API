import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { ModelTrace, compareResponses, validateModeltraceBank } from '../src/modeltrace.mjs'

const ENCRYPTION_KEY = 'ab'.repeat(32)

test('cancellation arriving with the final sample cannot apply a mismatch action', async () => {
  let calls = 0
  let subject
  subject = await setup({ runner: async ({ challenge }) => {
    if (++calls === 3) subject.modeltrace.cancel(subject.account.id)
    return { text: `Model B distinct reference response ${Number(challenge.id.slice(1))}.` }
  } })
  try {
    subject.modeltrace.configureGlobal({ action: 'pause', consecutive_mismatches: 1 })
    const run = subject.modeltrace.run(subject.account.id)
    const saved = await subject.modeltrace.wait(run.id)
    assert.equal(saved.status, 'canceled')
    assert.equal(saved.applied_action, 'none')
    assert.equal(saved.samples.length, 2)
    assert.equal(subject.pool.getAccount(subject.account.id).modeltrace.state.auto_paused, undefined)
  } finally { await subject.modeltrace.close(); subject.store.close() }
})

function bankFixture() {
  const challenges = [
    { id: 'c1', prompt: 'Answer with the short phrase: blue cedar.' },
    { id: 'c2', prompt: 'Answer with the short phrase: silver river.' },
    { id: 'c3', prompt: 'Answer with the short phrase: amber cloud.' },
  ]
  const models = [
    { id: 'model-a', responses: challenges.map((challenge, index) => ({ challenge_id: challenge.id, text: `Model A exact reference answer ${index + 1}.` })) },
    { id: 'model-b', responses: challenges.map((challenge, index) => ({ challenge_id: challenge.id, text: `Model B distinct reference response ${index + 1}.` })) },
  ]
  return { challenges, models }
}

async function setup({ runner, mode = 'pool', clock, random } = {}) {
  const store = new Store({ filename: ':memory:', encryptionKey: ENCRYPTION_KEY })
  const lifecycle = {
    async provision(binding) { return { vm_id: `vm-${binding.account_id}`, slot: { ready: true, status: 'running' } } },
    async remove() {},
  }
  const pool = new AccountPool({ store, lifecycle })
  const group = pool.createGroup({ id: `group-${mode}`, name: `Group ${mode}`, strategy: mode === 'lease' ? 'per_slot' : 'shared' })
  const account = await pool.importAccount({ account_id: `account-${mode}`, mode, group_ids: [group.id], credential: { access_token: `secret-token-${mode}` } })
  const fixture = bankFixture()
  const traceRunner = runner || (async ({ model, challenge }) => {
    const reference = fixture.models.find(item => item.id === model)?.responses.find(item => item.challenge_id === challenge.id)
    return { text: reference?.text || 'unlisted model response' }
  })
  const modeltrace = new ModelTrace({ store, accountPool: pool, runner: traceRunner, clock, random })
  modeltrace.installBank(fixture)
  modeltrace.configureGlobal({ ...modeltrace.getGlobalConfig(), model: 'model-a' })
  return { store, pool, account, modeltrace, fixture }
}

test('reference bank rejects incomplete or duplicate response coverage', () => {
  const fixture = bankFixture()
  assert.throws(() => validateModeltraceBank({
    challenges: fixture.challenges,
    models: fixture.models.map(model => ({ ...model, responses: [...model.responses, model.responses[0]] })),
  }), error => error.code === 'invalid_bank')
  assert.throws(() => validateModeltraceBank({ challenges: fixture.challenges.slice(0, 2), models: fixture.models }),
    error => error.code === 'invalid_bank')
})

test('reference bank revision changes with its contents and ignores input row ordering', async t => {
  const { store, modeltrace, fixture } = await setup()
  t.after(async () => { await modeltrace.close(); store.close() })
  const original = modeltrace.bank().revision
  modeltrace.installBank({
    challenges: [...fixture.challenges].reverse(),
    models: [...fixture.models].reverse().map(model => ({ ...model, responses: [...model.responses].reverse() })),
  })
  assert.equal(modeltrace.bank().revision, original)

  const modified = structuredClone(fixture)
  modified.models[0].responses[0].text += ' changed'
  modeltrace.installBank(modified)
  assert.notEqual(modeltrace.bank().revision, original)
})

test('similarity comparison recognizes exact reference samples but remains explicitly heuristic', () => {
  const fixture = bankFixture()
  const samples = fixture.models[0].responses.map(response => ({ challenge_id: response.challenge_id, text: response.text }))
  const references = fixture.models.flatMap(model => model.responses.map(response => ({ model: model.id,
    challenge_id: response.challenge_id, response: response.text })))
  const result = compareResponses(samples, references, 'model-a')
  assert.equal(result.status, 'match')
  assert.equal(result.prediction, 'model-a')
  assert.ok(result.confidence > 0.99)
  assert.equal(result.actionable, false)
})

test('global request threshold triggers a persisted run only after enough successful requests', async t => {
  const { store, account, modeltrace } = await setup()
  t.after(async () => { await modeltrace.close(); store.close() })
  modeltrace.configureGlobal({ ...modeltrace.getGlobalConfig(), every_requests: 2 })
  assert.equal(await modeltrace.recordUsage({ account_id: account.id, model: 'model-a', success: true }), null)
  const run = await modeltrace.recordUsage({ account_id: account.id, model: 'model-a', success: true })
  assert.equal(run.reason, 'requests')
  const saved = await modeltrace.wait(run.id)
  assert.equal(saved.status, 'match')
  assert.equal(saved.samples.length, 3)
  assert.equal(Object.hasOwn(saved.samples[0], 'text'), false)
  assert.equal(store.listRuns({ account_id: account.id }).total, 1)
  assert.equal(store.getAccount(account.id).successful_requests, 2)
})

test('pool and lease automatic defaults differ; lease can explicitly opt in', async t => {
  const poolContext = await setup({ mode: 'pool' })
  t.after(async () => { await poolContext.modeltrace.close(); poolContext.store.close() })
  const leaseContext = await setup({ mode: 'lease' })
  t.after(async () => { await leaseContext.modeltrace.close(); leaseContext.store.close() })

  assert.equal(poolContext.modeltrace.getAccountConfig(poolContext.account).enabled, true)
  assert.equal(leaseContext.modeltrace.getAccountConfig(leaseContext.account).enabled, false)
  const optedIn = leaseContext.modeltrace.configureAccount(leaseContext.account.id, { enabled: true })
  assert.equal(optedIn.effective_config.enabled, true)
  const run = leaseContext.modeltrace.run(leaseContext.account.id)
  assert.equal((await leaseContext.modeltrace.wait(run.id)).status, 'match')
})

test('most-used model excludes failed usage and aliased upstream model names', async t => {
  const { store, account, modeltrace } = await setup()
  t.after(async () => { await modeltrace.close(); store.close() })
  modeltrace.configureGlobal({ ...modeltrace.getGlobalConfig(), model_mode: 'most_used' })
  store.addModelUsage({ account_id: account.id, model: 'model-a', upstream_model: 'model-b', successful: true })
  store.addModelUsage({ account_id: account.id, model: 'model-b', upstream_model: 'model-b', successful: false })
  store.addModelUsage({ account_id: account.id, model: 'model-a', upstream_model: 'model-a', successful: true })
  assert.deepEqual(modeltrace.selectModel(account), { model: 'model-a', source: 'most_used', successful_requests: 1 })
})

test('repeated mismatch can pause scheduling and reset is an explicit account action', async t => {
  const wrongResponses = {
    c1: 'Model B distinct reference response 1.',
    c2: 'Model B distinct reference response 2.',
    c3: 'Model B distinct reference response 3.',
  }
  const { store, pool, account, modeltrace } = await setup({ runner: async ({ challenge }) => ({ text: wrongResponses[challenge.id] }) })
  t.after(async () => { await modeltrace.close(); store.close() })
  modeltrace.configureGlobal({ ...modeltrace.getGlobalConfig(), action: 'pause', consecutive_mismatches: 2 })
  for (let index = 0; index < 2; index++) {
    const run = modeltrace.run(account.id)
    assert.equal((await modeltrace.wait(run.id)).status, 'suspected_mismatch')
  }
  assert.equal(pool.getAccount(account.id).schedulable, false)
  const state = pool.getAccount(account.id).modeltrace.state
  assert.equal(state.auto_paused, true)
  assert.equal(state.original_schedulable, true)

  const reset = { ...state, auto_paused: false, consecutive: 0, evidence_context: null }
  const restored = store.updateAccount(account.id, { schedulable: state.original_schedulable, modeltrace_state: reset })
  assert.equal(restored.schedulable, true)
})

test('stale run cancellation cannot cancel a newer same-account run', async t => {
  let invocations = 0
  let releaseFirst
  const gate = new Promise(resolve => { releaseFirst = resolve })
  const context = await setup({ runner: async ({ challenge, signal }) => {
    invocations++
    if (invocations <= 3) await gate
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    return { text: `response for ${challenge.id}` }
  } })
  t.after(async () => { releaseFirst(); await context.modeltrace.close(); context.store.close() })

  const first = context.modeltrace.run(context.account.id)
  assert.equal(context.modeltrace.cancel(context.account.id, 'stale-run-id'), false)
  assert.equal(context.modeltrace.cancel(context.account.id, first.id), true)
  releaseFirst()
  assert.equal((await context.modeltrace.wait(first.id)).status, 'canceled')
  const second = context.modeltrace.run(context.account.id)
  assert.notEqual(second.id, first.id)
  assert.equal(context.modeltrace.cancel(context.account.id, first.id), false)
  assert.equal((await context.modeltrace.wait(second.id)).status, 'inconclusive')
})

test('process restart marks persisted in-flight trace as interrupted without replay', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'es2api-trace-restart-'))
  const filename = path.join(directory, 'trace.sqlite')
  t.after(() => {})
  const first = new Store({ filename, encryptionKey: ENCRYPTION_KEY })
  first.saveRun({ id: 'run-interrupted', account_id: 'account-x', status: 'running', model: 'model-a' })
  first.close()

  const recovered = new Store({ filename, encryptionKey: ENCRYPTION_KEY })
  assert.equal(recovered.getRun('run-interrupted').status, 'interrupted')
  assert.equal(recovered.getRun('run-interrupted').error.code, 'process_interrupted')
  assert.equal(recovered.listRuns({}).items[0].status, 'interrupted')
  recovered.close()
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Windows may release SQLite handles after the test process exits. */ }
})

test('summary counts persisted runs beyond the history page size', async t => {
  const { store, modeltrace } = await setup()
  t.after(async () => { await modeltrace.close(); store.close() })
  for (let index = 0; index < 105; index++) {
    store.saveRun({ id: `summary-${index}`, account_id: 'account-pool', status: 'match', model: 'model-a' })
  }
  const summary = modeltrace.summary()
  assert.equal(summary.run_counts.match, 105)
})
