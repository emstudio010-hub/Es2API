/**
 * Codex slot metadata. Tokens stay in vms/<id>/codex-credentials.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, readJsonCached } from './vm-file.mjs'
import { isCodexVm } from '../protocol/codex-route.mjs'
import { buildCodexUsageView, extraToCodexSnapshot, hasSpendableCodexCredits } from '../protocol/codex-usage.mjs'
import { openaiClaimsFromIdToken, openaiIdentityFromOauthTokens } from '../oauth/openai-jwt.mjs'
import { selectOAuthCredential } from '../oauth/credential-import.mjs'
import { assertCodexCredentialNotHandingOff } from '../oauth/codex-credential-lock.mjs'

export { isCodexVm }

export function codexCredentialPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'codex-credentials.json')
}

export function readCodexAccounts(projectRoot, vmId) {
  const file = codexCredentialPath(projectRoot, vmId)
  try {
    const raw = readJsonCached(file)
    return Array.isArray(raw?.accounts) ? raw.accounts : []
  } catch {
    return []
  }
}

// Lifecycle writes must distinguish an empty slot from a corrupt credential file.
export function readCodexAccountsStrict(projectRoot, vmId) {
  const file = codexCredentialPath(projectRoot, vmId)
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('credential file too large')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(raw?.accounts) || raw.accounts.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('invalid credential accounts')
    return raw.accounts
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw Object.assign(new Error('实例凭据文件无法读取，已保留原文件'), { status: 409, code: 'codex_credential_file_invalid' })
  }
}

export function writeCodexAccounts(projectRoot, vmId, accounts) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  if (fs.existsSync(path.join(projectRoot, 'vms', `${vmId}.json`))) assertCodexCredentialNotHandingOff(projectRoot, vmId)
  atomicWriteJson(
    codexCredentialPath(projectRoot, vmId),
    { accounts: Array.isArray(accounts) ? accounts.map(enrichCodexAccountIdentity) : [] },
    { mode: 0o600 },
  )
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

function looksLikeClaudeSecret(text) {
  return /^sk-ant-/i.test(String(text || '').trim())
}

function extractOauthTokens(value) {
  const selected = selectOAuthCredential(value)
  return { access: selected?.tokens.access_token || '', refresh: selected?.tokens.refresh_token || '',
    idToken: selected?.tokens.id_token || '', selected }
}

function isOpenaiApiKeyOnly(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  const apiKey = firstString(doc.OPENAI_API_KEY, doc.openai_api_key, doc.api_key)
  if (!apiKey) return false
  const tokens = extractOauthTokens(doc)
  return !tokens.access && !tokens.refresh
}

function accountFromTokens(source, access, refresh, idToken, selected = null) {
  const selection = selected || selectOAuthCredential(source)
  const hints = selection?.metadata || {}
  const records = selection?.records || []
  const rpm = Number(records.find(row => row.rpm != null)?.rpm)
  const conc = Number(records.find(row => row.max_concurrency != null)?.max_concurrency)
  const account = enrichCodexAccountIdentity({
    access_token: access,
    refresh_token: refresh,
    id_token: idToken,
    expires_at: hints.expires_at || 0,
    chatgpt_account_id: hints.chatgpt_account_id || '',
    email: hints.email || null,
    rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 0,
    max_concurrency: Number.isFinite(conc) && conc > 0 ? conc : 0,
  })
  // Older kernel exports used the email as their account id. Other ids are not emails.
  const legacyId = firstString(records[0]?.id)
  if (!account.email && legacyId.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(legacyId)) account.email = legacyId
  return { ...account, id: account.email || account.chatgpt_account_id || 'codex' }
}

function parseTokenList(text, mode) {
  const tokens = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!tokens.length) return { ok: false, error: 'empty', message: '凭证不能为空' }
  const first = tokens[0]
  if (looksLikeClaudeSecret(first)) {
    return {
      ok: false,
      error: 'credential_kind_mismatch',
      message: '不能导入 Claude 凭证。GPT 槽需要 ChatGPT/Codex OAuth。',
    }
  }
  const access = mode === 'refresh_token' ? '' : first
  const refresh = mode === 'refresh_token' ? first : ''
  if (!access && !refresh) return { ok: false, error: 'missing_token', message: '需要 access_token 或 refresh_token' }
  return {
    ok: true,
    account: accountFromTokens({}, access, refresh, ''),
    extra_count: Math.max(0, tokens.length - 1),
  }
}

/**
 * Parse Codex CLI auth.json, ChatGPT OAuth JSON, CPR openai document, AT/RT paste.
 * Does not accept Claude sessionKey / Setup Token / Console API Key / OPENAI_API_KEY-only.
 */
