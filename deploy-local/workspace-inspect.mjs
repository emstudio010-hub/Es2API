// Read-only deployment inventory. Never imports credentials or sends inference.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Vm2Client } from '../integration/src/vm2-client.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const secret = JSON.parse(fs.readFileSync(path.join(root, 'runtime/local-secrets.json'), 'utf8'))
async function read(resource) {
  const response = await fetch(`http://127.0.0.1:18084/api/v1/admin/${resource}`, { headers: { authorization: `Bearer ${secret.integration.managementToken}` }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Inventory unavailable (${response.status})`)
  return (await response.json()).data
}
const accounts = []
for (let page = 1; ; page++) {
  const result = await read(`accounts?page=${page}&page_size=200`)
  accounts.push(...result.items)
  if (page >= result.pages || !result.items.length) break
}
const summary = await read('modeltrace/summary')
const vm2 = new Vm2Client({ baseUrl: 'http://127.0.0.1:18787', username: secret.vm2.adminUser, password: secret.vm2.adminPassword })
const exits = await vm2.listExitResources()
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const output = {
  at: new Date().toISOString(), accounts: accounts.length,
  identity_digest: digest(accounts.sort((a, b) => a.id.localeCompare(b.id)).map(a => [a.id, a.vm_id, a.binding.proxy_id || a.slot?.egress?.proxy_id, a.credential.fingerprint, a.provision_generation])),
  settings_digest: digest(accounts.map(a => [a.id, a.group_ids, a.concurrency, a.priority, a.modeltrace.overrides])),
  ready: accounts.filter(a => a.status === 'ready').length,
  inflight: accounts.reduce((n, a) => n + a.dispatch.inflight_requests, 0),
  active_runs: summary.active_runs,
  proxy_resources: exits.length, free_proxy_resources: exits.filter(row => row.available).length,
}
const phase = process.argv[2]
if (!['before', 'after'].includes(phase)) throw new Error('Specify before or after')
if (phase === 'after') {
  const before = JSON.parse(fs.readFileSync(path.join(root, 'runtime/verification/workspaces-before.json'), 'utf8'))
  output.identity_unchanged = output.identity_digest === before.identity_digest
  output.settings_unchanged = output.settings_digest === before.settings_digest
  const resources = await read('exit-resources')
  output.exit_api_readable = Array.isArray(resources)
  const assets = path.join(root, 'sub2api/backend/internal/web/dist/assets')
  const filename = fs.readdirSync(assets).find(name => /^AccountPoolView-.*\.js$/.test(name))
  if (!filename) throw new Error('Built workspace asset missing')
  const response = await fetch(`http://127.0.0.1:18083/assets/${filename}`, { signal: AbortSignal.timeout(15000) })
  const served = Buffer.from(await response.arrayBuffer())
  const sha = value => crypto.createHash('sha256').update(value).digest('hex')
  output.workspace_asset = { filename, status: response.status, sha256: sha(served), matches_build: sha(served) === sha(fs.readFileSync(path.join(assets, filename))) }
}
fs.writeFileSync(path.join(root, `runtime/verification/workspaces-${phase}.json`), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(output))
