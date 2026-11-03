// Pure import selection shared by the control plane and execution service.
// Never merge tokens from separate objects, arrays, or sibling account records.
const WRAPPERS = new Set(['tokens', 'credentials', 'oauth', 'auth', 'document', 'data'])
const TOKEN_NAMES = new Map([
  ['access_token', 'access_token'], ['accesstoken', 'access_token'],
  ['refresh_token', 'refresh_token'], ['refreshtoken', 'refresh_token'],
  ['id_token', 'id_token'], ['idtoken', 'id_token'],
  ['api_key', 'api_key'], ['apikey', 'api_key'], ['openai_api_key', 'api_key'],
])

function firstText(values, max, pattern) {
  return values.find(value => typeof value === 'string' && value.trim().length > 0
    && value.trim().length <= max && pattern.test(value.trim()))?.trim()
}

/** Absolute expiration only; expires_in needs a provider timestamp and is ignored. */
export function oauthExpirySeconds(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  const text = String(value).trim()
  if (!text) return 0
  let number = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : 0
  if (!number && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    number = Date.parse(text) / 1000
  } else if (number >= 10_000_000_000) number /= 1000
  // Keep normalized seconds below the seconds/milliseconds discriminator so
  // repeated normalization cannot reinterpret a distant date as milliseconds.
  return Number.isFinite(number) && number > 0 && number < 10_000_000_000 ? Math.floor(number) : 0
}

function metadata(record, aliases) {
  const out = {}
  const id = firstText([record.chatgpt_account_id, record.chatgptAccountId,
    ...(aliases ? [record.account_id, record.accountId] : [])], 256, /^[^\s\x00-\x1f\x7f]+$/)
  const email = firstText([record.email], 254, /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/)
  const expires = oauthExpirySeconds(record.expires_at ?? record.expiresAt ?? record.expired)
  if (id) out.chatgpt_account_id = id
  if (email) out.email = email
  if (expires) out.expires_at = expires
  return out
}

/**
 * Returns one credential record plus only its transparent wrapper ancestry.
 * Metadata on collection envelopes or unrelated sibling objects is never inherited.
 * These are unverified import hints, not verified provider claims.
 */
export function selectOAuthCredential(input) {
  const seen = new Set()
  let visited = 0
  function walk(value, inherited = {}, records = [], depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null
    if (depth > 64 || ++visited > 10_000) throw Object.assign(new TypeError('OAuth JSON 嵌套或记录数量过多'), {
      status: 400, code: 'invalid_credential_structure',
    })
    seen.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = walk(entry, {}, [], depth + 1)
        if (found) return found
      }
      return null
    }
    const tokens = {}
    for (const [key, raw] of Object.entries(value)) {
      const name = TOKEN_NAMES.get(key.toLowerCase().replace(/-/g, '_'))
      if (name && typeof raw === 'string' && raw.trim()) tokens[name] ||= raw.trim()
    }
    if (tokens.access_token || tokens.refresh_token || tokens.api_key) {
      return { tokens, metadata: { ...inherited, ...metadata(value, true) }, records: [value, ...records] }
    }
    // Collection envelopes cannot donate identity or expiry to their children.
    if (Array.isArray(value.documents)) {
      for (const entry of value.documents) {
        if (!entry || typeof entry !== 'object') continue
        const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : ''
        if (provider && provider !== 'openai' && provider !== 'codex') continue
        const found = walk(entry.document, {}, [], depth + 1)
        if (found) return found
      }
      return null
    }
    if (Array.isArray(value.accounts)) return walk(value.accounts, {}, [], depth + 1)
    for (const [key, child] of Object.entries(value)) {
      const transparent = WRAPPERS.has(key) && child && typeof child === 'object' && !Array.isArray(child)
      // account_id on a management record wrapping credentials is a local id.
      // auth.json's account_id beside tokens is a supported provider id alias.
      const hints = transparent ? { ...inherited, ...metadata(value, key === 'tokens') } : {}
      const found = walk(child, hints, transparent ? [value, ...records] : [], depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(input)
}
