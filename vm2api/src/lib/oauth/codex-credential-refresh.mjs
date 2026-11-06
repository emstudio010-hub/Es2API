import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { withCodexCredentialLock, assertCodexIntegrationBinding } from './codex-credential-lock.mjs'
import { readCodexAccountsStrict, writeCodexAccounts, enrichCodexAccountIdentity, codexCredentialPath } from '../vm/codex-slot.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import { withCodexKernelCredentialOwner } from './codex-kernel-credential-owner.mjs'
import { verifyCodexProviderIdentity } from './codex-provider-identity.mjs'
import { beginCodexRefresh, captureCodexRefresh, readPendingCodexRefresh, commitCodexRefresh } from './codex-refresh-journal.mjs'

const changed = () => Object.assign(new Error('OAuth 或实例归属在刷新期间已变化，已保留刷新日志和原记录'), { status: 409, code: 'codex_credential_changed' })
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
function safeError(error) {
  if (/^(?:codex_[a-z_]+|provider_identity_[a-z_]+)$/.test(error?.code || '')) throw error
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
  return commitCodexRefresh(session, codexCredentialPath(projectRoot, vmId), () => {
    if (digest(latest) !== digest(intended)) writeCodexAccounts(projectRoot, vmId, intended)
    if (digest(readCodexAccountsStrict(projectRoot, vmId)) !== digest(intended)) throw changed()
    return next
  })
}

export function refreshStoredCodexCredential(projectRoot, vmId, {
  previous = null, usedAccess = null, refresh = refreshCodexAccessToken, ...options
} = {}) {
  return withCodexCredentialLock(projectRoot, vmId, () => withCodexKernelCredentialOwner(projectRoot, vmId, async () => {
    const accounts = readCodexAccountsStrict(projectRoot, vmId)
    const index = previous ? accounts.findIndex(row => row.refresh_token === previous.refresh_token
      && row.access_token === previous.access_token && row.id_token === previous.id_token) : 0
    if (!accounts.length || index < 0 || (!previous && accounts.length !== 1)) throw changed()
    const account = accounts[index]
    const proof = await verifyCodexProviderIdentity(account)
    if (usedAccess && account.access_token && account.access_token !== usedAccess) return account
    if (!account.refresh_token) throw Object.assign(new Error('OAuth 缺少刷新令牌'), { status: 409, code: 'codex_refresh_required' })
    if (options.signal?.aborted || Date.now() >= (options.deadline ?? Infinity)) throw Object.assign(new Error('请求已取消或预算已用尽，未开始换票'), { status: 499, code: 'codex_cli_cancelled' })
    const session = beginCodexRefresh(projectRoot, vmId, { accounts, index, expected_identity: proof.identity_key, binding: binding(projectRoot, vmId) })
    const token = await refresh({ ...options, refreshToken: account.refresh_token,
      capture: response => captureCodexRefresh(session, response) })
    if (token?.ok) captureCodexRefresh(session, token)
    return finish(projectRoot, vmId, session)
  }, { timeoutMs: options.timeoutMs })).catch(safeError)
}

// Explicit local recovery only: no OAuth exchange, inference or token retry.
export function recoverStoredCodexRefresh(projectRoot, vmId, { expectedBinding = null, expectedIdentity = null } = {}) {
  return withCodexCredentialLock(projectRoot, vmId, async () => {
    const vm = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', `${vmId}.json`), 'utf8'))
    if (vm.integration_binding?.account_id) {
      assertCodexIntegrationBinding(vm, expectedBinding)
      if (!/^[a-f0-9]{64}$/.test(expectedIdentity || '')) throw Object.assign(new Error('独立账号池恢复必须核对控制面身份索引'), { status: 409, code: 'provider_identity_proof_required' })
    }
    return withCodexKernelCredentialOwner(projectRoot, vmId, async () => {
      await finish(projectRoot, vmId, readPendingCodexRefresh(projectRoot, vmId), expectedIdentity)
      // Return only the binding checked under this lock, never token material.
      return { recovered: true, oauth_exchange_performed: false, vm_id: vmId,
        account_id: vm.integration_binding?.account_id || null,
        provision_generation: vm.integration_binding?.provision_generation || null }
    })
  }, { allowRefreshRecovery: true, allowShutdown: true }).catch(safeError)
}
