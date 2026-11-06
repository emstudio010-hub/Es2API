// Historical signed binding for deduplication, NOT login/plan authorization.
// This profile is specific to the pinned legacy Codex public client. Dynamic
// OSS registrations have a different contract and are not inferred from it.
import crypto from 'node:crypto'
import { compactVerify, createRemoteJWKSet, decodeProtectedHeader } from 'jose'
import { selectOAuthCredential } from './credential-import.mjs'

const ISSUER = 'https://auth.openai.com'
const CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann'
const RESOURCE = 'https://api.openai.com/v1'
const AUTH = 'https://api.openai.com/auth'
const proofs = new WeakMap()
// Only this public URL is contacted. No token, hint, kid, subject or workspace
// is sent to the JWKS endpoint; input jku/x5u never selects a remote URL.
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
  timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
})
const invalid = () => Object.assign(new Error('无法确认该 OAuth 的旧版 Codex 账号身份，请提供完整且同属一个账号的凭据'),
  { status: 400, code: 'provider_identity_invalid' })
const unavailable = () => Object.assign(new Error('供应商签名密钥暂不可用，已保留原账号、凭据和执行槽'),
  { status: 503, code: 'provider_identity_verification_unavailable' })
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\x00-\x20\x7f]/.test(value)
const audience = (claim, expected) => typeof claim === 'string' ? claim === expected
  : Array.isArray(claim) && claim.length > 0 && claim.length <= 16 && claim.every(v => text(v)) && claim.includes(expected)

function selected(input) {
  const record = selectOAuthCredential(input)
  if (!record?.tokens?.access_token) throw invalid()
  return record
}

function stamp(credential) {
  const { tokens, metadata } = selected(credential)
  return crypto.createHash('sha256').update(JSON.stringify([
    tokens.access_token || null, tokens.refresh_token || null, tokens.id_token || null,
    tokens.api_key || null, metadata.chatgpt_account_id || null,
  ])).digest('hex')
}

async function claims(token, expectedAudience, now) {
  if (typeof token !== 'string' || token.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid()
  const header = decodeProtectedHeader(token)
  if (header.alg !== 'RS256' || !text(header.kid, 256)) throw invalid()
  const verified = await compactVerify(token, jwks, { algorithms: ['RS256'] })
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.payload)) } catch { throw invalid() }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.iss !== ISSUER || !audience(payload.aud, expectedAudience) || !text(payload.sub)
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.iat < 0 || payload.iat > now + 5 || payload.exp <= payload.iat
    || payload.exp > 253402300799
    || (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf < 0 || payload.nbf > now + 5 || payload.nbf >= payload.exp))) throw invalid()
  // Expiry is retained as evidence, deliberately not accepted as a fresh login.
  // A retained, expired ID token is normal after access-token rotation. Never
  // reuse this API for OIDC nonce/login checks or model permission decisions.
  return payload
}

export async function verifyCodexProviderIdentity(credential) {
  try {
    const record = selected(credential), now = Math.floor(Date.now() / 1000)
    if (record.tokens.api_key) throw invalid()
    const access = await claims(record.tokens.access_token, RESOURCE, now)
    const workspace = access[AUTH]?.chatgpt_account_id
    if (access.client_id !== CLIENT || !text(workspace, 256)) throw invalid()
    if (record.metadata.chatgpt_account_id && record.metadata.chatgpt_account_id !== workspace) throw invalid()
    if (record.tokens.id_token) {
      const id = await claims(record.tokens.id_token, CLIENT, now)
      if (id.sub !== access.sub || (id.azp !== undefined && id.azp !== CLIENT)
        || (Array.isArray(id.aud) && id.aud.length > 1 && id.azp !== CLIENT)
        || (id[AUTH]?.chatgpt_account_id !== undefined && id[AUTH].chatgpt_account_id !== workspace)) throw invalid()
    }
    const proof = Object.freeze({
      identity_key: crypto.createHash('sha256').update(JSON.stringify(['codex-legacy-v1', ISSUER, CLIENT, access.sub, workspace])).digest('hex'),
      profile: 'codex-legacy-v1', verified_at: new Date().toISOString(),
      evidence_kind: 'historical_signed_binding', access_expired: access.exp <= now,
      login_verified: false, model_permission_verified: false,
    })
    proofs.set(proof, stamp(credential))
    return proof
  } catch (error) {
    if (error?.code === 'provider_identity_invalid') throw error
    if (['ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWS_INVALID', 'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED'].includes(error?.code)) throw invalid()
    throw unavailable()
  }
}

// A submitted JSON object cannot masquerade as a verification result. Bind each
// in-process proof to all token bytes and the selected workspace hint.
export function assertVerifiedCodexIdentity(proof, credential) {
  if (!proof || proofs.get(proof) !== stamp(credential)) throw Object.assign(new Error('供应商身份验证结果缺失或凭据已变化'),
    { status: 409, code: 'provider_identity_proof_required' })
  return proof
}
