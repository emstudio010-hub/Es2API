import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const CODEX_CLI_VERSION = '0.155.1'
export const CODEX_CLI_CONTAINER_BIN = '/opt/es2api-codex/bin/codex'
export const isCodexCliVm = vm => vm?.execution_backend === 'codex-cli'
export function codexCliRoot() {
  return path.resolve(process.env.ES2API_CODEX_CLI_ROOT || fileURLToPath(new URL('../../../share/codex-cli/linux-x64', import.meta.url)))
}
export function inspectCodexCliPayload() {
  try {
    const root = codexCliRoot()
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    const bin = path.join(root, 'bin', 'codex')
    const stat = fs.statSync(bin)
    if (manifest.version !== CODEX_CLI_VERSION || stat.size !== manifest.bytes || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('invalid manifest')
    const cached = inspected.get(bin)
    if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size || cached.sha256 !== manifest.sha256) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex')
      if (hash !== manifest.sha256) throw new Error('payload mismatch')
      inspected.set(bin, { mtime: stat.mtimeMs, size: stat.size, sha256: hash })
    }
    const sandbox = path.join(root, 'codex-resources', 'bwrap')
    const sandboxStat = fs.statSync(sandbox)
    const sandboxCached = inspected.get(sandbox)
    if (!sandboxCached || sandboxCached.mtime !== sandboxStat.mtimeMs || sandboxCached.size !== sandboxStat.size || sandboxCached.sha256 !== manifest.bwrap_sha256) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(sandbox)).digest('hex')
      if (hash !== manifest.bwrap_sha256) throw new Error('sandbox payload mismatch')
      inspected.set(sandbox, { mtime: sandboxStat.mtimeMs, size: sandboxStat.size, sha256: hash })
    }
    return { ok: true, root, bin, version: CODEX_CLI_VERSION, sha256: manifest.sha256 }
  } catch {
    return { ok: false, code: 'codex_cli_payload_missing', error: '请先安装固定版本 Codex CLI payload：node vm2api/scripts/install-codex-cli.mjs' }
  }
}
const inspected = new Map()
