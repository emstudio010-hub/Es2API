// Only the pinned npm platform binary is extracted. No package scripts run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { codexCliRoot, CODEX_CLI_VERSION, inspectCodexCliPayload } from '../src/lib/vm/codex-cli-config.mjs'

const existing = inspectCodexCliPayload()
if (existing.ok) { await installSandboxSource(existing.root); console.log(JSON.stringify({ installed: true, version: existing.version, sha256: existing.sha256 })); process.exit(0) }

async function installSandboxSource(root) {
  for (const dir of [root, path.join(root, 'bin'), path.join(root, 'codex-resources')]) fs.chmodSync(dir, 0o755)
  for (const file of ['LICENSE', 'manifest.json']) fs.chmodSync(path.join(root, file), 0o644)
  const index = JSON.parse(fs.readFileSync(new URL('./codex-bwrap-source.json', import.meta.url), 'utf8'))
  if (index.commit !== 'be2951ea34f0d295ed0becf97079f92fa5f6950e') throw new Error('Unexpected source commit')
  const todo = [...index.files]
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const entry = todo.pop()
      if (!entry) return
      if (!entry.path || entry.path.split('/').some(part => part === '..' || part === '') || path.isAbsolute(entry.path) || entry.path.includes('\\')) throw new Error('Unsafe source path')
      const target = path.join(root, 'source', 'bubblewrap', entry.path)
      const hash = b => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
      if (fs.existsSync(target) && hash(fs.readFileSync(target)) === entry.sha) continue
      const response = await fetch(`https://raw.githubusercontent.com/openai/codex/${index.commit}/codex-rs/vendor/bubblewrap/${entry.path}`, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`Sandbox source HTTP ${response.status}`)
      const content = Buffer.from(await response.arrayBuffer())
      if (content.length !== entry.bytes || hash(content) !== entry.sha) throw new Error('Sandbox source hash mismatch')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
  }))
  fs.copyFileSync(path.join(root, 'source', 'bubblewrap', 'COPYING'), path.join(root, 'COPYING-bubblewrap'))
  fs.writeFileSync(path.join(root, 'SOURCE.json'), `${JSON.stringify(index, null, 2)}\n`)
}

const integrity = 'atv3HF0mubqB0J/XkQ2JopqKzXJ+/7aQtTB2MkJ9MrraujMIz8zbCCLylLkN3PzpVGTJzzQFN/wD1oq8oJPJKg=='
const source = `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_CLI_VERSION}-linux-x64.tgz`
const root = codexCliRoot()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es2api-codex-'))
try {
  const cached = path.join(root, 'download.tgz')
  const file = path.join(tmp, 'codex.tgz')
  if (fs.existsSync(cached)) fs.copyFileSync(cached, file)
  else {
  const response = await fetch(source, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error(`Download HTTP ${response.status}`)
  const fd = fs.openSync(file, 'wx', 0o600)
  let bytes = 0
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 250 * 1024 * 1024) throw new Error('Archive exceeds size limit')
      fs.writeSync(fd, chunk)
    }
  } finally { fs.closeSync(fd) }
  }
  if (crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64') !== integrity) throw new Error('npm SHA512 integrity mismatch')
  const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)
  const bin = 'package/vendor/x86_64-unknown-linux-musl/bin/codex'
  const bwrap = 'package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap'
  if (!entries.includes(bin) || !entries.includes(bwrap)) throw new Error('Unexpected binary layout')
  const licenseResponse = await fetch(`https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_CLI_VERSION}/LICENSE`, { signal: AbortSignal.timeout(30000) })
  if (!licenseResponse.ok) throw new Error(`License HTTP ${licenseResponse.status}`)
  const license = Buffer.from(await licenseResponse.arrayBuffer())
  if (crypto.createHash('sha256').update(license).digest('hex') !== 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc') throw new Error('License hash mismatch')
  const content = execFileSync('tar', ['-xOzf', file, bin], { maxBuffer: 450 * 1024 * 1024, windowsHide: true })
  if (content.subarray(0, 4).toString('hex') !== '7f454c46' || content[4] !== 2 || content.readUInt16LE(18) !== 62) throw new Error('Expected Linux x64 ELF')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  const next = path.join(root, 'bin', 'codex.next')
  fs.writeFileSync(next, content, { mode: 0o755 }); fs.chmodSync(next, 0o755)
  fs.renameSync(next, path.join(root, 'bin', 'codex'))
  fs.writeFileSync(path.join(root, 'LICENSE'), license)
  const sandbox = execFileSync('tar', ['-xOzf', file, bwrap], { maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  fs.mkdirSync(path.join(root, 'codex-resources'), { recursive: true })
  fs.writeFileSync(path.join(root, 'codex-resources', 'bwrap'), sandbox, { mode: 0o755 })
  fs.chmodSync(path.join(root, 'codex-resources', 'bwrap'), 0o755)
  const manifest = { version: CODEX_CLI_VERSION, platform: 'linux-x64', source, integrity: `sha512-${integrity}`, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), bwrap_sha256: crypto.createHash('sha256').update(sandbox).digest('hex') }
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await installSandboxSource(root)
  console.log(JSON.stringify(manifest))
  fs.rmSync(cached, { force: true })
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }
