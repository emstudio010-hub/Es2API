import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtime = path.join(root, 'runtime')
const vmRoot = path.join(runtime, 'vm2')
const stateFile = path.join(vmRoot, 'linux-processes.json')
const source = path.join(root, 'vm2api', 'src', 'server.mjs')
const kernel = path.join(vmRoot, 'bin', 'kin-api-kernel')
const rootHash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)
const socketRoot = path.join(os.tmpdir(), `es2api-rebuild-${process.getuid()}-${rootHash}`)
const socketPath = path.join(socketRoot, 'api-kernel.sock')
const tokenPath = path.join(socketRoot, 'api-kernel.token')
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    return { pid, bootId, startTicks: fields[19], executable: fs.readlinkSync(`/proc/${pid}/exe`), uid: fs.statSync(`/proc/${pid}`).uid, cmd }
  } catch { return null }
}

function savedIdentity(pid, kind) {
  const item = identity(pid)
  if (!item) return null
  // The API kernel command line contains an internal token: never persist it.
  const { cmd, ...safe } = item
  return { ...safe, kind }
}

function matches(record) {
  if (!record) return false
  const actual = identity(record.pid)
  if (!actual) return false
  if (record.bootId !== actual.bootId || record.startTicks !== actual.startTicks || record.executable !== actual.executable || record.uid !== actual.uid || actual.uid !== process.getuid()) throw new Error(`Linux PID ${record.pid} identity mismatch; refusing to stop it.`)
  if (record.kind === 'server' && !actual.cmd.includes(source)) throw new Error('Linux server command does not match this checkout.')
  if (record.kind === 'wrapper' && !actual.cmd.includes(fileURLToPath(import.meta.url))) throw new Error('Linux wrapper command does not match this checkout.')
  if (record.kind === 'kernel' && (actual.executable !== kernel || !actual.cmd.includes(socketPath))) throw new Error('Linux kernel command does not match the independent socket.')
  return true
}

function findKernel() {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const record = identity(Number(entry))
    if (record?.uid === process.getuid() && record.executable === kernel && record.cmd.includes(socketPath)) return savedIdentity(record.pid, 'kernel')
  }
  return null
}

function signal(record, value) {
  if (matches(record)) process.kill(record.pid, value)
}

async function stop() {
  const state = readJson(stateFile, null)
  if (!state) { console.log('No WSL processes recorded.'); return }
  for (const record of [state.server, state.kernel, state.wrapper]) if (record?.pid !== process.pid) signal(record, 'SIGTERM')
  const until = Date.now() + 8000
  while (Date.now() < until && [state.server, state.kernel, state.wrapper].some(record => record?.pid !== process.pid && matches(record))) await new Promise(resolve => setTimeout(resolve, 200))
  for (const record of [state.server, state.kernel, state.wrapper]) if (record?.pid !== process.pid && matches(record)) signal(record, 'SIGKILL')
  console.log('Verified Linux VM2 processes stopped; data retained.')
}

