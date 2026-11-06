// Encrypted control-plane state, outside every removable slot home.
// Callers hold the slot control lock and have drained/stopped the kernel.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isValidVmId } from '../vm/vm-file.mjs'
const commits = new AsyncLocalStorage()
const sessions = new WeakSet()
const fail = (code = 'codex_refresh_recovery_required') => Object.assign(new Error(
  code === 'codex_refresh_storage_unavailable' ? '刷新凭据的加密保存不可用，已停止操作' : '存在未确认的 OAuth 换票，请先恢复已保存的刷新凭据；未再次换票'), { status: 409, code })
const secretKey = () => {
  const secret = process.env.VM2API_DB_SECRET || process.env.KIN_DB_SECRET
  if (typeof secret !== 'string' || secret.length < 32) throw fail('codex_refresh_storage_unavailable')
  return crypto.createHash('sha256').update('Es2API Codex refresh journal v1\0').update(secret).digest()
}
function location(projectRoot, vmId, create = false) {
  if (!projectRoot || !isValidVmId(vmId)) throw fail('codex_refresh_storage_unavailable')
  const base = fs.realpathSync(projectRoot), root = path.join(base, '.codex-refresh')
  if (create) { try { fs.mkdirSync(root, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e } }
  try { const st = fs.lstatSync(root); if (!st.isDirectory() || st.isSymbolicLink()) throw fail() }
  catch (e) { if (e.code !== 'ENOENT' || create) throw e }
  return { root, file: path.join(root, `${vmId}.pending.json`), vmId }
}
function regular(file) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 4 * 1024 * 1024) throw fail()
  return st
}
function syncDirectory(directory) {
  if (process.platform !== 'linux') throw fail('codex_refresh_storage_unavailable')
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function write(session) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv)
  cipher.setAAD(Buffer.from(JSON.stringify(['es2api-codex-refresh-v1', session.vmId, session.id])))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session.data)), cipher.final()])
  const envelope = JSON.stringify({ version: 1, vm_id: session.vmId, id: session.id,
    iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }) + '\n'
  if (Buffer.byteLength(envelope) > 4 * 1024 * 1024) throw fail('codex_refresh_storage_unavailable')
  const temp = path.join(session.root, `.${session.vmId}.${crypto.randomUUID()}.tmp`)
  let fd
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    fs.writeFileSync(fd, envelope); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
    fs.renameSync(temp, session.file); syncDirectory(session.root)
  } catch { throw fail('codex_refresh_storage_unavailable') }
  finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw fail('codex_refresh_storage_unavailable') }
  }
}
export function assertNoPendingCodexRefresh(projectRoot, vmId) {
  try {
    const loc = location(projectRoot, vmId); regular(loc.file)
    if (commits.getStore()?.file !== loc.file) throw fail()
  } catch (e) { if (e.code === 'ENOENT') return; throw e.code === 'codex_refresh_recovery_required' ? e : fail() }
}
export function inCodexRefreshCommit(projectRoot, vmId) {
  return commits.getStore()?.file === location(projectRoot, vmId).file
}
export function beginCodexRefresh(projectRoot, vmId, data) {
  assertNoPendingCodexRefresh(projectRoot, vmId); secretKey()
  const loc = location(projectRoot, vmId, true); syncDirectory(path.dirname(loc.root))
  const session = { ...loc, id: crypto.randomUUID(), data: { ...data, phase: 'prepared', at: new Date().toISOString() } }
  sessions.add(session); write(session); return session
}
export function captureCodexRefresh(session, response) {
  if (!sessions.has(session)) throw fail()
  session.data = { ...session.data, phase: 'received', received_at: new Date().toISOString(), response }; write(session)
}
export function readPendingCodexRefresh(projectRoot, vmId) {
  const loc = location(projectRoot, vmId)
  try {
    regular(loc.file)
    const value = JSON.parse(fs.readFileSync(loc.file, 'utf8'))
    if (value.version !== 1 || value.vm_id !== vmId || !/^[a-f0-9-]{36}$/.test(value.id || '')) throw fail()
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(value.iv, 'base64url'))
    decipher.setAAD(Buffer.from(JSON.stringify(['es2api-codex-refresh-v1', vmId, value.id])))
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'))
    const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8'))
    const session = { ...loc, id: value.id, data }; sessions.add(session); return session
  } catch { throw fail() }
}

function recoveryState(data) {
  if (data?.phase === 'prepared') return 'prepared'
  if (data?.phase !== 'received') return 'unreadable'
  return data.response?.ok === true && typeof data.response.access_token === 'string' && !!data.response.access_token.trim()
    ? 'received' : 'incomplete'
}

// Read-only status, never a token/identity proof. A saved response still needs
// signature, owner and full-record checks before it can be committed.
export function codexRefreshStatus(projectRoot, vmId) {
  try {
    const loc = location(projectRoot, vmId)
    try { regular(loc.file) }
    catch (error) { if (error.code === 'ENOENT') return { pending: false, state: 'none', recovery_available: false }; throw error }
    const session = readPendingCodexRefresh(projectRoot, vmId)
    const state = recoveryState(session.data)
    sessions.delete(session)
    return { pending: true, state, recovery_available: state === 'received' }
  } catch { return { pending: true, state: 'unreadable', recovery_available: false } }
}

export function assertCodexRefreshResponseRecoverable(session) {
  if (!sessions.has(session)) throw fail()
  const state = recoveryState(session.data)
  if (state === 'received') return
  const code = state === 'prepared' ? 'codex_refresh_outcome_unknown'
    : state === 'incomplete' ? 'codex_refresh_response_incomplete' : 'codex_refresh_storage_unavailable'
  throw Object.assign(new Error(state === 'prepared'
    ? '未保存可恢复的换票响应，无法确认刷新令牌是否已被消费；凭据和日志已保留，不会再次换票'
    : state === 'incomplete' ? '保存的换票响应不完整，未覆盖原凭据或再次换票；请保留日志交由管理员处理'
      : '换票记录无法确认，请检查私密存储与原加密密钥；未清除日志或重试换票'), { status: 409, code })
}

export function commitCodexRefresh(session, credentialFile, operation) {
  if (!sessions.has(session) || session.data.phase !== 'received') throw fail()
  return commits.run(session, () => {
    const result = operation(); regular(credentialFile)
    const fd = fs.openSync(credentialFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    syncDirectory(path.dirname(credentialFile))
    const target = path.join(session.root, `${session.vmId}.${session.id}.resolved.json`)
    if (fs.existsSync(target)) throw fail()
    fs.renameSync(session.file, target); syncDirectory(session.root); sessions.delete(session); return result
  })
}
