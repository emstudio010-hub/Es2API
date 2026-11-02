import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtime = path.join(root, 'runtime')
const secretFile = path.join(runtime, 'linux-secrets.json')
const configFile = path.join(runtime, 'linux-config.json')
const stateFile = path.join(runtime, 'linux-supervisor.json')
const endpoints = { sub2api: 'http://127.0.0.1:18083', integration: 'http://127.0.0.1:18084', vm2: 'http://127.0.0.1:18787' }
const project = 'es2api-linux'
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
process.umask(0o077)
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const children = []
let stopping = false
let shuttingDown

function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return { pid, bootId, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], exe: fs.readlinkSync(`/proc/${pid}/exe`), uid: fs.statSync(`/proc/${pid}`).uid }
  } catch { return null }
}
function alive(record) {
  const actual = record && identity(record.pid)
  return !!actual && ['pid', 'bootId', 'start', 'exe', 'uid'].every(k => actual[k] === record[k])
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(dir).isSymbolicLink() || fs.statSync(dir).uid !== process.getuid()) throw new Error('运行目录必须由当前用户拥有且不能是符号链接。')
  fs.chmodSync(dir, 0o700)
}
function init() {
  privateDir(runtime)
  for (const name of ['logs', 'sub2api', 'integration', 'vm2']) privateDir(path.join(runtime, name))
  if (!fs.existsSync(secretFile)) {
    const key = () => crypto.randomBytes(32).toString('hex')
    const password = () => 'Aa1-' + crypto.randomBytes(32).toString('base64url')
    const secrets = { version: 1, admin: { email: 'admin@es2api.local', password: password() }, postgres: { password: password() }, redis: { password: password() }, jwt: { secret: key() }, totp: { encryptionKey: key() }, integration: { managementToken: key(), dataKey: key() }, vm2: { adminUser: 'es2api-local', adminPassword: password(), apiKey: key(), dbSecret: key() }, endpoints }
    fs.writeFileSync(secretFile, JSON.stringify(secrets, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (!fs.existsSync(configFile)) write(configFile, { serverHost: '127.0.0.1', frontendUrl: endpoints.sub2api, timezone: 'UTC' })
  const vmRoot = path.join(runtime, 'vm2')
  for (const dir of ['data', 'captures', 'vms', 'session-dumps', 'backup-tmp']) privateDir(path.join(vmRoot, dir))
  // Public, release-pinned binaries only. Never copy an existing user's VM data.
  for (const dir of ['bin', 'share', 'docker']) fs.cpSync(path.join(root, 'payload', dir), path.join(vmRoot, dir), { recursive: true, force: false, errorOnExist: false })
  fs.cpSync(path.join(root, 'vm2api', 'web', 'dist'), path.join(vmRoot, 'web', 'dist'), { recursive: true, force: false, errorOnExist: false })
  for (const item of fs.readdirSync(path.join(vmRoot, 'bin'))) fs.chmodSync(path.join(vmRoot, 'bin', item), 0o700)
  if (!fs.existsSync(path.join(vmRoot, 'routing.json'))) {
    const routing = json(path.join(root, 'vm2api', 'src', 'config', 'routing.json'))
    for (const field of ['health_probe', 'usage_probe', 'credential_refresh', 'kernel_watchdog', 'notify']) routing[field] = { ...routing[field], enabled: false, run_on_start: false }
    write(path.join(vmRoot, 'routing.json'), routing)
  }
  fs.chmodSync(secretFile, 0o600)
  console.log('Es2API 初始化完成。管理员密码保存在 runtime/linux-secrets.json 的 admin.password；文件不得外传。')
}
function secrets() {
  const s = json(secretFile)
  if (s.version !== 1 || JSON.stringify(s.endpoints) !== JSON.stringify(endpoints)) throw new Error('凭据文件版本或内部端口不匹配。')
  for (const value of [s.admin?.password, s.postgres?.password, s.redis?.password, s.jwt?.secret, s.totp?.encryptionKey, s.integration?.managementToken, s.integration?.dataKey, s.vm2?.adminPassword, s.vm2?.apiKey, s.vm2?.dbSecret]) if (typeof value !== 'string' || value.length < 32) throw new Error('凭据文件缺少有效的随机密钥。')
  fs.chmodSync(secretFile, 0o600)
  return s
}
function baseEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(ES2API_|VM2API_|KIN_|DATABASE_|REDIS_|ADMIN_|JWT_|TOTP_|SERVER_)/.test(key) || ['DATA_DIR', 'CONFIG_FILE', 'AUTO_SETUP', 'RUN_MODE', 'PORT', 'HOST', 'PUBLIC_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key.toUpperCase())) delete env[key]
  return { ...env, NO_PROXY: '127.0.0.1,localhost' }
}
function compose(s, args) {
  const env = { ...baseEnv(), ES2API_POSTGRES_PASSWORD: s.postgres.password, ES2API_REDIS_PASSWORD: s.redis.password }
  for (const key of ['ES2API_POSTGRES_IMAGE', 'ES2API_REDIS_IMAGE']) if (process.env[key]) env[key] = process.env[key]
  const result = spawnSync('docker', ['compose', '--project-name', project, '-f', path.join(root, 'deploy-linux', 'compose.yaml'), ...args], { env, stdio: 'inherit', timeout: 240000 })
  if (result.status !== 0) throw new Error('Docker Compose 执行失败；检查 Docker、镜像下载和本机端口。')
}
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.setTimeout(500)
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
  socket.once('timeout', () => { socket.destroy(); resolve(false) })
})
async function waitHealth(url, seconds = 180) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline && !stopping) {
    try { if ((await fetch(url + '/health', { signal: AbortSignal.timeout(2000) })).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('应用未在规定时间内启动，请查看 runtime/logs。')
}
function launch(name, file, args, env, cwd) {
  const log = fs.openSync(path.join(runtime, 'logs', name + '.log'), 'a', 0o600)
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  children.push({ name, child })
  child.once('error', () => { console.error(name + ' 启动失败。'); void shutdown(1) })
  child.once('exit', () => { if (!stopping) { console.error(name + ' 已退出，停止本组应用。'); void shutdown(1) } })
}
function shutdown(code = 0) {
  if (shuttingDown) return shuttingDown
  stopping = true
  shuttingDown = (async () => {
    for (const { child } of [...children].reverse()) if (child.exitCode === null) child.kill('SIGTERM')
    const until = Date.now() + 12000
    while (Date.now() < until && children.some(({ child }) => child.exitCode === null && child.signalCode === null)) await new Promise(resolve => setTimeout(resolve, 200))
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (fs.existsSync(stateFile) && json(stateFile).pid === process.pid) fs.unlinkSync(stateFile)
    // Database containers and all persistent data remain available.
    process.exit(code)
  })()
  return shuttingDown
}
async function run() {
  init()
  const prior = fs.existsSync(stateFile) ? json(stateFile) : null
  if (alive(prior)) throw new Error('此分发包的 Es2API 已在运行。')
  const s = secrets(), cfg = json(configFile)
  if (!['127.0.0.1', '0.0.0.0'].includes(cfg.serverHost)) throw new Error('serverHost 仅支持 127.0.0.1 或 0.0.0.0。')
  for (const port of [18083, 18084, 18787]) if (await portOpen(port)) throw new Error(`端口 ${port} 已占用，未更改已有应用。`)
  for (const [port, service] of [[15433, 'postgres'], [16380, 'redis']]) if (await portOpen(port)) {
    const result = spawnSync('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout.trim()) throw new Error(`数据库端口 ${port} 属于其他项目。`)
  }
  // es2api.sh holds a kernel flock for the entire supervisor lifetime.
  const lock = fs.openSync(stateFile, 'w', 0o600)
  fs.writeFileSync(lock, JSON.stringify(identity(process.pid))); fs.closeSync(lock)
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(0))
  try {
    compose(s, ['up', '-d', '--wait', '--wait-timeout', '120'])
    launch('vm2', process.execPath, [path.join(root, 'deploy-linux', 'vm2.mjs'), 'run'], baseEnv(), root)
    await waitHealth(endpoints.vm2)
    launch('integration', process.execPath, [path.join(root, 'integration', 'src', 'start.mjs')], { ...baseEnv(), ES2API_MANAGEMENT_TOKEN: s.integration.managementToken, ES2API_DATA_KEY: s.integration.dataKey, ES2API_DB_PATH: path.join(runtime, 'integration', 'es2api.sqlite'), ES2API_BIND_HOST: '127.0.0.1', ES2API_BIND_PORT: '18084', ES2API_USAGE_BRIDGE_ENABLED: 'true', ES2API_USAGE_MODE: 'pull', VM2API_BASE_URL: endpoints.vm2, VM2API_PANEL_USERNAME: s.vm2.adminUser, VM2API_PANEL_PASSWORD: s.vm2.adminPassword, VM2API_API_KEY: s.vm2.apiKey }, path.join(runtime, 'integration'))
    await waitHealth(endpoints.integration)
    launch('es2api', path.join(root, 'bin', 'es2api'), [], { ...baseEnv(), AUTO_SETUP: 'true', DATA_DIR: path.join(runtime, 'sub2api'), CONFIG_FILE: path.join(runtime, 'sub2api', 'config.yaml'), PRICING_DATA_DIR: path.join(runtime, 'sub2api', 'pricing'), PRICING_FALLBACK_FILE: path.join(root, 'resources', 'model_prices_and_context_window.json'), SETUP_MIGRATION_TIMEOUT_SECONDS: '180', DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '15433', DATABASE_USER: 'es2api', DATABASE_PASSWORD: s.postgres.password, DATABASE_DBNAME: 'es2api', DATABASE_SSLMODE: 'disable', REDIS_HOST: '127.0.0.1', REDIS_PORT: '16380', REDIS_USERNAME: '', REDIS_PASSWORD: s.redis.password, REDIS_DB: '0', REDIS_ENABLE_TLS: 'false', ADMIN_EMAIL: s.admin.email, ADMIN_PASSWORD: s.admin.password, JWT_SECRET: s.jwt.secret, TOTP_ENCRYPTION_KEY: s.totp.encryptionKey, SERVER_HOST: cfg.serverHost, SERVER_PORT: '18083', SERVER_MODE: 'release', SERVER_FRONTEND_URL: cfg.frontendUrl, RUN_MODE: 'standard', TZ: cfg.timezone || 'UTC', ES2API_INTEGRATION_URL: endpoints.integration, ES2API_MANAGEMENT_TOKEN: s.integration.managementToken }, path.join(runtime, 'sub2api'))
    await waitHealth(endpoints.sub2api, 240)
    console.log('Es2API 已启动：http://127.0.0.1:18083；管理员 admin@es2api.local。按 Ctrl+C 停止应用，数据库和账号保留。')
  } catch (error) { console.error(error.message); await shutdown(1) }
}
async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Linux x86_64 与 Node.js 24+。')
  switch (process.argv[2] || 'help') {
    case 'init': init(); break
    case 'run': await run(); break
    case 'stop': {
      const record = fs.existsSync(stateFile) ? json(stateFile) : null
      if (alive(record)) process.kill(record.pid, 'SIGTERM')
      console.log('已向本包的守护进程发送停止信号；数据库保留。systemd 用户请用 systemctl stop es2api。')
      break
    }
    case 'status':
      for (const [name, url] of Object.entries(endpoints)) {
        let status = 'unreachable'
        try { status = 'HTTP ' + (await fetch(url + '/health', { signal: AbortSignal.timeout(2000) })).status } catch {}
        console.log(`${name}: ${status}`)
      }
      break
    case 'db-stop':
      if (fs.existsSync(stateFile) && alive(json(stateFile))) throw new Error('请先停止 Es2API 应用。')
      compose(secrets(), ['stop']); break
    default: console.log('Es2API Linux：./es2api.sh init | run | stop | status | db-stop\n后台自启：sudo ./install-service.sh')
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
