import { beforeEach, describe, expect, it, vi } from 'vitest'
import { integrationRequest } from '../integrationClient'
import {
  isTraceActive,
  modeltraceApi,
  parseTraceBank,
  type TraceBankInput
} from '../integrationModeltrace'

vi.mock('../integrationClient', () => ({
  integrationRequest: vi.fn().mockResolvedValue({})
}))
const request = vi.mocked(integrationRequest)
function bank(): TraceBankInput {
  return {
    challenges: [1, 2, 3].map((id) => ({
      id: `c${id}`,
      prompt: `Prompt ${id}`
    })),
    models: ['model-a', 'model-b'].map((id) => ({
      id,
      responses: [1, 2, 3].map((n) => ({
        challenge_id: `c${n}`,
        text: `Reference ${id} ${n}`
      }))
    }))
  }
}
describe('ModelTrace integration contract', () => {
  beforeEach(() => request.mockClear())
  it('encodes resource IDs and sends manual detection through the authenticated integration client', async () => {
    await modeltraceApi.account('account/a')
    await modeltraceApi.run('account/a')
    await modeltraceApi.cancel('run/a')
    expect(request).toHaveBeenNthCalledWith(
      1,
      '/accounts/account%2Fa/modeltrace',
      { signal: undefined }
    )
    expect(request).toHaveBeenNthCalledWith(2, '/modeltrace/run', {
      method: 'POST',
      data: { account_id: 'account/a' }
    })
    expect(request).toHaveBeenNthCalledWith(
      3,
      '/modeltrace/runs/run%2Fa/cancel',
      { method: 'POST' }
    )
  })
  it('preserves all server-supported history filters and cancellation signals', async () => {
    const signal = new AbortController().signal
    const params = {
      account_id: 'a',
      status: 'running',
      reason: 'manual',
      model: 'model-a',
      page: 3,
      page_size: 50
    }
    await modeltraceApi.runs(params, signal)
    expect(request).toHaveBeenCalledWith('/modeltrace/runs', { params, signal })
  })
  it('clears overrides explicitly and resets actions through their own endpoint', async () => {
    await modeltraceApi.saveAccount('a', { inherit: true })
    await modeltraceApi.resetAction('a')
    expect(request).toHaveBeenNthCalledWith(1, '/accounts/a/modeltrace', {
      method: 'PUT',
      data: { inherit: true }
    })
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/accounts/a/modeltrace/reset-action',
      { method: 'POST' }
    )
  })
  it('accepts a complete bank and normalizes only whitespace allowed by the server', () => {
    const value = bank()
    value.challenges[0].id = ' c1 '
    value.models[0].id = ' model-a '
    const parsed = parseTraceBank(JSON.stringify(value))
    expect(parsed.challenges[0].id).toBe('c1')
    expect(parsed.models[0].id).toBe('model-a')
  })
  it.each([
    'duplicateChallenge',
    'duplicateModel',
    'missingResponse',
    'duplicateResponse',
    'emptyText',
    'tooFewChallenges'
  ])('rejects %s before a destructive replacement is offered', (kind) => {
    const value = bank()
    if (kind === 'duplicateChallenge')
      value.challenges[1].id = value.challenges[0].id
    if (kind === 'duplicateModel') value.models[1].id = value.models[0].id
    if (kind === 'missingResponse') value.models[0].responses.pop()
    if (kind === 'duplicateResponse')
      value.models[0].responses[1].challenge_id = 'c1'
    if (kind === 'emptyText') value.models[0].responses[0].text = ' '
    if (kind === 'tooFewChallenges') value.challenges.pop()
    expect(() => parseTraceBank(JSON.stringify(value))).toThrow('invalid_bank')
  })
  it('recognizes only queued and running records as cancelable', () => {
    expect(isTraceActive('queued')).toBe(true)
    expect(isTraceActive('running')).toBe(true)
    for (const status of ['match', 'suspected_mismatch', 'canceled', 'error'])
      expect(isTraceActive(status)).toBe(false)
  })
})
