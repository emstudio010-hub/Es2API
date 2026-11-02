import type { IntegrationAccount, IntegrationGroup } from '@/api/admin/integrationAccounts'
export const group: IntegrationGroup = { id: 'g-one', name: 'Shared group', platform: 'openai', status: 'active', strategy: 'shared', lease_account_id: null, account_count: 1, created_at: '', updated_at: '' }
export function account(overrides: Partial<IntegrationAccount> = {}): IntegrationAccount {
  return {
    id: 'account-one', name: 'Example account', mode: 'pool', group_ids: ['g-one'], status: 'ready', schedulable: true,
    concurrency: 2, priority: 50, vm_id: 'es2-account-one', provision_generation: 1,
    binding: { account_id: 'account-one', name: 'Example account', mode: 'pool', group_ids: ['g-one'], group_strategy: 'shared', proxy_id: null, ip_policy: 'fixed', timezone: null, locale: 'en_US.UTF-8', max_concurrency: 2, max_rpm: null, max_sessions: null },
    credential: { has_access_token: true, has_refresh_token: true, has_id_token: false, has_api_key: false, fingerprint: 'public-fingerprint' },
    slot: { status: 'running', ready: true, health: { ok: true }, egress: { bound: true, proxy_id: 'proxy-one' } },
    slot_binding_stale: false, deletion_pending: false, group_pause_restore: false, error: null,
    dispatch: { inflight_requests: 0, last_used_at: null, rate_limited_until: null, overload_until: null, temp_unschedulable_until: null, temp_unschedulable_reason: null, last_health_check_at: null },
    modeltrace: { overrides: {}, state: {} }, successful_requests: 0, created_at: '', updated_at: '', ...overrides
  }
}
