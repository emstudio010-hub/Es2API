import fs from 'node:fs'
import path from 'node:path'
import { codexKernelOwnerLockPath, withCodexKernelBootstrap, claimCodexKernelOwner } from '../vm/codex-slot-coordination.mjs'

// A detached kernel can survive a Node restart. Match executable, exact config
// argv, uid and /proc start ticks before signalling; a socket is not exit proof.
export function codexKernelProcessRecords(projectRoot, vmId, binary, ownerBinary) {
  return kernelScope(projectRoot, vmId, binary, ownerBinary).owned()
}

function kernelScope(projectRoot, vmId, binary, ownerBinary) {
  if (process.platform !== 'linux' || !binary) throw new Error('Kernel process scope unavailable')
  const config = path.join(fs.realpathSync(projectRoot), 'vms', vmId, 'run', 'codex-kernel.json')
  const executable = fs.realpathSync(binary)
  const owner = ownerBinary ? fs.realpathSync(ownerBinary) : null
  const lockPath = codexKernelOwnerLockPath(projectRoot, vmId)
  function matches(current) {
    const kernel = current.executable === executable && current.argv.length === 2 && current.argv[1] === config
    const helper = current.executable === owner && current.argv.length === 5
      && current.argv[1] === 'codex-owner' && current.argv[2] === executable
      && current.argv[3] === config && current.argv[4] === lockPath
    return current.uid === process.getuid() && (kernel || helper)
  }
  function identity(pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return { ticks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
        uid: fs.statSync(`/proc/${pid}`).uid,
        executable: fs.readlinkSync(`/proc/${pid}/exe`),
        argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) }
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return null
      throw error
    }
  }
  function owned() {
    const found = []
    for (const pidText of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pidText)) continue
      // Read cmdline first: permissions on unrelated processes do not grant us
      // authority to signal them. Only an exact config argv is considered.
      let argv
      try { argv = fs.readFileSync(`/proc/${pidText}/cmdline`, 'utf8').split('\0') }
      catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) continue
        if (error.code === 'EACCES') {
          // An unreadable process belonging to this service could be ours;
          // skipping it cannot establish that the slot kernel has exited.
          try { if (fs.statSync(`/proc/${pidText}`).uid !== process.getuid()) continue }
          catch (gone) { if (['ENOENT', 'ESRCH'].includes(gone.code)) continue; throw gone }
        }
        throw error
      }
      if (!argv.includes(config)) continue
      const current = identity(Number(pidText))
      if (!current) continue
      if (!matches(current)) throw new Error('Kernel process identity mismatch')
      found.push({ pid: Number(pidText), ...current })
    }
    return found
  }
  function signal(records, name) {
    for (const record of records) {
      const current = identity(record.pid)
      if (!current) continue
      if (current.ticks !== record.ticks || current.uid !== record.uid || current.executable !== record.executable
        || !matches(current)) throw new Error('Kernel process identity changed')
      try { process.kill(record.pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  async function waitGone(timeout) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (!owned().length) return true
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return !owned().length
  }
  return { owned, signal, waitGone }
}

// Caller owns slot control (shutdown) or has drained activity (refresh/recycle).
// Bootstrap is taken last; an admitted reader must never wait for control.
export async function stopCodexKernelForCheckpoint(projectRoot, vmId, binary, ownerBinary) {
  try {
    return await withCodexKernelBootstrap(projectRoot, vmId, async () => {
      const { owned, signal, waitGone } = kernelScope(projectRoot, vmId, binary, ownerBinary)
      signal(owned(), 'SIGTERM')
      if (!await waitGone(3000)) {
        signal(owned(), 'SIGKILL')
        if (!await waitGone(1000)) return { ok: false }
      }
      // A helper inherited the lock before exec and may not yet have visible
      // argv. A zero-process scan alone cannot prove that spawn interval ended.
      const owner = claimCodexKernelOwner(projectRoot, vmId)
      owner.release()
      return { ok: true }
    })
  } catch { return { ok: false } }
}
