import { integrationRequest } from './integrationClient'

export type TraceTrigger = 'requests' | 'interval' | 'both' | 'requests_and_interval' | 'active_interval' | 'probability' | 'idle_return' | 'manual'
export type TraceRunReason = Exclude<TraceTrigger, 'both'>
export const traceTriggers: TraceTrigger[] = ['requests', 'interval', 'both', 'requests_and_interval', 'active_interval', 'probability', 'idle_return', 'manual']
export const traceRunReasons: TraceRunReason[] = ['manual', 'requests', 'interval', 'requests_and_interval', 'active_interval', 'probability', 'idle_return']
export type TraceAction = 'observe' | 'deprioritize' | 'pause'
export type TraceStatus =
  | 'queued'
  | 'running'
  | 'match'
  | 'suspected_mismatch'
  | 'inconclusive'
  | 'insufficient_samples'
  | 'unlisted_model'
  | 'canceled'
  | 'error'
export interface TraceConfig {
  enabled: boolean
  trigger: TraceTrigger
  model_mode: 'specified' | 'most_used'
  every_requests: number
  interval_seconds: number
  sampling_probability?: number
  idle_seconds?: number
  cooldown_seconds?: number
  model: string
  sample_count: number
  confidence_threshold: number
  consecutive_mismatches: number
  action: TraceAction
  timeout_ms: number
}
export interface TraceBank {
  revision: string | null
  challenges: { id: string; prompt: string }[]
  models: string[]
  ready: boolean
  method?: 'shared-detector-v2' | 'text-similarity'
  source?: string
  aliases?: Record<string, string>
  detector_sha256?: string
}
export interface TraceReadiness {
  ready: boolean
  blockers: string[]
  runner_configured: boolean
  model: string
}
export interface TraceBankInput {
  challenges: { id: string; prompt: string }[]
  models: { id: string; responses: { challenge_id: string; text: string }[] }[]
}
export interface TraceAutomation {
  enabled: boolean
  trigger: TraceTrigger
  every_requests: number
  successful_since_check: number
  remaining_requests: number | null
  next_due: string | null
  active_run_id: string | null
  last_usage_at: string | null
  blocked_reasons: string[]
  ready: boolean
  sampling_probability?: number
  idle_seconds?: number
  cooldown_seconds?: number
  cooldown_until?: string | null
  cooldown_remaining_seconds?: number
  idle_due_at?: string | null
}
export interface TraceUsageBridge {
  configured: boolean
  last_event_at: string | null
}
export interface TraceAccountSummary {
  account_id: string
  enabled: boolean
  schedulable: boolean
  last_run_id: string | null
  last_status: TraceStatus | null
  consecutive_mismatches: number
  readiness?: TraceReadiness
  automation?: TraceAutomation
}
export interface TraceSummary {
  config: TraceConfig
  bank: TraceBank
  active_runs: number
  run_counts: Partial<Record<TraceStatus, number>>
  accounts: TraceAccountSummary[]
  as_of: string
  readiness?: TraceReadiness
  usage_bridge?: TraceUsageBridge
}
export interface TraceAccountConfig {
  account_id: string
  overrides: Partial<TraceConfig>
  effective_config: TraceConfig
  readiness?: TraceReadiness
  automation?: TraceAutomation
  state: {
    auto_paused?: boolean
    deprioritized?: boolean
    consecutive?: number
    next_due?: number | null
    last_status?: TraceStatus
    last_run_id?: string
    [key: string]: unknown
  }
}
export interface TraceRun {
  id: string
  account_id: string
  reason: TraceRunReason
  status: TraceStatus
  created_at: string
  started_at?: string
  finished_at?: string
  duration_ms?: number
  model: string
  expected_model: string
  model_selection?: {
    model: string
    source: 'specified' | 'most_used' | 'fallback'
    successful_requests: number
  }
  applied_action: 'none' | Exclude<TraceAction, 'observe'>
  sample_count: number
  action_skipped_reason?: string
  error?: { code: string; message: string }
  result?: {
    status: TraceStatus
    expected_model: string
    prediction?: string | null
    confidence?: number | null
    method?: string
    expected_candidate?: string
    actionable: boolean
    used_outputs: number
    scores?: { model: string; score: number | null; samples: number }[]
  }
  samples?: {
    challenge_id: string
    sha256: string
    length: number
    usage: unknown
  }[]
}
export interface TraceRunFilters {
  account_id?: string
  status?: string
  reason?: string
  model?: string
  page?: number
  page_size?: number
}
export interface TraceRunPage {
  items: TraceRun[]
  total: number
  page: number
  page_size: number
  pages: number
}
const accountPath = (id: string) =>
  `/accounts/${encodeURIComponent(id)}/modeltrace`
