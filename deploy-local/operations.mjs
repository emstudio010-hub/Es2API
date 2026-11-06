import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync, backup } from 'node:sqlite'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtime = path.join(root, 'runtime')
const action = process.argv[2] || 'help'
const secretPath = path.join(runtime, 'local-secrets.json')
const control = path.join(runtime, 'operations-control.json')
const statusPath = path.join(runtime, 'operations-status.json')
const log = path.join(runtime, 'logs', 'operations.log')
const secrets = () => JSON.parse(fs.readFileSync(secretPath, 'utf8'))
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function record(event, extra = {}) {
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), event, ...extra }) + '\n')
  if (process.platform === 'win32' && ['recovery_failed', 'backup_failed'].includes(event)) {
    spawnSync('eventcreate.exe', ['/T', 'ERROR', '/ID', '100', '/L', 'APPLICATION', '/SO', 'Es2API', '/D', `Es2API ${event}. Inspect the private operations log.`], { windowsHide: true, timeout: 5000, stdio: 'ignore' })
  }
}
function writeControl(enabled) { fs.writeFileSync(control, JSON.stringify({ enabled }) + '\n') }
function docker(args, env = {}) {
  const result = spawnSync('docker.exe', args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 180000 })
  if (result.status !== 0) throw new Error('Docker operation failed; inspect private service logs')
  return result.stdout.trim()
}
function pgContainer() {
  const id = docker(['ps', '--filter', 'label=com.docker.compose.project=es2api-rebuild-local', '--filter', 'label=com.docker.compose.service=postgres', '--format', '{{.ID}}'])
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Project PostgreSQL container is not running')
  return id
}
async function child(command, args, { output, input, env = {}, timeout = 15 * 60 * 1000 } = {}) {
  const out = output ? fs.openSync(output, 'w', 0o600) : fs.openSync(log, 'a')
  const errors = output ? fs.openSync(log, 'a') : out
  const incoming = input ? fs.openSync(input, 'r') : 'ignore'
  try {
    const proc = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: [incoming, out, errors] })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
        else proc.kill('SIGKILL')
      }, timeout)
      timer.unref()
      proc.once('error', error => { clearTimeout(timer); reject(error) })
      proc.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Operation failed; inspect private operations log')) })
    })
  } finally { fs.closeSync(out); if (errors !== out) fs.closeSync(errors); if (typeof incoming === 'number') fs.closeSync(incoming) }
}
async function activeRuns() {
  try {
    const response = await fetch('http://127.0.0.1:18084/api/v1/admin/modeltrace/summary', { headers: { authorization: `Bearer ${secrets().integration.managementToken}` }, signal: AbortSignal.timeout(3000) })
    const result = await response.json()
    if (!response.ok || result.ok !== true) throw new Error('Cannot establish current run state')
    return result.data.active_runs
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error
    return 0
  }
}
async function createBackup() {
  if (await activeRuns()) throw new Error('Wait for active ModelTrace tasks to finish before backup')
  const destination = path.join(runtime, 'backups', stamp())
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 })
  const secret = secrets(), pg = pgContainer()
  await child('docker.exe', ['exec', '-e', 'PGPASSWORD', pg, 'pg_dump', '-U', secret.postgres.user, '-d', secret.postgres.database, '-Fc'], {
    output: path.join(destination, 'postgres.dump'), env: { PGPASSWORD: secret.postgres.password },
  })
  for (const [source, name] of [['integration/es2api.sqlite', 'integration.sqlite'], ['vm2/data/kin.db', 'vm2.sqlite']]) {
    const db = new DatabaseSync(path.join(runtime, source), { readOnly: true })
    try { await backup(db, path.join(destination, name)) } finally { db.close() }
  }
  await fsp.copyFile(secretPath, path.join(destination, 'local-secrets.json'))
  for (const [source, name] of [['vm2/routing.json', 'routing.json'], ['sub2api/config.yaml', 'sub2api-config.yaml']]) {
    if (fs.existsSync(path.join(runtime, source))) await fsp.copyFile(path.join(runtime, source), path.join(destination, name))
  }
  const vms = path.join(runtime, 'vm2', 'vms')
  const refreshJournal = path.join(runtime, 'vm2', '.codex-refresh')
  if (fs.existsSync(refreshJournal)) await fsp.cp(refreshJournal, path.join(destination, 'codex-refresh'), { recursive: true, filter: source => {
    const stat = fs.lstatSync(source)
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new Error('Invalid refresh journal backup entry')
    return true
  } })
  if (fs.existsSync(vms)) await fsp.cp(vms, path.join(destination, 'vms'), { recursive: true, filter: source => {
    const stat = fs.lstatSync(source)
    return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()) && !source.split(path.sep).includes('run')
  } })
  const files = {}
  async function inventory(folder, prefix = '') {
    for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await inventory(path.join(folder, entry.name), relative + '/')
      else files[relative] = sha(await fsp.readFile(path.join(folder, entry.name)))
    }
  }
  await inventory(destination)
  await fsp.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ version: 1, created_at: new Date().toISOString(), files }, null, 2))
  record('backup_created', { directory: destination })
  console.log(destination)
  return destination
}
async function restore(directory) {
  writeControl(false)
  await child(process.execPath, [path.join(root, 'deploy-local/local.mjs'), 'pause'])
  const source = await fsp.realpath(directory)
  const backupRoot = await fsp.realpath(path.join(runtime, 'backups'))
  if (!source.startsWith(backupRoot + path.sep)) throw new Error('Restore source must be a project backup directory')
  for (const port of [18083, 18084, 18787]) {
    let running = false
    try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); running = true } catch {}
    if (running) throw new Error('Stop application services before restore; PostgreSQL must remain running')
  }
  const refreshJournal = path.join(runtime, 'vm2', '.codex-refresh')
  if (fs.existsSync(refreshJournal) && (fs.lstatSync(refreshJournal).isSymbolicLink()
    || fs.readdirSync(refreshJournal).some(name => name.endsWith('.pending.json')))) throw new Error('Resolve pending OAuth rotation before restoring older credentials or encryption keys')
  const manifest = JSON.parse(await fsp.readFile(path.join(source, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || !manifest.files) throw new Error('Unsupported backup manifest')
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const target = path.resolve(source, relative)
    if (!target.startsWith(source + path.sep) || sha(await fsp.readFile(target)) !== digest) throw new Error('Backup integrity check failed')
  }
  for (const required of ['postgres.dump', 'integration.sqlite', 'vm2.sqlite', 'local-secrets.json']) if (!manifest.files[required]) throw new Error('Incomplete backup')
  // Capture the current databases before any replacement. This backup is also
  // the rollback point if a later restore step fails.
  const rollback = await createBackup()
  const currentSecret = secrets(), restoredSecret = JSON.parse(await fsp.readFile(path.join(source, 'local-secrets.json'), 'utf8'))
  if (restoredSecret.postgres.password !== currentSecret.postgres.password || restoredSecret.redis.password !== currentSecret.redis.password) throw new Error('Database credentials differ; migrate the storage service explicitly before restoring')
  await child('docker.exe', ['exec', '-i', '-e', 'PGPASSWORD', pgContainer(), 'pg_restore', '-U', currentSecret.postgres.user, '-d', currentSecret.postgres.database, '--clean', '--if-exists', '--single-transaction', '--exit-on-error'], { input: path.join(source, 'postgres.dump'), env: { PGPASSWORD: currentSecret.postgres.password } })
  for (const [name, target] of [['integration.sqlite', 'integration/es2api.sqlite'], ['vm2.sqlite', 'vm2/data/kin.db'], ['local-secrets.json', 'local-secrets.json'], ['routing.json', 'vm2/routing.json'], ['sub2api-config.yaml', 'sub2api/config.yaml']]) {
    if (manifest.files[name]) await fsp.copyFile(path.join(source, name), path.join(runtime, target))
    if (name.endsWith('.sqlite')) for (const suffix of ['-wal', '-shm']) { const sidecar = path.join(runtime, target + suffix); if (fs.existsSync(sidecar)) await fsp.rename(sidecar, sidecar + '.before-restore-' + Date.now()) }
  }
  if (fs.existsSync(path.join(source, 'vms'))) {
    const target = path.join(runtime, 'vm2', 'vms')
    if (fs.existsSync(target)) await fsp.rename(target, target + '.before-restore-' + Date.now())
    await fsp.cp(path.join(source, 'vms'), target, { recursive: true })
  }
  if (fs.existsSync(refreshJournal)) await fsp.rename(refreshJournal, refreshJournal + '.before-restore-' + Date.now())
  if (fs.existsSync(path.join(source, 'codex-refresh'))) await fsp.cp(path.join(source, 'codex-refresh'), refreshJournal, { recursive: true })
  record('restore_completed', { source, rollback }); console.log('Restore completed. Start the stack when ready.')
}
async function rollbackBinary(file) {
  writeControl(false)
  const source = await fsp.realpath(file)
  const bin = await fsp.realpath(path.join(runtime, 'bin'))
  if (path.dirname(source) !== bin || !/^es2api\.exe\.previous-[0-9-]+$/.test(path.basename(source))) throw new Error('Select a retained project binary')
  await child(process.execPath, [path.join(root, 'deploy-local/local.mjs'), 'pause'])
  const current = path.join(bin, 'es2api.exe')
  await fsp.copyFile(current, current + '.before-rollback-' + Date.now())
  await fsp.copyFile(source, current)
  record('binary_rolled_back', { source })
  await child(process.execPath, [path.join(root, 'deploy-local/local.mjs'), 'start'])
  console.log('Retained binary restored. Automatic recovery remains disabled until explicitly started.')
}
async function guard() {
  const lock = path.join(runtime, 'operations-guard.lock')
  if (fs.existsSync(lock)) {
    const owner = Number(fs.readFileSync(lock, 'utf8'))
    if (Number.isSafeInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); throw new Error('An operations guard is already running') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    fs.unlinkSync(lock)
  }
  const lockFile = fs.openSync(lock, 'wx', 0o600)
  fs.writeFileSync(lockFile, String(process.pid)); fs.closeSync(lockFile)
  try { await runGuard() }
  finally { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock) }
}
async function runGuard() {
  let state = '', failures = 0, retryAt = 0, lastBackup = Date.now()
  writeControl(true)
  while (JSON.parse(fs.readFileSync(control, 'utf8')).enabled === true) {
    const health = await Promise.all([18083, 18084, 18787].map(async port => {
      try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) }); await response.arrayBuffer(); return response.ok } catch { return false }
    }))
    const next = health.every(Boolean) ? 'healthy' : 'unavailable'
    if (next !== state) { record('health_changed', { state: next, ports: health }); state = next }
    fs.writeFileSync(statusPath, JSON.stringify({ at: new Date().toISOString(), state, ports: health, consecutive_failures: failures, next_recovery_at: retryAt ? new Date(retryAt).toISOString() : null }))
    if (next === 'healthy') {
      failures = 0
      if (Date.now() - lastBackup >= 24 * 60 * 60 * 1000) { try { await createBackup(); lastBackup = Date.now() } catch { record('backup_failed'); lastBackup = Date.now() - 23 * 60 * 60 * 1000 } }
    } else if (++failures >= 3 && Date.now() >= retryAt) {
      try {
        await child('docker.exe', ['desktop', 'start', '--detach'])
        await child(process.execPath, [path.join(root, 'deploy-local/local.mjs'), 'stop'])
        await child(process.execPath, [path.join(root, 'deploy-local/local.mjs'), 'start'])
        record('recovery_completed')
      } catch { record('recovery_failed') }
      retryAt = Date.now() + 5 * 60 * 1000; failures = 0
    }
    await new Promise(resolve => setTimeout(resolve, 20000))
  }
  record('guard_stopped')
}
fs.mkdirSync(path.dirname(log), { recursive: true })
try {
  if (action === 'backup') await createBackup()
  else if (action === 'restore') { if (!process.argv[3]) throw new Error('Supply the backup directory'); await restore(process.argv[3]) }
  else if (action === 'rollback-binary') { if (!process.argv[3]) throw new Error('Supply the retained binary path'); await rollbackBinary(process.argv[3]) }
  else if (action === 'guard') await guard()
  else if (action === 'disable') { writeControl(false); console.log('Automatic recovery disabled.') }
  else console.log('node deploy-local/operations.mjs backup|restore <project-backup-directory>|rollback-binary <retained-binary>|guard|disable')
} catch (error) { record('operation_failed', { action }); console.error(error.message); process.exitCode = 1 }
