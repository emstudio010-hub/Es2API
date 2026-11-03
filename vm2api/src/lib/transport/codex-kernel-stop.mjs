import fs from 'node:fs'
import path from 'node:path'

// A detached kernel can survive a Node restart. Match executable, exact config
// argv, uid and /proc start ticks before signalling; a socket is not exit proof.
export async function stopCodexKernelForCheckpoint(projectRoot, vmId, binary) {
  if (process.platform !== 'linux' || !binary) return { ok: false }
  const config = path.resolve(projectRoot, 'vms', vmId, 'run', 'codex-kernel.json')
  let executable
  try { executable = fs.realpathSync(binary) } catch { return { ok: false } }
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
      if (current.uid !== process.getuid() || current.executable !== executable) throw new Error('Kernel process identity mismatch')
      found.push({ pid: Number(pidText), ...current })
    }
    return found
  }
  function signal(records, name) {
    for (const record of records) {
      const current = identity(record.pid)
      if (!current) continue
      if (current.ticks !== record.ticks || current.uid !== record.uid || current.executable !== record.executable
        || !current.argv.includes(config)) throw new Error('Kernel process identity changed')
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
  try {
    signal(owned(), 'SIGTERM')
    if (await waitGone(3000)) return { ok: true }
    signal(owned(), 'SIGKILL')
    return { ok: await waitGone(1000) }
  } catch { return { ok: false } }
}
