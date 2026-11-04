/**
 * Host-side Codex kernel lifecycle. Dedicated Codex VMs listen on
 * vms/<id>/run/codex-kernel.sock; Claude workers are never reused.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundProxyUrl, isLocalEgressProxy, localEgressProxyUrl } from '../vm/egress.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { assertProxyAllowed } from '../vm/proxy-policy.mjs'
import { maxRequestBytes } from '../core/config.mjs'
import { codexKernelHealth, codexKernelPaths, codexSocketPath } from './codex-kernel-client.mjs'
import { computedUpstreamTransport, normalizeCodexRouting } from '../protocol/codex-route.mjs'
import { assertCodexCredentialNotHandingOff } from '../oauth/codex-credential-lock.mjs'
import { codexKernelIdentity, hasCodexKernelLease, withCodexKernelActivity, withCodexKernelPause } from './codex-kernel-activity.mjs'
import { withCodexKernelBootstrap, withCodexKernelConfigWrite, claimCodexKernelOwner, codexKernelOwnerLockPath } from '../vm/codex-slot-coordination.mjs'
import { codexKernelProcessRecords } from './codex-kernel-stop.mjs'

const starts = new Map()
const failedSpawns = new WeakSet()

function trackedKey(projectRoot, vmId) {
  return `${fs.realpathSync(projectRoot)}\n${vmId}`
}

// The kernel exits only through config.proxy_url; inherited proxy variables would give it a second, unseen exit.
function kernelEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)))
}

function existingBin(candidate) {
  const bin = String(candidate || '').trim()
  if (!bin) return ''
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return ''
  }
}

export function codexKernelBinPath() {
  const env = existingBin(process.env.KIN_CODEX_KERNEL_BIN)
  if (env) return env
  const kernel = String(process.env.KIN_KERNEL_BIN || process.env.KIN_API_KERNEL_BIN || '').trim()
  if (kernel) {
    const sibling = existingBin(path.join(path.dirname(kernel), 'kin-codex-kernel'))
    if (sibling) return sibling
  }
  return existingBin(path.resolve('bin/kin-codex-kernel'))
}

export function codexKernelOwnerBinPath() {
  return existingBin(process.env.KIN_API_KERNEL_BIN)
    || existingBin(path.join(path.dirname(codexKernelBinPath()), 'kin-api-kernel'))
}

/** Per-hop policy keeps settings live without interrupting another request's kernel. */
export function codexKernelRequestOptions(routing = {}) {
  const codex = normalizeCodexRouting(routing.codex)
  return {
    upstream_transport: computedUpstreamTransport(routing),
    user_agent: codex.user_agent,
    client_features: codex.client_features.enabled === true,
    analytics: codex.analytics.enabled === true,
  }
}

export function writeCodexKernelConfig(projectRoot, vm, options = {}) {
  if (!projectRoot || !vm?.id) return null
  return withCodexKernelConfigWrite(projectRoot, vm.id, () => writeConfig(projectRoot, vm, options))
}

