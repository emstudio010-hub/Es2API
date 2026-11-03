import fs from 'node:fs'
import path from 'node:path'
import { withCodexKernelPause } from '../transport/codex-kernel-activity.mjs'
import { stopCodexKernelForCheckpoint } from '../transport/codex-kernel-stop.mjs'

// Caller holds the per-slot credential lock. The external kernel cannot join a
// Node mutex, so drain its requests and confirm process exit before exchanging
// a rotating refresh token. No request is killed to make a refresh proceed.
export function withCodexKernelCredentialOwner(projectRoot, vmId, operation, options = {}) {
  return withCodexKernelPause(projectRoot, vmId, async () => {
    const config = path.join(projectRoot, 'vms', vmId, 'run', 'codex-kernel.json')
    let configured = false
    try {
      if (!fs.statSync(config).isFile()) throw new Error('Kernel config is not a regular file')
      configured = true
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (configured) {
      const { codexKernelBinPath } = await import('../transport/codex-kernel-supervisor.mjs')
      const stopped = await stopCodexKernelForCheckpoint(projectRoot, vmId, codexKernelBinPath())
      if (!stopped.ok) throw Object.assign(new Error('Kernel 退出未确认，未开始凭据刷新或覆盖'), {
        status: 409, code: 'codex_kernel_refresh_stop_unconfirmed',
      })
    }
    return operation()
  }, options)
}
