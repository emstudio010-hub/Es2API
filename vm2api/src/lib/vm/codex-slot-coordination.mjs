import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isValidVmId } from './vm-file.mjs'

const controls = new AsyncLocalStorage()
const busy = () => Object.assign(new Error('实例正在维护或有请求尚未释放，请稍后重试'), {
  status: 409, code: 'codex_slot_coordination_busy',
})
const unavailable = () => Object.assign(new Error('实例共享锁不可用，已拒绝操作'), {
  status: 503, code: 'codex_slot_coordination_unavailable',
})

function identity(projectRoot, vmId) {
  if (process.platform !== 'linux' || !projectRoot || !isValidVmId(vmId)) throw unavailable()
  const root = fs.realpathSync(projectRoot)
  return { root, key: `${root}\n${vmId}` }
}

// flock(2) belongs to the open file description, shared by the descriptor
// inherited as fd 3 in this short-lived child. The parent keeps that SAME open
// description until release; there is no holder daemon, PID lease or stale-lock
// expiry. Never unlink these files (including during home/container cleanup).
function acquire(root, vmId, resource, shared = false) {
  if (!['control', 'kernel', 'cli'].includes(resource)) throw unavailable()
  const directory = path.join(root, '.codex-coordination')
  try { fs.mkdirSync(directory, { mode: 0o700 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return openLock(directory, vmId, resource, shared)
}

function openLock(directory, vmId, resource, shared) {
  const parent = fs.lstatSync(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw unavailable()
  const filename = path.join(directory, `${vmId}.${resource}.lock`)
  const descriptor = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
  try {
    const info = fs.fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1) throw unavailable()
    const result = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '73', shared ? '--shared' : '--exclusive', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor], windowsHide: true, timeout: 5000,
    })
    if (result.status === 73) throw busy()
    if (result.error || result.status !== 0) throw unavailable()
    const current = fs.lstatSync(filename)
    if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw unavailable()
    let released = false
    return () => { if (!released) { released = true; fs.closeSync(descriptor) } }
  } catch (error) { fs.closeSync(descriptor); throw error }
}

function lock(root, vmId, resource, shared) {
  try { return acquire(root, vmId, resource, shared) }
  catch (error) {
    if (error.code === 'codex_slot_coordination_busy') throw error
    throw unavailable()
  }
}

export async function withCodexSlotControl(projectRoot, vmId, operation) {
  const { root, key } = identity(projectRoot, vmId)
  const inherited = controls.getStore()
  if (inherited?.get(key)?.active) return operation()
  const release = lock(root, vmId, 'control', false)
  const scope = { active: true }
  const next = new Map(inherited || [])
  next.set(key, scope)
  try { return await controls.run(next, operation) }
  finally { scope.active = false; release() }
}

// Take the activity lock while holding shared admission. A writer first takes
// exclusive control, preventing new requests before it stops/drains readers.
export async function withCodexSlotActivity(projectRoot, vmId, resource, operation) {
  const { root, key } = identity(projectRoot, vmId)
  const admission = controls.getStore()?.get(key)?.active ? () => {} : lock(root, vmId, 'control', true)
  let release
  try { release = lock(root, vmId, resource, true) }
  finally { admission() }
  try { return await operation() }
  finally { release() }
}

// Caller owns control across beforeDrain, drain and the protected mutation.
// An explicit stop can halt first; credential refresh only waits, never kills
// readers to gain ownership. Failure releases admission, not request claims.
export async function withCodexSlotDrain(projectRoot, vmId, resource, operation, { timeoutMs = 15000, beforeDrain } = {}) {
  return withCodexSlotControl(projectRoot, vmId, async () => {
    const { root } = identity(projectRoot, vmId)
    if (beforeDrain) await beforeDrain()
    const until = Date.now() + Math.max(1, Math.min(15000, Number(timeoutMs) || 15000))
    let release
    while (!release) {
      try { release = lock(root, vmId, resource, false) }
      catch (error) {
        if (error.code !== 'codex_slot_coordination_busy' || Date.now() >= until) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    try { return await operation() }
    finally { release() }
  })
}
