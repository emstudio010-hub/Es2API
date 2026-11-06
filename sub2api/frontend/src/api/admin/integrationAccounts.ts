import { integrationRequest } from './integrationClient'

export interface ExitResource { id: string; label: string; host: string; port: number; status: string; enabled: boolean; available: boolean; bound_vm_ids: string[]; timezone: string | null }
export const listExitResources = (signal?: AbortSignal) => integrationRequest<ExitResource[]>('/exit-resources', { signal })
export const importExitResources = (text: string, signal?: AbortSignal) => integrationRequest<{ added: number; skipped: number }>('/exit-resources', { method: 'POST', data: { text }, signal })

export type IntegrationAccountMode = 'pool' | 'lease'
export type IntegrationAccountStatus = 'provisioning' | 'ready' | 'stopped' | 'error' | 'deleting'
export interface IntegrationGroup {
  id: string
  name: string
  platform: 'openai'
  status: 'active' | 'inactive'
  strategy: 'shared' | 'per_slot'
  lease_account_id: string | null
  account_count: number
  created_at: string
  updated_at: string
}
export interface IntegrationAccount {
  id: string
  name: string
  mode: IntegrationAccountMode
  group_ids: string[]
  status: IntegrationAccountStatus
  schedulable: boolean
  concurrency: number
  priority: number
  vm_id: string | null
  provision_generation: number
  isolation?: { slot_bound: boolean; credential_scope: 'account'; session_scope: string; egress_policy: string; generation: number }
  binding: {
    account_id: string
    name: string
    mode: IntegrationAccountMode
    group_ids: string[]
    group_strategy: string
    proxy_id: string | null
    ip_policy: 'fixed'
    ip_selection: 'create_only'
    identity_policy: 'ip_derived'
    execution_backend?: 'kernel' | 'codex-cli'
    credential_handoff?: { id: string }
    timezone: string | null
    locale: string
    max_concurrency: number | null
    max_rpm: number | null
    max_sessions: number | null
  }
  credential: { has_access_token: boolean; has_refresh_token: boolean; has_id_token: boolean; has_api_key: boolean; fingerprint: string }
  slot: {
    execution_backend?: 'kernel' | 'codex-cli'
    id?: string | null
    status?: string
    ready: boolean
    credential_refresh_pending?: boolean
    health?: { ok: boolean | null; code?: string | null; checked_at?: string | null }
    egress?: { bound: boolean; proxy_id: string | null; timezone?: string | null }
    isolation?: { account_id: string | null; generation: number | null; runtime_type: string | null; container: string | null; identity_policy: string | null }
  } | null
  slot_binding_stale: boolean
  deletion_pending: boolean
  group_pause_restore: boolean
  error: { code: string; message: string } | null
  dispatch: {
    inflight_requests: number
    last_used_at: string | null
    rate_limited_until: string | null
    overload_until: string | null
    temp_unschedulable_until: string | null
    temp_unschedulable_reason: string | null
    last_health_check_at: string | null
  }
  modeltrace: { overrides: Record<string, unknown>; state: Record<string, unknown> }
  successful_requests: number
  created_at: string
  updated_at: string
}
export interface IntegrationPage<T> { items: T[]; total: number; page: number; page_size: number; pages: number }
export interface IntegrationAccountFilters { page?: number; page_size?: number; search?: string; status?: string; mode?: string; group_id?: string }
export interface IntegrationPoolStats { total: number; ready: number; schedulable: number; available: number; busy: number; blocked: number; by_mode: { pool: number; lease: number }; as_of: string }
export interface IntegrationAccountImport {
  execution_backend?: 'kernel' | 'codex-cli'
  account_id: string
  name: string
  mode: IntegrationAccountMode
  credential: Record<string, unknown>
  group_ids: string[]
  concurrency: number
  priority: number
  proxy_id?: string | null
}
export interface IntegrationAccountUpdate {
  name?: string
  concurrency?: number
  priority?: number
  group_ids?: string[]
  schedulable?: boolean
}
export type IntegrationAccountAction = 'sync' | 'retry' | 'retry-delete' | 'delete' | 'start' | 'stop' | 'recover' | 'recover-credential'
const accountPath = (id: string) => `/accounts/${encodeURIComponent(id)}`
export const listIntegrationAccounts = (params: IntegrationAccountFilters = {}, signal?: AbortSignal) =>
  integrationRequest<IntegrationPage<IntegrationAccount>>('/accounts', { params, signal })
export const getIntegrationAccount = (id: string, signal?: AbortSignal) => integrationRequest<IntegrationAccount>(accountPath(id), { signal })
export const getIntegrationPoolStats = (params: Pick<IntegrationAccountFilters, 'mode' | 'group_id'> = {}, signal?: AbortSignal) =>
  integrationRequest<IntegrationPoolStats>('/pool/stats', { params, signal })
export const importIntegrationAccount = (data: IntegrationAccountImport, idempotencyKey: string, signal?: AbortSignal) =>
  integrationRequest<IntegrationAccount>('/accounts', { method: 'POST', data, signal, headers: { 'Idempotency-Key': idempotencyKey } })
export const updateIntegrationAccount = (id: string, data: IntegrationAccountUpdate, signal?: AbortSignal) =>
  integrationRequest<IntegrationAccount>(accountPath(id), { method: 'PUT', data, signal })
export const runIntegrationAccountAction = (id: string, action: IntegrationAccountAction, signal?: AbortSignal) =>
  integrationRequest<IntegrationAccount | { deleted: true; id: string; vm_id: string | null }>(
    action === 'delete' ? accountPath(id) : `${accountPath(id)}/${action}`,
    { method: action === 'delete' ? 'DELETE' : 'POST', signal }
  )
export const listIntegrationGroups = (signal?: AbortSignal) => integrationRequest<IntegrationGroup[]>('/groups', { signal })
export const createIntegrationGroup = (data: { name: string; strategy: 'shared' | 'per_slot' }, signal?: AbortSignal) =>
  integrationRequest<IntegrationGroup>('/groups', { method: 'POST', data: { ...data, platform: 'openai' }, signal })
export const updateIntegrationGroup = (id: string, data: { name?: string; status?: 'active' | 'inactive' }, signal?: AbortSignal) =>
  integrationRequest<IntegrationGroup>(`/groups/${encodeURIComponent(id)}`, { method: 'PUT', data, signal })