// Rename only complete, fsynced files. A crash must never leave a truncated
// token/config that a detached kernel or a later controller can consume.
function atomicPrivateWrite(filename, contents) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, contents)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temporary, filename)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function writeConfig(projectRoot, vm, { token, proxyUrl, proxyRequired, routing } = {}) {
  projectRoot = fs.realpathSync(projectRoot)
  assertCodexCredentialNotHandingOff(projectRoot, vm.id)
  assertProxyAllowed(vm.proxy)
  if (proxyUrl) assertProxyAllowed({ url: proxyUrl })
  const runDir = path.join(projectRoot, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const socketPath = codexSocketPath(runDir, vm.id)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  const configPath = path.join(runDir, 'codex-kernel.json')
  const tokenPath = path.join(runDir, 'internal.token')
  const credentialPath = path.join(projectRoot, 'vms', vm.id, 'codex-credentials.json')
  let secret = String(token || '').trim()
  if (!secret) {
    try {
      secret = fs.readFileSync(tokenPath, 'utf8').trim()
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!secret) secret = crypto.randomBytes(24).toString('hex')
  atomicPrivateWrite(tokenPath, secret + '\n')
  const local = isLocalEgressProxy(vm?.proxy)
  // Only a slot on this host treats local egress as the deployment proxy.
  // A node slot is handed that node's forwarder; replacing it would exit from here.
  const hostLocal = local && !vmNodeId(vm)
  const proxy = hostLocal ? localEgressProxyUrl() : String(proxyUrl || boundProxyUrl(vm?.proxy) || '').trim()
  // A configured deployment proxy is this slot's exit: fail closed instead of going direct.
  const required = hostLocal ? !!proxy : proxyRequired == null ? !!proxy : !!proxyRequired
  const installationPath = path.join(runDir, 'codex-installation-id')
  let deviceId = ''
  try {
    deviceId = fs.readFileSync(installationPath, 'utf8').trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Official installation identity is a random UUID, never a VM or hardware fingerprint.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    deviceId = crypto.randomUUID()
    atomicPrivateWrite(installationPath, `${deviceId}\n`)
  }
  const config = {
    vm_id: vm.id,
    device_id: deviceId,
    socket_path: socketPath,
    credential_path: credentialPath,
    proxy_url: proxy,
    proxy_required: required,
    internal_token: secret,
    max_request_bytes: maxRequestBytes(routing),
    ...codexKernelRequestOptions(routing),
    test_endpoints: process.env.KIN_CODEX_TEST_ENDPOINTS === '1',
  }
  atomicPrivateWrite(configPath, JSON.stringify(config, null, 2) + '\n')
  return { runDir, socketPath, configPath, credentialPath, tokenPath, installationId: deviceId }
}

export function shouldRecycleCodexKernel({ wanted, stamped, inFlight } = {}) {
  // Legacy predicate retained for callers; it is NOT authority to stop a
  // process. The supervisor below requires an exclusive global drain instead.
  return wanted > 0 && stamped > 0 && wanted !== stamped && inFlight <= 1
}

function limitStampPath(configPath) {
  return configPath ? path.join(path.dirname(configPath), 'codex-kernel.limit') : ''
}

function readLimitStamp(configPath) {
  try {
    return Number(fs.readFileSync(limitStampPath(configPath), 'utf8')) || 0
  } catch {
    return 0
  }
}

function writeLimitStamp(configPath, bytes) {
  if (!configPath || !(bytes > 0)) return
  atomicPrivateWrite(limitStampPath(configPath), `${bytes}\n`)
}

function configRequestBytes(configPath) {
  try {
    return Number(JSON.parse(fs.readFileSync(configPath, 'utf8')).max_request_bytes) || 0
  } catch {
    return 0
  }
}

function childHasExited(child) {
  return !child || failedSpawns.has(child) || child.exitCode != null || child.signalCode != null
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true)
  if (!(timeoutMs > 0)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs)
    child.once('exit', () => finish(true))
  })
}

