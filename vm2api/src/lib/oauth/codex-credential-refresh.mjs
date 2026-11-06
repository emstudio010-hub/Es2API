import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { withCodexCredentialLock, assertCodexIntegrationBinding } from './codex-credential-lock.mjs'
import { readCodexAccountsStrict, writeCodexAccounts, enrichCodexAccountIdentity, codexCredentialPath } from '../vm/codex-slot.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import { withCodexKernelCredentialOwner } from './codex-kernel-credential-owner.mjs'
import { verifyCodexProviderIdentity } from './codex-provider-identity.mjs'
import { beginCodexRefresh, captureCodexRefresh, readPendingCodexRefresh, commitCodexRefresh } from './codex-refresh-journal.mjs'
import { codexSlotSnapshot, readCodexSlotSnapshot } from './codex-slot-snapshot.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'

const changed = () => Object.assign(new Error('OAuth 或实例归属在刷新期间已变化，已保留刷新日志和原记录'), { status: 409, code: 'codex_credential_changed' })
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
function safeError(error) {
  if (/^(?:codex_[a-z_]+|provider_identity_[a-z_]+|vm2_credential_binding_mismatch)$/.test(error?.code || '')) throw error
  throw Object.assign(new Error('刷新凭据的私密存储或恢复不可用，已停止操作'), { status: 503, code: 'codex_refresh_storage_unavailable' })
}
function binding(projectRoot, vmId) {
  const vm = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', `${vmId}.json`), 'utf8'))
  if (vm.id !== vmId) throw changed()
  return digest([vm.id, vm.integration_binding || null, vm.execution_backend || 'kernel', vm.proxy?.id || null])
}
function candidate(account, token) {
  if (!token || token.ok !== true || typeof token.access_token !== 'string' || !token.access_token) throw Object.assign(
    new Error('OAuth 换票未确认，已保留刷新日志；不会再次消费旧刷新令牌'), { status: 409, code: 'codex_refresh_recovery_required' })
  return enrichCodexAccountIdentity({ ...account, access_token: token.access_token,
    refresh_token: token.refresh_token || account.refresh_token, id_token: token.id_token || account.id_token,
    expires_at: token.expires_at || account.expires_at })
}
async function finish(projectRoot, vmId, session, expectedIdentity = null) {
  const data = session.data
  // Older encrypted journals retain their original binding rule. New journals
  // additionally bind the route credentials, placement and instance identity.
  if (Object.hasOwn(data, 'slot_snapshot')) readCodexSlotSnapshot(projectRoot, vmId, data.slot_snapshot)
  if (!Array.isArray(data.accounts) || !Number.isSafeInteger(data.index) || !data.accounts[data.index]
    || !data.expected_identity || binding(projectRoot, vmId) !== data.binding) throw changed()
  if (expectedIdentity && data.expected_identity !== expectedIdentity) throw Object.assign(new Error('待恢复日志与控制面账号身份不符，已保留原凭据和日志'), { status: 409, code: 'codex_refresh_identity_mismatch' })
  const next = candidate(data.accounts[data.index], data.response)
  const proof = await verifyCodexProviderIdentity(next)
  if (proof.identity_key !== data.expected_identity) throw Object.assign(new Error('换票结果与原供应商账号身份不同，未提交新凭据；加密响应已保留'),
    { status: 409, code: 'codex_refresh_identity_mismatch' })
  const latest = readCodexAccountsStrict(projectRoot, vmId)
  const intended = data.accounts.map((row, i) => enrichCodexAccountIdentity(i === data.index ? next : row))
  // Recovery accepts the exact already-written commit, never a partial token match.
  if (digest(latest) !== digest(data.accounts) && digest(latest) !== digest(intended)) throw changed()
  if (binding(projectRoot, vmId) !== data.binding) throw changed()
  if (Object.hasOwn(data, 'slot_snapshot')) readCodexSlotSnapshot(projectRoot, vmId, data.slot_snapshot)
  return commitCodexRefresh(session, codexCredentialPath(projectRoot, vmId), () => {
    if (digest(latest) !== digest(intended)) writeCodexAccounts(projectRoot, vmId, intended)
    if (digest(readCodexAccountsStrict(projectRoot, vmId)) !== digest(intended)) throw changed()
    return next
  })
}

