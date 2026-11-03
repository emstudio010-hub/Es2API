import fs from 'node:fs'
import path from 'node:path'

export const codexCliClaimPath = root => path.join(root, 'request-lock.json')

export function hasCodexCliClaim(root) {
  try { fs.lstatSync(codexCliClaimPath(root)); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

// Never infer a stale claim from an owner PID. A crashed host can leave a live
// container process. Only its owner or explicit stopped-container recovery may
// remove the claim, and a matching request nonce is required for owner release.
export function claimCodexCliRequest(root, requestId, nonce) {
  const info = fs.lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('CLI request root unavailable'), { code: 'codex_cli_state_unreadable' })
  const target = codexCliClaimPath(root)
  let descriptor
  try { descriptor = fs.openSync(target, 'wx', 0o600) }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('CLI execution ownership is not released'), { code: 'codex_cli_previous_run_unconfirmed' })
    throw error
  }
  const content = Buffer.from(JSON.stringify({ format: 'es2api-cli-claim-v1', request_id: requestId, nonce }))
  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
  let released = false
  return () => {
    if (released) return
    const current = fs.lstatSync(target)
    if (!current.isFile() || current.isSymbolicLink() || current.size !== content.length || !fs.readFileSync(target).equals(content)) {
      throw Object.assign(new Error('CLI request ownership changed'), { code: 'codex_cli_claim_changed' })
    }
    fs.unlinkSync(target)
    released = true
  }
}