/** SIGTERM, then SIGKILL. Unlink the socket only after the process is actually gone. */
export async function finishCodexRecycle(child, socketPath, { termMs = 2000, killMs = 1000 } = {}) {
  if (!childHasExited(child)) {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  let exited = await waitForChildExit(child, termMs)
  if (!exited && killMs > 0) {
    try {
      child.kill('SIGKILL')
    } catch {}
    exited = await waitForChildExit(child, killMs)
  }
  if (!exited) return { exited: false }
  if (socketPath) {
    try {
      fs.unlinkSync(socketPath)
    } catch {}
  }
  return { exited: true }
}

export async function ensureCodexKernel(exec, { timeoutMs = 8000, kernelLease } = {}) {
  try {
    const { projectRoot, vmId } = codexKernelIdentity(exec)
    const ensure = (stopped = false) => withCodexKernelBootstrap(projectRoot, vmId,
      () => ensureCodexKernelActive(exec, { timeoutMs, stopped }))
    if (kernelLease && hasCodexKernelLease(projectRoot, vmId, kernelLease)) return await ensure()
    const ready = await withCodexKernelActivity(projectRoot, vmId, () => ensure())
    if (ready.reason !== 'kernel_recycle_required') return ready
    // Release our OWN shared activity before draining. Upgrading it while
    // waiting for other controllers would deadlock or interrupt their requests.
    return await withCodexKernelPause(projectRoot, vmId, async () => {
      const { stopConfiguredCodexKernel } = await import('../oauth/codex-kernel-credential-owner.mjs')
      await stopConfiguredCodexKernel(projectRoot, vmId)
      return ensure(true)
    })
  } catch (error) {
    return { ok: false, reason: error.code || 'kernel_identity_unavailable' }
  }
}

async function ensureCodexKernelActive(exec, { timeoutMs, stopped = false }) {
  const binPath = codexKernelBinPath()
  const bin = binPath ? fs.realpathSync(binPath) : ''
  if (!bin) return { ok: false, reason: 'bin_missing' }
  const ownerPath = codexKernelOwnerBinPath()
  const ownerBin = ownerPath ? fs.realpathSync(ownerPath) : ''
  if (!ownerBin) return { ok: false, reason: 'kernel_owner_bin_missing' }
  const paths = codexKernelPaths(exec)
  if (!paths.configPath) return { ok: false, reason: 'config_missing' }
  paths.configPath = fs.realpathSync(paths.configPath)
  const projectRoot = exec.homeDir ? path.dirname(path.dirname(path.dirname(exec.homeDir)))
    : path.dirname(path.dirname(path.dirname(path.dirname(paths.configPath))))
  try { assertCodexCredentialNotHandingOff(projectRoot, exec.vmId || exec.vm?.id) }
  catch { return { ok: false, reason: 'credential_handoff_or_record_unavailable' } }
  const key = trackedKey(projectRoot, exec.vmId || exec.vm?.id)
  const wanted = configRequestBytes(paths.configPath)
  const stamped = readLimitStamp(paths.configPath)
  if (!(wanted > 0)) return { ok: false, reason: 'kernel_config_invalid' }
  if (!stopped && wanted !== stamped) return { ok: false, reason: 'kernel_recycle_required' }
  const live = await waitForHealth(exec, Math.min(800, Math.max(200, Number(timeoutMs) || 800)))
  if (live.ok) return { ok: true, reused: true, health: live.health }
  const current = starts.get(key)
  if (!childHasExited(current)) return current.killed
    ? { ok: false, reason: 'kernel_exit_pending' } : waitForHealth(exec, timeoutMs, current)
  // An unhealthy socket is not proof that another controller's detached
  // kernel exited. Keep its socket in place and require a coordinated stop.
  try {
    if (codexKernelProcessRecords(projectRoot, exec.vmId || exec.vm?.id, bin, ownerBin).length) return { ok: false, reason: 'kernel_process_unhealthy' }
  } catch { return { ok: false, reason: 'kernel_process_identity_unavailable' } }
  // Transfer the SAME flock via fd3; it remains owned even if Node dies in the
  // child's pre-main/exec interval. Only its native owner/child release it.
  const owner = claimCodexKernelOwner(projectRoot, exec.vmId || exec.vm?.id)
  try {
    try {
      if (paths.socketPath) fs.unlinkSync(paths.socketPath)
    } catch {}
    try { assertCodexCredentialNotHandingOff(projectRoot, exec.vmId || exec.vm?.id) }
    catch { return { ok: false, reason: 'credential_handoff_or_record_unavailable' } }
    const child = spawn(ownerBin, ['codex-owner', bin, paths.configPath,
      codexKernelOwnerLockPath(projectRoot, exec.vmId || exec.vm?.id)], {
      env: kernelEnv(),
      stdio: ['ignore', 'ignore', 'pipe', owner.descriptor],
      detached: true,
    })
    // Classify a bounded transient buffer; never persist raw kernel output.
    let diagnostic = ''
    let reported = ''
    child.on('error', () => {
      // ChildProcess may also emit error for a failed signal. Only a failed
      // spawn (no PID) proves absence; keep tracking any existing process.
      if (child.pid) return
      failedSpawns.add(child)
      diagnostic = ''
      if (starts.get(key) === child) starts.delete(key)
    })
    child.stderr?.on('data', chunk => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8192)
      const kind = /SOCKS.*(auth|credential)|authentication failed/i.test(diagnostic) ? 'proxy_auth'
        : /SOCKS|proxy connect|proxy handshake/i.test(diagnostic) ? 'proxy_connect'
          : /TLS|certificate|handshake/i.test(diagnostic) ? 'tls_handshake'
            : /connection reset|ECONNRESET|broken pipe/i.test(diagnostic) ? 'connection_reset'
              : /timeout|timed out|ETIMEDOUT/i.test(diagnostic) ? 'transport_timeout'
                : /connection refused|ECONNREFUSED/i.test(diagnostic) ? 'connection_refused' : ''
      if (kind && kind !== reported) {
        reported = kind
        console.warn(JSON.stringify({ event: 'codex_kernel_transport', vm_id: exec.vmId, category: kind, at: new Date().toISOString() }))
      }
    })
    child.once('exit', (code, signal) => {
      diagnostic = ''
      if (starts.get(key) === child) starts.delete(key)
      console.warn(JSON.stringify({ event: 'codex_kernel_exit', vm_id: exec.vmId, code, signal, at: new Date().toISOString() }))
    })
    child.unref()
    starts.set(key, child)
    // Wait for exec confirmation before stamping or accepting health. Failed
    // spawn emits error rather than exit and must never crash the controller.
    const spawned = await new Promise(resolve => {
      child.once('spawn', () => resolve(true))
      child.once('error', () => resolve(false))
    })
    if (!spawned) return { ok: false, reason: 'kernel_spawn_failed' }
    writeLimitStamp(paths.configPath, wanted)
    return waitForHealth(exec, timeoutMs, child)
  } finally { owner.release() }
}

