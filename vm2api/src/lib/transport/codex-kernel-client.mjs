/**
 * Codex kernel hop client. Same Unix-socket + internal token contract as
 * go-worker-client, socket is run/codex-kernel.sock.
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { callGoWorker, streamGoWorker, workerHealth, workerPaths } from './go-worker-client.mjs'
import { codexKernelIdentity, withCodexKernelActivity } from './codex-kernel-activity.mjs'
import { assertCodexCredentialNotHandingOff } from '../oauth/codex-credential-lock.mjs'

export function codexSocketPath(runDir, vmId) {
  const root = String(process.env.KIN_CODEX_SOCKET_DIR || '').trim()
  if (!root) return runDir ? path.join(runDir, 'codex-kernel.sock') : null
  if (!path.isAbsolute(root) || !runDir || !vmId) throw new Error('Codex socket directory and VM identity must be explicit')
  const name = crypto.createHash('sha256').update(`${runDir}\n${vmId}`).digest('hex').slice(0, 20)
  const socket = path.join(root, `${name}.sock`)
  if (Buffer.byteLength(socket) >= 104) throw new Error('Codex socket directory is too long')
  return socket
}

export function codexKernelPaths(exec = {}) {
  const base = workerPaths(exec)
  const runDir = base.runDir
  return {
    runDir,
    socketPath: process.env.KIN_CODEX_SOCKET_DIR
      ? codexSocketPath(runDir, exec.vmId || exec.vm?.id)
      : exec.vm?.runtime?.codex_kernel_socket || codexSocketPath(runDir, exec.vmId || exec.vm?.id),
    tokenPath: base.tokenPath,
    configPath: runDir ? path.join(runDir, 'codex-kernel.json') : null,
    credentialPath: runDir ? path.join(path.dirname(runDir), 'codex-credentials.json') : null,
  }
}

export function withCodexKernelExec(exec) {
  const paths = codexKernelPaths(exec)
  return {
    ...exec,
    vm: {
      ...(exec?.vm || {}),
      runtime: {
        ...(exec?.vm?.runtime || {}),
        worker_socket: paths.socketPath,
        worker_token_file: paths.tokenPath,
        worker_run_dir: paths.runDir,
      },
    },
  }
}

function remapVia(result) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    via: String(result.via || 'go-worker').replace(/go-worker/g, 'codex-kernel'),
  }
}

async function kernelRequest(opts, transport) {
  let startedTransport = false
  try {
    const { projectRoot, vmId } = codexKernelIdentity(opts.exec)
    return await withCodexKernelActivity(projectRoot, vmId, async kernelLease => {
      assertCodexCredentialNotHandingOff(projectRoot, vmId)
      if (opts.signal?.aborted) return { ok: false, status: 499, committed: false, terminalState: 'cancelled' }
      // A host refresh may have drained/stopped the kernel after the caller's
      // preliminary ensure. Start and use it under the same activity lease.
      const { ensureCodexKernel } = await import('./codex-kernel-supervisor.mjs')
      const ready = await ensureCodexKernel(opts.exec, { kernelLease })
      if (!ready.ok) throw Object.assign(new Error('Kernel 尚未就绪'), { status: 503, code: ready.reason })
      if (opts.signal?.aborted) return { ok: false, status: 499, committed: false, terminalState: 'cancelled' }
      startedTransport = true
      return remapVia(await transport({ ...opts, exec: withCodexKernelExec(opts.exec), requestPath: '/internal/v1/codex/responses' }))
    })
  } catch (error) {
    // Preserve transport/callback failures and their commit semantics; only
    // admission/startup errors are known to precede any upstream output.
    if (startedTransport) throw error
    const status = Number(error.status) || 503
    return { ok: false, status, committed: false, terminalState: 'rejected',
      body: { error: { type: 'api_error', code: error.code || 'codex_kernel_unavailable', message: 'Kernel 正在维护或尚未就绪，请稍后重试' } } }
  }
}

export function callCodexKernel(opts = {}) {
  return kernelRequest(opts, callGoWorker)
}

export function streamCodexKernel(opts = {}) {
  return kernelRequest(opts, streamGoWorker)
}

export async function codexKernelHealth(exec, opts = {}) {
  const health = await workerHealth(withCodexKernelExec(exec), opts)
  if (health?.source) {
    return { ...health, source: String(health.source).replace(/go-worker/g, 'codex-kernel') }
  }
  return health
}