const runPath = (id: string) => `/modeltrace/runs/${encodeURIComponent(id)}`
export const modeltraceApi = {
  summary: (signal?: AbortSignal) =>
    integrationRequest<TraceSummary>('/modeltrace/summary', { signal }),
  config: (signal?: AbortSignal) =>
    integrationRequest<TraceConfig>('/modeltrace/config', { signal }),
  saveConfig: (data: TraceConfig) =>
    integrationRequest<TraceConfig>('/modeltrace/config', {
      method: 'PUT',
      data
    }),
  bank: (signal?: AbortSignal) =>
    integrationRequest<TraceBank>('/modeltrace/bank', { signal }),
  installBank: (data: TraceBankInput) =>
    integrationRequest<{
      challenge_count: number
      models: string[]
      revision: string
      updated_at: string
    }>('/modeltrace/bank', { method: 'PUT', data }),
  account: (id: string, signal?: AbortSignal) =>
    integrationRequest<TraceAccountConfig>(accountPath(id), { signal }),
  saveAccount: (
    id: string,
    data: Partial<TraceConfig> & { inherit?: boolean }
  ) =>
    integrationRequest<
      Pick<TraceAccountConfig, 'overrides' | 'effective_config'>
    >(accountPath(id), { method: 'PUT', data }),
  resetAction: (id: string) =>
    integrationRequest<unknown>(`${accountPath(id)}/reset-action`, {
      method: 'POST'
    }),
  run: (account_id: string) =>
    integrationRequest<TraceRun>('/modeltrace/run', {
      method: 'POST',
      data: { account_id }
    }),
  runs: (params: TraceRunFilters, signal?: AbortSignal) =>
    integrationRequest<TraceRunPage>('/modeltrace/runs', { params, signal }),
  detail: (id: string, signal?: AbortSignal) =>
    integrationRequest<TraceRun>(runPath(id), { signal }),
  cancel: (id: string) =>
    integrationRequest<{ canceled: boolean }>(`${runPath(id)}/cancel`, {
      method: 'POST'
    })
}
export const isTraceActive = (status: string) =>
  status === 'queued' || status === 'running'

/** Reject an incomplete bank before presenting a destructive replacement confirmation. */
export function parseTraceBank(source: string): TraceBankInput {
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_bank')
  const bank = value as TraceBankInput
  if (
    !Array.isArray(bank.challenges) ||
    bank.challenges.length < 3 ||
    bank.challenges.length > 100 ||
    !Array.isArray(bank.models) ||
    bank.models.length < 2 ||
    bank.models.length > 100
  )
    throw new Error('invalid_bank')
  const ids = new Set<string>()
  for (const item of bank.challenges) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.trim().length > 100 ||
      ids.has(item.id.trim()) ||
      typeof item.prompt !== 'string' ||
      !item.prompt.trim() ||
      item.prompt.trim().length > 12000
    )
      throw new Error('invalid_bank')
    ids.add(item.id.trim())
  }
  const models = new Set<string>()
  for (const model of bank.models) {
    if (
      !model ||
      typeof model.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._:/-]{0,149}$/i.test(model.id.trim()) ||
      models.has(model.id.trim()) ||
      !Array.isArray(model.responses) ||
      model.responses.length !== ids.size
    )
      throw new Error('invalid_bank')
    models.add(model.id.trim())
    const responses = new Set<string>()
    for (const item of model.responses) {
      if (
        !item ||
        !ids.has(item.challenge_id) ||
        responses.has(item.challenge_id) ||
        typeof item.text !== 'string' ||
        !item.text.trim() ||
        item.text.trim().length > 64000
      )
        throw new Error('invalid_bank')
      responses.add(item.challenge_id)
    }
  }
  return {
    challenges: bank.challenges.map((item) => ({
      id: item.id.trim(),
      prompt: item.prompt.trim()
    })),
    models: bank.models.map((model) => ({
      id: model.id.trim(),
      responses: model.responses.map((item) => ({
        challenge_id: item.challenge_id,
        text: item.text.trim()
      }))
    }))
  }
}