export async function refreshStoredCodexCredential(projectRoot, vmId, {
  previous = null, usedAccess = null, expectedVm = null, proxyUrl: _ignoredCallerProxy,
  refresh = refreshCodexAccessToken, ...options
} = {}) {
  const expected = codexSlotSnapshot(expectedVm)
  if (expectedVm.id !== vmId) throw changed()
  return withCodexCredentialLock(projectRoot, vmId, () => {
    const before = readCodexSlotSnapshot(projectRoot, vmId, expected)
    if (before.integration_binding?.account_id) assertCodexIntegrationBinding(before, {
      account_id: before.integration_binding.account_id, provision_generation: before.integration_binding.provision_generation,
      proxy_id: before.proxy?.id, execution_backend: before.execution_backend || 'kernel',
    })
    return withCodexKernelCredentialOwner(projectRoot, vmId, async () => {
      const vm = readCodexSlotSnapshot(projectRoot, vmId, expected)
      const proxyUrl = hostProxyUrlForVm(vm)
      if ((!proxyUrl && !isLocalEgressProxy(vm.proxy)) || (vm.integration_binding?.account_id && isLocalEgressProxy(vm.proxy))) {
        throw Object.assign(new Error('固定出口不可用，未开始换票'), { status: 409, code: 'codex_refresh_proxy_required' })
      }
      const accounts = readCodexAccountsStrict(projectRoot, vmId)
      const index = previous ? accounts.findIndex(row => row.refresh_token === previous.refresh_token
        && row.access_token === previous.access_token && row.id_token === previous.id_token) : 0
      if (!accounts.length || index < 0 || (!previous && accounts.length !== 1)) throw changed()
      const account = accounts[index]
      const proof = await verifyCodexProviderIdentity(account)
      const confirmed = readCodexSlotSnapshot(projectRoot, vmId, expected)
      if (hostProxyUrlForVm(confirmed) !== proxyUrl || digest(readCodexAccountsStrict(projectRoot, vmId)) !== digest(accounts)) throw changed()
      if (usedAccess && account.access_token && account.access_token !== usedAccess) return account
      if (!account.refresh_token) throw Object.assign(new Error('OAuth 缺少刷新令牌'), { status: 409, code: 'codex_refresh_required' })
      if (options.signal?.aborted || Date.now() >= (options.deadline ?? Infinity)) throw Object.assign(new Error('请求已取消或预算已用尽，未开始换票'), { status: 499, code: 'codex_cli_cancelled' })
      const session = beginCodexRefresh(projectRoot, vmId, { accounts, index, expected_identity: proof.identity_key,
        binding: binding(projectRoot, vmId), slot_snapshot: expected })
      const token = await refresh({ ...options, proxyUrl, refreshToken: account.refresh_token,
        capture: response => captureCodexRefresh(session, response) })
      if (token?.ok) captureCodexRefresh(session, token)
      return finish(projectRoot, vmId, session)
    }, { timeoutMs: options.timeoutMs })
  }).catch(safeError)
}

// Explicit local recovery only: no OAuth exchange, inference or token retry.
export function recoverStoredCodexRefresh(projectRoot, vmId, { expectedBinding = null, expectedIdentity = null } = {}) {
  return withCodexCredentialLock(projectRoot, vmId, async () => {
    const vm = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', `${vmId}.json`), 'utf8'))
    if (vm.integration_binding?.account_id) {
      assertCodexIntegrationBinding(vm, expectedBinding)
      if (!/^[a-f0-9]{64}$/.test(expectedIdentity || '')) throw Object.assign(new Error('独立账号池恢复必须核对控制面身份索引'), { status: 409, code: 'provider_identity_proof_required' })
    }
    const session = readPendingCodexRefresh(projectRoot, vmId)
    if (Object.hasOwn(session.data, 'slot_snapshot')) readCodexSlotSnapshot(projectRoot, vmId, session.data.slot_snapshot)
    return withCodexKernelCredentialOwner(projectRoot, vmId, async () => {
      await finish(projectRoot, vmId, session, expectedIdentity)
      // Return only the binding checked under this lock, never token material.
      return { recovered: true, oauth_exchange_performed: false, vm_id: vmId,
        account_id: vm.integration_binding?.account_id || null,
        provision_generation: vm.integration_binding?.provision_generation || null }
    })
  }, { allowRefreshRecovery: true, allowShutdown: true }).catch(safeError)
}