export function parseCodexCredentialInput(input, opts = {}) {
  const mode = String(opts.mode || '')
    .trim()
    .toLowerCase()
  if (mode === 'access_token' || mode === 'refresh_token') {
    if (typeof input === 'string') return parseTokenList(input, mode)
    const tokens = extractOauthTokens(input)
    if (mode === 'access_token' && !tokens.access) {
      return { ok: false, error: 'missing_token', message: '请粘贴 Access Token' }
    }
    if (mode === 'refresh_token' && !tokens.refresh) {
      return { ok: false, error: 'missing_token', message: '请粘贴 Refresh Token' }
    }
    return {
      ok: true,
      account: accountFromTokens(
        input && typeof input === 'object' ? input : {},
        tokens.access,
        tokens.refresh,
        tokens.idToken,
        tokens.selected,
      ),
    }
  }

  let doc = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return { ok: false, error: 'empty', message: '凭证不能为空' }
    try {
      doc = JSON.parse(text)
    } catch {
      return {
        ok: false,
        error: 'invalid_json',
        message: '不是合法 JSON。请上传 auth.json / 账号文件，或改用 AT/RT 粘贴。',
      }
    }
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'invalid_json', message: '需要 ChatGPT/Codex OAuth JSON' }
  }
  if (isOpenaiApiKeyOnly(doc)) {
    return {
      ok: false,
      error: 'not_oauth_account',
      message: 'OPENAI_API_KEY 客户端配置不是 OAuth 账号。请导入 auth.json / AT / RT。',
    }
  }
  const tokens = extractOauthTokens(doc)
  if (tokens.access || tokens.refresh) {
    if (looksLikeClaudeSecret(tokens.access) || looksLikeClaudeSecret(tokens.refresh)) {
      return {
        ok: false,
        error: 'credential_kind_mismatch',
        message: '不能导入 Claude 凭证。GPT 槽需要 ChatGPT/Codex OAuth。',
      }
    }
    return { ok: true, account: accountFromTokens(doc, tokens.access, tokens.refresh, tokens.idToken, tokens.selected) }
  }
  return {
    ok: false,
    error: 'missing_token',
    message: '需要 ChatGPT/Codex OAuth（access_token 或 refresh_token）。不能导入 Claude 凭证。',
  }
}

export function parseCodexImportPayload(body = {}) {
  const mode = String(body.mode || body.import_mode || '')
    .trim()
    .toLowerCase()
  const raw = body.auth_json ?? body.raw ?? body.text ?? body.data
  if (raw != null && raw !== '') return parseCodexCredentialInput(raw, { mode })
  return parseCodexCredentialInput(body, { mode })
}

export function enrichCodexAccountIdentity(account = {}) {
  const next = { ...account }
  const idToken = firstString(next.id_token, next.idToken)
  if (idToken) {
    const idClaims = openaiClaimsFromIdToken(idToken)
    if (idClaims.has_chatgpt_subscription_active_until) {
      next.chatgpt_subscription_active_until = idClaims.chatgpt_subscription_active_until
    }
    if (idClaims.has_chatgpt_plan_type) {
      next.chatgpt_plan_type = idClaims.chatgpt_plan_type
    }
  }
  const fromTokens = openaiIdentityFromOauthTokens(next)
  if (!firstString(next.email)) next.email = fromTokens.email || null
  if (!firstString(next.chatgpt_account_id)) {
    next.chatgpt_account_id = fromTokens.chatgpt_account_id || null
  }
  if (!idToken && !firstString(next.chatgpt_subscription_active_until)) {
    next.chatgpt_subscription_active_until = fromTokens.chatgpt_subscription_active_until || null
  }
  return next
}