async function run() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) throw new Error('Linux Node.js 24 or newer is required.')
  const prior = readJson(stateFile, null)
  if (prior && [prior.wrapper, prior.server, prior.kernel].some(record => matches(record))) throw new Error('A verified Linux VM2 process is already running; use Stop first.')
  if (!fs.existsSync(kernel)) throw new Error(`Missing Linux API kernel: ${kernel}`)
  const secret = readJson(path.join(runtime, 'linux-secrets.json'))
  if (secret?.version !== 1 || secret.endpoints?.vm2 !== 'http://127.0.0.1:18787') throw new Error('Unexpected VM2 settings or endpoint.')
  fs.mkdirSync(socketRoot, { recursive: true, mode: 0o700 })
  const socketDirectory = fs.lstatSync(socketRoot)
  if (!socketDirectory.isDirectory() || socketDirectory.isSymbolicLink() || socketDirectory.uid !== process.getuid()) throw new Error('Socket directory must be a real directory owned by this Linux user.')
  fs.chmodSync(socketRoot, 0o700)
  fs.chmodSync(kernel, 0o700)
  for (const name of ['kin-kernel', 'kin-codex-kernel', 'kin-worker', 'kin-egress', 'kin-slot-gate', 'kin-oauth-auth', 'kin-computer']) {
    const helper = path.join(vmRoot, 'bin', name)
    if (!fs.existsSync(helper)) throw new Error(`Missing slot helper ${name}; run the local build/payload preparation first.`)
    fs.chmodSync(helper, 0o700)
  }
  process.umask(0o077)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(KIN_|VM2API_|ES2API_)/.test(key) || ['HOST', 'PORT', 'PUBLIC_HOST', 'PUBLIC_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key.toUpperCase())) delete env[key]
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: '18787', PUBLIC_BASE_URL: secret.endpoints.vm2,
    VM2API_ADMIN_USER: secret.vm2.adminUser, VM2API_ADMIN_PASSWORD: secret.vm2.adminPassword,
    VM2API_API_KEY: secret.vm2.apiKey, VM2API_DB_SECRET: secret.vm2.dbSecret,
    ES2API_USAGE_MODE: 'pull',
    KIN_PROJECT_ROOT: vmRoot, KIN_DATA_DIR: path.join(vmRoot, 'data'), KIN_DB_PATH: path.join(vmRoot, 'data', 'kin.db'),
    KIN_CAPTURES_DIR: path.join(vmRoot, 'captures'), KIN_ROUTING_FILE: path.join(vmRoot, 'routing.json'),
    KIN_SESSION_DUMP: path.join(vmRoot, 'session-dumps'), KIN_BACKUP_TMPDIR: path.join(vmRoot, 'backup-tmp'),
    KIN_API_KERNEL_BIN: kernel, KIN_API_KERNEL_SOCK: socketPath, KIN_API_KERNEL_TOKEN: tokenPath,
    KIN_CODEX_SOCKET_DIR: path.join(socketRoot, 'codex'),
    KIN_KERNEL_BIN: path.join(vmRoot, 'bin', 'kin-kernel'),
    KIN_CODEX_KERNEL_BIN: path.join(vmRoot, 'bin', 'kin-codex-kernel'),
    KIN_WORKER_BIN: path.join(vmRoot, 'bin', 'kin-worker'),
    KIN_EGRESS_BIN: path.join(vmRoot, 'bin', 'kin-egress'),
    KIN_OAUTH_AUTH_BIN: path.join(vmRoot, 'bin', 'kin-oauth-auth'),
    KIN_COMPUTER_BIN: path.join(vmRoot, 'bin', 'kin-computer'),
    KIN_WRAP_CLI_ROOT: path.join(vmRoot, 'share', 'wrap-cli'),
    KIN_CRAG_KERNEL_BIN: path.join(vmRoot, 'share', 'crag', 'kin-kernel'),
    VM2API_CLUSTER_SOCKET_DIR: path.join(socketRoot, 'cluster'),
    NO_PROXY: '127.0.0.1,localhost',
  })
  const child = spawn(process.execPath, [source], { cwd: vmRoot, env, stdio: ['ignore', 'inherit', 'inherit'] })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const state = { version: 1, root, socketRoot, wrapper: savedIdentity(process.pid, 'wrapper'), server: savedIdentity(child.pid, 'server'), kernel: null }
  const save = () => fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  save()
  const watch = setInterval(() => {
    const found = findKernel()
    if (found && (found.pid !== state.kernel?.pid || found.startTicks !== state.kernel?.startTicks)) { state.kernel = found; save() }
  }, 250)
  let stopping = false
  const cleanupKernel = () => {
    try { signal(state.kernel || findKernel(), 'SIGTERM') } catch {}
  }
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    if (stopping) return
    stopping = true
    try { signal(state.server, 'SIGTERM') } catch {}
    cleanupKernel()
    setTimeout(() => { try { signal(state.server, 'SIGKILL') } catch {}; process.exit(0) }, 7000).unref()
  })
  child.once('exit', (code, sig) => {
    clearInterval(watch)
    cleanupKernel()
    console.log(`VM2 server exited (${sig || code}).`)
    process.exitCode = stopping ? 0 : (code ?? 1)
  })
  process.once('exit', cleanupKernel)
}

try {
  if (process.argv[2] === 'stop') await stop()
  else if (process.argv[2] === 'run') await run()
  else throw new Error('Expected run or stop (called by the Linux supervisor).')
} catch (error) {
  console.error(`Es2API execution launcher: ${error.code || error.message}`)
  process.exitCode = 1
}
