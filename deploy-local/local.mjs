import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const runtime = path.join(root, 'runtime')
const secretsFile = path.join(runtime, 'local-secrets.json')
const stateFile = path.join(runtime, 'local-processes.json')
const lockFile = path.join(runtime, 'local-launcher.lock')
const logs = path.join(runtime, 'logs')
const project = 'es2api-rebuild-local'
const distro = process.env.ES2API_WSL_DISTRO || 'Ubuntu'
const endpoints = Object.freeze({ sub2api: 'http://127.0.0.1:18083', integration: 'http://127.0.0.1:18084', vm2: 'http://127.0.0.1:18787' })
let secretValues = []

function scrub(text) {
  let result = String(text || '')
  for (const value of secretValues) result = result.replaceAll(value, '[REDACTED]')
  return result
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(file)} failed (${result.status ?? result.error?.code}): ${scrub(result.stderr || result.stdout || result.error?.message).slice(-1500)}`)
  }
  return result.stdout.trim()
}

function powershell(script, env = {}) {
  const childEnv = { ...process.env, ...env }
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PSMODULEPATH') delete childEnv[key]
  const prelude = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding;\n"
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prelude + script, 'utf16le').toString('base64')], { env: childEnv })
}

function protect(target, directory = false) {
  powershell(`$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($sid)
foreach($identity in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
  $who=New-Object System.Security.Principal.SecurityIdentifier($identity)
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($who,'FullControl',${directory ? "'ContainerInherit,ObjectInherit','None'," : ''}'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:ES2API_ACL_TARGET -AclObject $acl`, { ES2API_ACL_TARGET: target })
}

function ensurePrivateDirectory(target) {
  fs.mkdirSync(target, { recursive: true })
  protect(target, true)
}

function writeJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function readJson(target, fallback) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`Invalid JSON: ${target}`)
  }
}

function privateSecrets() {
  const secret = readJson(secretsFile, null)
  if (!secret) throw new Error('Run Init first. No private settings exist yet.')
  if (secret.version !== 1 || JSON.stringify(secret.endpoints) !== JSON.stringify(endpoints)) throw new Error('Unexpected local settings version or endpoints; refusing another environment.')
  for (const [section, field] of [['admin', 'password'], ['postgres', 'password'], ['redis', 'password'], ['jwt', 'secret'], ['totp', 'encryptionKey'], ['integration', 'managementToken'], ['integration', 'dataKey'], ['vm2', 'adminPassword'], ['vm2', 'apiKey'], ['vm2', 'dbSecret']]) {
    const value = secret[section]?.[field]
    if (typeof value !== 'string' || value.length < 32) throw new Error(`Invalid private field ${section}.${field}`)
    secretValues.push(value)
  }
  if (secret.admin.email !== 'admin@es2api.local' || secret.postgres.user !== 'es2api_local' || secret.postgres.database !== 'es2api_local') throw new Error('Unexpected local database or admin identity.')
  protect(secretsFile)
  return secret
}

function init() {
  fs.mkdirSync(runtime, { recursive: true })
  for (const folder of ['logs', 'sub2api', 'integration', 'vm2']) ensurePrivateDirectory(path.join(runtime, folder))
  if (!fs.existsSync(secretsFile)) {
    const fd = fs.openSync(secretsFile, 'wx', 0o600)
    fs.closeSync(fd)
    protect(secretsFile)
    const key = () => crypto.randomBytes(32).toString('hex')
    const password = () => `Aa1-${crypto.randomBytes(32).toString('base64url')}`
    writeJson(secretsFile, {
      version: 1, createdAt: new Date().toISOString(),
      admin: { email: 'admin@es2api.local', password: password() },
      postgres: { user: 'es2api_local', database: 'es2api_local', password: password() },
      redis: { password: password() }, jwt: { secret: key() }, totp: { encryptionKey: key() },
      integration: { managementToken: key(), dataKey: key() },
      vm2: { adminUser: 'es2api-local', adminPassword: password(), apiKey: key(), dbSecret: key() },
      endpoints,
    })
  }
  privateSecrets()
  const vm2 = path.join(runtime, 'vm2')
  for (const folder of ['data', 'captures', 'vms', 'bin', 'session-dumps', 'backup-tmp']) fs.mkdirSync(path.join(vm2, folder), { recursive: true })
  const routingFile = path.join(vm2, 'routing.json')
  if (!fs.existsSync(routingFile)) {
    const routing = readJson(path.join(root, 'vm2api', 'src', 'config', 'routing.json'))
    for (const field of ['health_probe', 'usage_probe', 'credential_refresh', 'kernel_watchdog', 'notify']) routing[field] = { ...routing[field], enabled: false, run_on_start: false }
    writeJson(routingFile, routing)
  }
  console.log(`Initialized independent settings: ${secretsFile}`)
  console.log('Existing keys and databases are preserved. No service was started; no terms were accepted.')
}