export function upsertCodexAccount(projectRoot, vmId, patch = {}, { replaceCredentials = false } = {}) {
  const accounts = readCodexAccounts(projectRoot, vmId)
  const previous = { ...(accounts[0] || {}) }
  // Importing another account must not inherit the previous account's tokens or identity.
  // Refreshes still retain metadata when the provider omits it from the response.
  if (replaceCredentials) {
    for (const key of [
      'id',
      'email',
      'chatgpt_account_id',
      'chatgpt_subscription_active_until',
      'chatgpt_plan_type',
      'access_token',
      'refresh_token',
      'id_token',
      'expires_at',
    ]) {
      delete previous[key]
    }
  }
  const cur = enrichCodexAccountIdentity({ ...previous, ...patch })
  if (!cur.id) cur.id = cur.email || cur.chatgpt_account_id || 'codex'
  if (!accounts.length) accounts.push(cur)
  else accounts[0] = cur
  writeCodexAccounts(projectRoot, vmId, accounts)
  return cur
}

export function persistCodexQuotaSnapshot(projectRoot, vmId, { extra, resetCredits, credits, planType } = {}) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  let vm
  try {
    vm = readJsonCached(file)
  } catch {
    return null
  }
  if (!vm || typeof vm !== 'object') return null
  vm.codex = vm.codex && typeof vm.codex === 'object' ? { ...vm.codex } : {}
  if (extra && typeof extra === 'object') {
    vm.codex.extra = { ...(vm.codex.extra || {}), ...extra }
    vm.codex.usage = buildCodexUsageView(extraToCodexSnapshot(vm.codex.extra))
  }
  if (credits) {
    vm.codex.credits = credits
    // A fresh read that credits are spendable supersedes an older park; the next 429 parks again.
    if (hasSpendableCodexCredits(vm) && vm.codex.extra?.codex_limited_until) {
      vm.codex.extra = { ...vm.codex.extra }
      delete vm.codex.extra.codex_limited_until
    }
  }
  const plan = String(planType || '').trim()
  if (plan) vm.codex.plan_type = plan
  if (resetCredits && typeof resetCredits === 'object') {
    vm.codex.reset_credits = {
      available_count: Math.max(0, Number(resetCredits.available_count) || 0),
      credits: Array.isArray(resetCredits.credits)
        ? resetCredits.credits
            .map((row) => ({ expires_at: String(row?.expires_at || '').trim() }))
            .filter((row) => row.expires_at)
        : [],
      fetched_at: resetCredits.fetched_at || new Date().toISOString(),
    }
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function summarizeCodexSlot(projectRoot, vm = {}) {
  const accounts = projectRoot && vm?.id ? readCodexAccounts(projectRoot, vm.id) : []
  const first = enrichCodexAccountIdentity(accounts[0] || {})
  const extra = vm.codex?.extra || vm.codex_extra || {}
  // extra is the source of truth; the stored view is only a fallback for slots without extra.
  const usage = buildCodexUsageView(Object.keys(extra).length ? extraToCodexSnapshot(extra) : vm.codex?.usage || {})
  const hasAccess = !!(first.access_token || vm.codex?.has_access)
  const hasRefresh = !!(first.refresh_token || vm.codex?.has_refresh)
  return {
    platform: 'openai',
    family: 'codex',
    has_token: hasAccess || hasRefresh,
    has_refresh: hasRefresh,
    email: first.email || vm.codex?.email || vm.email || null,
    expires_at: first.expires_at || vm.codex?.expires_at || null,
    chatgpt_account_id: first.chatgpt_account_id || vm.codex?.chatgpt_account_id || null,
    chatgpt_subscription_active_until: first.chatgpt_subscription_active_until || null,
    chatgpt_plan_type: first.chatgpt_plan_type || null,
    account_count: accounts.length,
    usage,
    reset_credits: vm.codex?.reset_credits || null,
    credits: vm.codex?.credits || null,
    plan_type: vm.codex?.plan_type || null,
  }
}
