import { withCodexCredentialLock } from './codex-credential-lock.mjs'
import { readCodexAccountsStrict, writeCodexAccounts, enrichCodexAccountIdentity } from '../vm/codex-slot.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'

export function refreshStoredCodexCredential(projectRoot, vmId, {
  previous = null, usedAccess = null, refresh = refreshCodexAccessToken, ...options
} = {}) {
  return withCodexCredentialLock(projectRoot, vmId, async () => {
    const accounts = readCodexAccountsStrict(projectRoot, vmId)
    const index = previous ? accounts.findIndex(row =>
      (previous.refresh_token && row.refresh_token === previous.refresh_token)
      || (previous.access_token && row.access_token === previous.access_token)
      || (previous.chatgpt_account_id && row.chatgpt_account_id === previous.chatgpt_account_id)) : 0
    if (!accounts.length || index < 0 || (!previous && accounts.length !== 1)) {
      throw Object.assign(new Error('OAuth 记录已变化或数量不匹配，未开始刷新'), { status: 409, code: 'codex_credential_changed' })
    }
    const account = accounts[index]
    if (usedAccess && account.access_token && account.access_token !== usedAccess) return account
    if (!account.refresh_token) throw Object.assign(new Error('OAuth 缺少刷新令牌'), { status: 409, code: 'codex_refresh_required' })
    const token = await refresh({ ...options, refreshToken: account.refresh_token })
    if (!token?.ok || !token.access_token) throw Object.assign(new Error('OAuth 刷新失败'), { status: 502, code: 'codex_refresh_failed' })
    const latest = readCodexAccountsStrict(projectRoot, vmId)
    if (latest[index]?.refresh_token !== account.refresh_token || latest[index]?.access_token !== account.access_token) {
      throw Object.assign(new Error('OAuth 记录在刷新期间已变化，未覆盖新凭据'), { status: 409, code: 'codex_credential_changed' })
    }
    latest[index] = enrichCodexAccountIdentity({ ...account, access_token: token.access_token,
      refresh_token: token.refresh_token || account.refresh_token, id_token: token.id_token || account.id_token,
      expires_at: token.expires_at || account.expires_at })
    writeCodexAccounts(projectRoot, vmId, latest)
    return latest[index]
  })
}
