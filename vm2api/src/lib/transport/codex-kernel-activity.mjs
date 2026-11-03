import path from 'node:path'
import { isValidVmId } from '../vm/vm-file.mjs'

// Shared by the host transport and credential writer. Readers remain concurrent;
// a pending writer blocks new readers and drains the existing socket requests.
const slots = new Map()
const busy = () => Object.assign(new Error('Kernel 凭据维护中，请稍后重试'), {
  status: 409, code: 'codex_kernel_credential_busy',
})
function entry(projectRoot, vmId) {
  if (!projectRoot || !isValidVmId(vmId)) throw new Error('Kernel slot identity required')
  const key = `${path.resolve(projectRoot)}\n${vmId}`
  let state = slots.get(key)
  if (!state) { state = { readers: new Set(), paused: false, drained: null }; slots.set(key, state) }
  return { key, state }
}
function cleanup(key, state) {
  if (!state.paused && !state.readers.size) slots.delete(key)
}
export function codexKernelIdentity(exec) {
  const vmId = exec?.vmId || exec?.vm?.id
  const projectRoot = exec?.homeDir
    ? path.dirname(path.dirname(path.dirname(exec.homeDir)))
    : exec?.vm?.runtime?.worker_run_dir ? path.dirname(path.dirname(path.dirname(exec.vm.runtime.worker_run_dir))) : null
  if (!projectRoot || !isValidVmId(vmId)) throw new Error('Kernel slot home and identity required')
  return { projectRoot, vmId }
}
export function hasCodexKernelLease(projectRoot, vmId, lease) {
  const { key, state } = entry(projectRoot, vmId)
  const valid = state.readers.has(lease)
  cleanup(key, state)
  return valid
}
export async function withCodexKernelActivity(projectRoot, vmId, operation) {
  const { key, state } = entry(projectRoot, vmId)
  if (state.paused) throw busy()
  const lease = Object.freeze({})
  state.readers.add(lease)
  try { return await operation(lease) }
  finally {
    state.readers.delete(lease)
    if (!state.readers.size) state.drained?.()
    cleanup(key, state)
  }
}
export async function withCodexKernelPause(projectRoot, vmId, operation, { timeoutMs = 15000 } = {}) {
  const { key, state } = entry(projectRoot, vmId)
  if (state.paused) throw busy()
  state.paused = true
  let timer
  try {
    if (state.readers.size) await new Promise((resolve, reject) => {
      state.drained = resolve
      timer = setTimeout(() => reject(busy()), Math.max(1, Math.min(15000, Number(timeoutMs) || 15000)))
    })
    clearTimeout(timer)
    return await operation()
  } finally {
    clearTimeout(timer)
    state.drained = null
    state.paused = false
    cleanup(key, state)
  }
}
