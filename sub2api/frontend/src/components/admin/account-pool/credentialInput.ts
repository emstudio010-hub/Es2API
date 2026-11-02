// Parse locally for useful feedback; raw OAuth data is never written to storage.
export function parseOAuthCredential(text: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('invalidJson') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalidCredential')
  let hasOAuth = false
  let hasApiKey = false
  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return
    for (const [key, nested] of Object.entries(entry)) {
      const normalized = key.toLowerCase().replace(/-/g, '_')
      if (typeof nested === 'string' && nested.trim()) {
        if (['access_token', 'accesstoken', 'refresh_token', 'refreshtoken'].includes(normalized)) hasOAuth = true
        if (['api_key', 'apikey', 'openai_api_key'].includes(normalized)) hasApiKey = true
      } else if (nested && typeof nested === 'object') visit(nested)
    }
  }
  visit(value)
  if (hasApiKey) throw new Error('apiKeyUnsupported')
  if (!hasOAuth) throw new Error('invalidCredential')
  return value as Record<string, unknown>
}