async function waitForHealth(exec, timeoutMs, child) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    if (child && childHasExited(child)) return { ok: false, reason: failedSpawns.has(child) ? 'kernel_spawn_failed' : 'kernel_exited_before_ready' }
    last = await codexKernelHealth(exec, { timeoutMs: 500 }).catch((error) => ({
      ok: false,
      reason: 'health_error',
      error: String(error.message || error),
    }))
    if (last?.ok || Number(last?.status) === 200) return { ok: true, health: last }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { ok: false, reason: 'health_timeout', health: last }
}

export function stopCodexKernel(vmId, projectRoot) {
  if (!projectRoot) return null
  const child = starts.get(trackedKey(projectRoot, vmId))
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {}
    // Keep ownership until exit/error is observed, including spawn/exec time.
  }
  return child || null
}

/** A child this process spawned for the VM that has not exited (it may still be starting or hung). */
export function codexKernelTracked(vmId, projectRoot) {
  return !!projectRoot && !childHasExited(starts.get(trackedKey(projectRoot, vmId)))
}

/** Conservative diagnostic: absent socket/local child alone never means idle. */
export function codexKernelMayBeRunning(vmId, projectRoot) {
  try {
    if (codexKernelTracked(vmId, projectRoot)) return true
    if (codexKernelProcessRecords(projectRoot, vmId, codexKernelBinPath(), codexKernelOwnerBinPath()).length) return true
    const owner = claimCodexKernelOwner(projectRoot, vmId)
    owner.release()
    return false
  } catch { return true }
}

export function stopAllCodexKernels() {
  for (const child of starts.values()) {
    try { child.kill('SIGTERM') } catch {}
  }
}