function processInfo(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null
  const raw = powershell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop
if($p) { @{pid=[int]$p.ProcessId; executable=$p.ExecutablePath; commandLine=$p.CommandLine; createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`)
  return raw ? JSON.parse(raw) : null
}

function ownedProcess(record) {
  if (!record) return null
  const actual = processInfo(record.pid)
  if (!actual) return null
  if (actual.executable?.toLowerCase() !== record.executable?.toLowerCase() || actual.createdAt !== record.createdAt || actual.commandLine !== record.commandLine) throw new Error(`PID ${record.pid} no longer matches its saved executable, command line, and creation time; refusing to stop or reuse it.`)
  return actual
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(700)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

function baseEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(ES2API_|VM2API_|KIN_|DATABASE_|REDIS_|ADMIN_|JWT_|TOTP_|SERVER_)/.test(key) || ['DATA_DIR', 'CONFIG_FILE', 'AUTO_SETUP', 'RUN_MODE', 'PORT', 'HOST', 'PUBLIC_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].includes(key.toUpperCase())) delete env[key]
  env.NO_PROXY = '127.0.0.1,localhost'
  return env
}

function composeEnv(secret) {
  const env = { ...baseEnv(), ES2API_POSTGRES_PASSWORD: secret.postgres.password, ES2API_REDIS_PASSWORD: secret.redis.password }
  for (const name of ['ES2API_POSTGRES_IMAGE', 'ES2API_REDIS_IMAGE']) if (process.env[name]) env[name] = process.env[name]
  return env
}

function compose(secret, args) {
  return run('docker.exe', ['compose', '--project-name', project, '--file', path.join(here, 'compose.yaml'), ...args], { env: composeEnv(secret), timeout: 180_000 })
}

async function ensureDockerEngine() {
  const ready = () => spawnSync('docker.exe', ['info', '--format', '{{.ServerVersion}}'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).status === 0
  if (ready()) return
  // Recover only the known disposable socket directories, while the Desktop
  // backend is absent. Keep every directory as a rollback copy; never touch
  // Docker data, VHDX files, images, volumes or another project's containers.
  const backend = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Process -Name 'com.docker.backend' -ErrorAction SilentlyContinue) { exit 1 }"], { windowsHide: true })
  const localApp = process.env.LOCALAPPDATA
  if (backend.status === 0 && localApp) {
    const dockerRoot = path.resolve(localApp, 'Docker')
    const runDir = path.join(dockerRoot, 'run')
    const hostLog = path.join(dockerRoot, 'log', 'host', 'com.docker.backend.exe.log')
    const knownFailure = fs.existsSync(hostLog) && fs.readFileSync(hostLog, 'utf8').slice(-128 * 1024).includes('sailor-ingest.sock')
    if (knownFailure && fs.existsSync(path.join(runDir, 'sailor-ingest.sock'))) {
      for (const directory of [runDir, path.resolve(localApp, 'docker-secrets-engine')]) {
        if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) continue
        fs.renameSync(directory, directory + '.broken-' + Date.now())
      }
      console.log('Preserved broken Docker socket runtime directories; starting Desktop.')
    }
  }
  const result = spawnSync('docker.exe', ['desktop', 'start', '--detach'], { windowsHide: true, timeout: 15000, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Docker Desktop could not start. Inspect its private host log.')
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  throw new Error('Docker Desktop did not become ready within 90 seconds; application data was retained.')
}

function linuxPath(windowsPath) {
  return run('wsl.exe', ['-d', distro, '--exec', 'wslpath', '-a', '-u', windowsPath.replaceAll('\\', '/')])
}

async function waitHealth(name, base, seconds = 90) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
      if (response.status === 200) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${name} did not become healthy in ${seconds}s. Inspect its private log in ${logs}.`)
}

async function launch(name, executable, args, env, cwd, state) {
  const stdout = fs.openSync(path.join(logs, `${name}.stdout.log`), 'a')
  const stderr = fs.openSync(path.join(logs, `${name}.stderr.log`), 'a')
  let child
  try {
    child = spawn(executable, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  } finally { fs.closeSync(stdout); fs.closeSync(stderr) }
  child.unref()
  const record = processInfo(child.pid)
  if (!record) throw new Error(`${name} exited during startup. Inspect its private log.`)
  state.processes[name] = record
  writeJson(stateFile, state)
  console.log(`${name} started (PID ${child.pid}).`)
}

async function start() {
  const secret = privateSecrets()
  const state = readJson(stateFile, { version: 1, project, processes: {} })
  const running = Object.entries(state.processes).filter(([, record]) => ownedProcess(record))
  if (running.length) {
    if (running.length === 3) {
      for (const [name, url] of Object.entries(endpoints)) await waitHealth(name, url, 15)
      console.log('Managed processes are already running and healthy.')
      await status()
      return
    }
    throw new Error(`Partial managed startup (${running.map(([name]) => name).join(', ')}). Run Stop, then Start; existing data is retained.`)
  }
  for (const port of [18083, 18084, 18787]) if (await portOpen(port)) throw new Error(`Port ${port} is occupied. No existing service was changed.`)
  await ensureDockerEngine()
  for (const [port, service] of [[15433, 'postgres'], [16380, 'redis']]) {
    if (await portOpen(port)) {
      const ids = run('docker.exe', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])
      if (!ids) throw new Error(`Port ${port} is occupied by a service outside this compose project.`)
    }
  }
  const binary = path.join(runtime, 'bin', 'es2api.exe')
  const kernel = path.join(runtime, 'vm2', 'bin', 'kin-api-kernel')
  const pricingFallback = path.join(root, 'sub2api', 'backend', 'resources', 'model-pricing', 'model_prices_and_context_window.json')
  if (!fs.existsSync(binary)) throw new Error(`Missing embedded Go application: ${binary}`)
  if (!fs.existsSync(kernel)) throw new Error(`Missing Linux VM2 API kernel: ${kernel}`)
  run(process.execPath, [path.join(root, 'vm2api/scripts/fetch-payload.mjs'), '--dest', path.join(runtime, 'vm2'), '--check'])
  if (!fs.existsSync(pricingFallback)) throw new Error(`Missing local pricing fallback: ${pricingFallback}`)
  const wrapper = linuxPath(path.join(here, 'vm2-wsl.mjs'))
  run('wsl.exe', ['-d', distro, '--', 'node', '--version'])
  fs.mkdirSync(logs, { recursive: true })
  compose(secret, ['up', '-d', '--wait', '--wait-timeout', '120'])
  console.log('Independent PostgreSQL and Redis are healthy.')
  state.processes = {}
  state.startedAt = new Date().toISOString()
  state.wslDistro = distro
  state.wslWrapper = wrapper
  writeJson(stateFile, state)
  try {
    await launch('vm2', 'wsl.exe', ['-d', distro, '--', 'node', wrapper, 'run'], baseEnv(), root, state)
    await waitHealth('VM2', endpoints.vm2)
    await launch('integration', process.execPath, [path.join(root, 'integration', 'src', 'start.mjs')], {
      ...baseEnv(), ES2API_MANAGEMENT_TOKEN: secret.integration.managementToken, ES2API_DATA_KEY: secret.integration.dataKey,
      ES2API_DB_PATH: path.join(runtime, 'integration', 'es2api.sqlite'), ES2API_BIND_HOST: '127.0.0.1', ES2API_BIND_PORT: '18084',
      ES2API_USAGE_BRIDGE_ENABLED: 'true', ES2API_USAGE_MODE: 'pull',
      VM2API_BASE_URL: endpoints.vm2, VM2API_PANEL_USERNAME: secret.vm2.adminUser, VM2API_PANEL_PASSWORD: secret.vm2.adminPassword, VM2API_API_KEY: secret.vm2.apiKey,
    }, path.join(runtime, 'integration'), state)
    await waitHealth('Integration', endpoints.integration)
    await launch('sub2api', binary, [], {
      ...baseEnv(), AUTO_SETUP: 'true', DATA_DIR: path.join(runtime, 'sub2api'), CONFIG_FILE: path.join(runtime, 'sub2api', 'config.yaml'),
      PRICING_DATA_DIR: path.join(runtime, 'sub2api', 'pricing'), PRICING_FALLBACK_FILE: pricingFallback, SETUP_MIGRATION_TIMEOUT_SECONDS: '180',
      DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '15433', DATABASE_USER: secret.postgres.user, DATABASE_PASSWORD: secret.postgres.password, DATABASE_DBNAME: secret.postgres.database, DATABASE_SSLMODE: 'disable',
      REDIS_HOST: '127.0.0.1', REDIS_PORT: '16380', REDIS_USERNAME: '', REDIS_PASSWORD: secret.redis.password, REDIS_DB: '0', REDIS_ENABLE_TLS: 'false',
      ADMIN_EMAIL: secret.admin.email, ADMIN_PASSWORD: secret.admin.password, JWT_SECRET: secret.jwt.secret, TOTP_ENCRYPTION_KEY: secret.totp.encryptionKey,
      SERVER_HOST: '127.0.0.1', SERVER_PORT: '18083', SERVER_MODE: 'release', SERVER_FRONTEND_URL: endpoints.sub2api, RUN_MODE: 'standard', TZ: 'Asia/Shanghai',
      ES2API_INTEGRATION_URL: endpoints.integration, ES2API_MANAGEMENT_TOKEN: secret.integration.managementToken,
    }, path.join(runtime, 'sub2api'), state)
    await waitHealth('Sub2API', endpoints.sub2api, 240)
    console.log(`Local application ready: ${endpoints.sub2api}`)
    console.log(`Login: ${secret.admin.email}; password remains in ${secretsFile} (admin.password).`)
    console.log('Product terms still require the owner in the normal UI; accounts and slots are managed separately in the account pool.')
  } catch (error) {
    console.error(scrub(error.message))
    console.error('Startup stopped. Managed PIDs and data remain recorded; use Stop to release this environment.')
    process.exitCode = 1
  }
}

async function stop(stopDatabases = true) {
  const secret = privateSecrets()
  const state = readJson(stateFile, { version: 1, project, processes: {} })
  for (const name of ['sub2api', 'integration', 'vm2']) {
    const record = state.processes[name]
    const actual = ownedProcess(record)
    if (name === 'vm2' && state.wslWrapper) {
      run('wsl.exe', ['-d', state.wslDistro || distro, '--', 'node', state.wslWrapper, 'stop'], { timeout: 20_000 })
    }
    if (actual && ownedProcess(record)) {
      process.kill(record.pid, 'SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    delete state.processes[name]
    writeJson(stateFile, state)
  }
  if (stopDatabases) compose(secret, ['stop', '--timeout', '20'])
  console.log('Managed application processes stopped. All databases, volumes, keys, and logs are retained.')
}

async function status() {
  const state = readJson(stateFile, { processes: {} })
  for (const [name, url] of Object.entries(endpoints)) {
    let identity = 'not tracked'
    try { identity = ownedProcess(state.processes[name]) ? 'owned process running' : 'stopped' } catch { identity = 'PID identity mismatch' }
    let health = 'unreachable'
    try { health = `HTTP ${(await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000), redirect: 'manual' })).status}` } catch {}
    console.log(`${name}: ${identity}; ${health}; ${url}`)
  }
  if (fs.existsSync(secretsFile)) {
    const secret = privateSecrets()
    console.log(compose(secret, ['ps', '--format', 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}']))
  }
}

async function main() {
  const action = (process.argv[2] || 'status').toLowerCase()
  if (['--help', '-h', 'help'].includes(action)) { console.log('Usage: node deploy-local/local.mjs init|start|stop|pause|status'); return }
  if (!['init', 'start', 'stop', 'pause', 'status'].includes(action)) throw new Error('Expected init, start, stop, pause, or status.')
  if (process.platform !== 'win32') throw new Error('Run local.mjs on Windows; VM2 uses the WSL wrapper internally.')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Windows Node.js 24 or newer is required.')
  let locked = false
  if (action !== 'status') {
    fs.mkdirSync(runtime, { recursive: true })
    if (fs.existsSync(lockFile)) {
      const previous = readJson(lockFile, {})
      const actual = previous.pid ? processInfo(previous.pid) : null
      if (actual && actual.createdAt === previous.createdAt) throw new Error('Another local launcher action is still running.')
      fs.unlinkSync(lockFile)
    }
    fs.writeFileSync(lockFile, JSON.stringify(processInfo(process.pid)), { flag: 'wx', mode: 0o600 })
    locked = true
  }
  try { await ({ init, start, stop, pause: () => stop(false), status })[action]() } finally { if (locked) fs.unlinkSync(lockFile) }
}

main().catch(error => { console.error(scrub(error.message)); process.exitCode = 1 })
