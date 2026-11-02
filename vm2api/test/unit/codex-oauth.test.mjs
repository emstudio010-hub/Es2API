import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveCodexSurfaceStableId,
  generateCodexAuthUrl,
  parseCodexOAuthCallback,
  resetCodexAuthUrlSessions,
} from '../../src/lib/oauth/codex-oauth.mjs'

test('generateCodexAuthUrl wraps official desktop-auth authorize URL', () => {
  resetCodexAuthUrlSessions()
  const generated = generateCodexAuthUrl({
    vmId: 'vm-codex-01',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    installationId: '11111111-1111-4111-8111-111111111111',
  })
  assert.equal(generated.flavor, 'codex')
  assert.match(generated.auth_url, /^https:\/\/chatgpt\.com\/codex\/desktop-auth\?/)
  const outer = new URL(generated.auth_url)
  const inner = new URL(outer.searchParams.get('authorize_url') || '')
  assert.equal(inner.origin + inner.pathname, 'https://auth.openai.com/oauth/authorize')
  assert.equal(inner.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  assert.equal(inner.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(inner.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(inner.searchParams.get('originator'), 'Codex Desktop')
})

test('parseCodexOAuthCallback reads loopback URL', () => {
  const parsed = parseCodexOAuthCallback('http://localhost:1455/auth/callback?code=abc&state=xyz&foo=1')
  assert.equal(parsed.code, 'abc')
  assert.equal(parsed.state, 'xyz')
})

test('deriveCodexSurfaceStableId is stable UUID', () => {
  const a = deriveCodexSurfaceStableId('11111111-1111-4111-8111-111111111111')
  const b = deriveCodexSurfaceStableId('11111111-1111-4111-8111-111111111111')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
