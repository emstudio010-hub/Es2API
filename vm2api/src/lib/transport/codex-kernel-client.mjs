/**
 * Codex kernel hop client. Same Unix-socket + internal token contract as
 * go-worker-client, socket is run/codex-kernel.sock.
 */
import path from 'node:path'
import crypto from 'node:crypto'
import { callGoWorker, streamGoWorker, workerHealth, workerPaths } from './go-worker-client.mjs'

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

export async function callCodexKernel(opts = {}) {
  return remapVia(
    await callGoWorker({
      ...opts,
      exec: withCodexKernelExec(opts.exec),
      requestPath: '/internal/v1/codex/responses',
    }),
  )
}

export async function streamCodexKernel(opts = {}) {
  return remapVia(
    await streamGoWorker({
      ...opts,
      exec: withCodexKernelExec(opts.exec),
      requestPath: '/internal/v1/codex/responses',
    }),
  )
}

export async function codexKernelHealth(exec, opts = {}) {
  const health = await workerHealth(withCodexKernelExec(exec), opts)
  if (health?.source) {
    return { ...health, source: String(health.source).replace(/go-worker/g, 'codex-kernel') }
  }
  return health
}
