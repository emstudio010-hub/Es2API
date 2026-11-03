/** Real Codex exec inside the account's Docker slot. No host CLI or host auth. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { slotHost, hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../vm/codex-slot.mjs'
import { withCodexCredentialLock, assertCodexCredentialNotHandingOff } from '../oauth/codex-credential-lock.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import { withCodexKernelCredentialOwner } from '../oauth/codex-kernel-credential-owner.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { CODEX_CLI_CONTAINER_BIN, CODEX_CLI_VERSION, inspectCodexCliPayload } from '../vm/codex-cli-config.mjs'
import { codexCliJobs as active, codexCliInMaintenance } from './codex-cli-state.mjs'
import { codexCliInstructionConfig } from './codex-cli-request-config.mjs'

const runFile = promisify(execFile)
const TIMEOUT_MS = 300000
const MAX_BYTES = 4 * 1024 * 1024
const errorResult = (status, code, message) => ({ ok: false, status, committed: false, terminalState: 'failed', body: { error: { type: status === 400 ? 'invalid_request_error' : 'api_error', code, message } } })
const fail = (field) => { throw Object.assign(new Error(`Codex CLI 文本执行暂不支持参数：${field}`), { status: 400, code: 'codex_cli_unsupported_parameter' }) }

// Validate raw input too: protocol conversion must not silently erase unsupported fields.
export function codexCliRequest(body = {}, raw = body) {
  const supportedFields = new Set(['model', 'input', 'messages', 'instructions', 'reasoning', 'reasoning_effort', 'stream', 'store', 'metadata', 'user', 'stream_options', 'prompt_cache_key', 'prompt_cache_retention', 'session_id', 'conversation_id', 'tools', 'tool_choice', 'parallel_tool_calls'])
  for (const key of Object.keys(raw)) if (!supportedFields.has(key) && raw[key] != null) fail(key)
  if (raw.messages != null && !Array.isArray(raw.messages)) fail('messages')
  if (raw.prompt_cache_key != null || raw.prompt_cache_retention != null) fail('prompt_cache_key/prompt_cache_retention')
  for (const message of raw.messages || []) {
    if (!['user', 'assistant', 'system', 'developer'].includes(message?.role) || message.name || message.tool_calls || message.function_call) fail('messages')
    if (typeof message.content !== 'string' && (!Array.isArray(message.content) || message.content.some(part => part?.type !== 'text' || typeof part.text !== 'string'))) fail('messages.content')
  }
  for (const input of [raw, body]) {
    for (const field of ['tools', 'functions', 'include', 'attachments']) if (input[field]?.length) fail(field)
    for (const field of ['previous_response_id', 'conversation', 'max_output_tokens', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'response_format', 'text', 'service_tier', 'priority', 'fast', 'ultrafast', 'seed', 'logprobs', 'top_logprobs', 'logit_bias', 'presence_penalty', 'frequency_penalty', 'truncation', 'prompt', 'background', 'audio', 'modalities', 'prediction', 'web_search_options', 'safety_identifier']) {
      if (input[field] != null && input[field] !== false) fail(field)
    }
    if (input.n != null && input.n !== 1) fail('n')
    if (input.store === true) fail('store')
    if (input.tool_choice != null && input.tool_choice !== 'none') fail('tool_choice')
    if (input.function_call != null && input.function_call !== 'none') fail('function_call')
    if (input.parallel_tool_calls === true) fail('parallel_tool_calls')
    if (input.reasoning && (Object.keys(input.reasoning).some(key => key !== 'effort') || (input.reasoning.effort != null && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.reasoning.effort)))) fail('reasoning')
    if (input.reasoning_effort != null && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.reasoning_effort)) fail('reasoning_effort')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(body.model || '')) fail('model')
  let effort = body.reasoning?.effort ?? body.reasoning_effort
  if (body.reasoning && Object.keys(body.reasoning).some(key => key !== 'effort')) fail('reasoning')
  if (effort != null && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) fail('reasoning.effort')
  let items = body.input
  if (typeof items === 'string') items = [{ role: 'user', content: items }]
  if (!Array.isArray(items) || !items.length) fail('input')
  const parts = []
  const instructions = []
  if ((body.instructions ?? raw.instructions) != null) {
    if (typeof (body.instructions ?? raw.instructions) !== 'string') fail('instructions')
    instructions.push(body.instructions ?? raw.instructions)
  }
  let userCount = 0
  for (const item of items) {
    if (!item || (item.type && item.type !== 'message') || !['user', 'assistant', 'system', 'developer'].includes(item.role)) fail('input item')
    const content = typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : item.content
    if (!Array.isArray(content) || content.some(part => !['input_text', 'output_text', 'text'].includes(part?.type) || typeof part.text !== 'string')) fail('input.content')
    const text = content.map(part => part.text).join('\n')
    if (item.role === 'system' || item.role === 'developer') instructions.push(text)
    else { parts.push({ role: item.role, text }); if (item.role === 'user') userCount++ }
  }
  if (!userCount) fail('user input')
  // Exec has one input turn. Full conversation is explicitly supplied as a transcript;
  // no upstream response IDs or persistent CLI sessions are invented.
  const prompt = parts.length === 1 && parts[0].role === 'user' ? parts[0].text
    : `Continue the conversation supplied in this JSON transcript. Answer the last user message.\n${JSON.stringify(parts)}`
  const developerInstructions = instructions.join('\n\n')
  if (!prompt.isWellFormed() || !developerInstructions.isWellFormed()) fail('invalid Unicode text')
  if (Buffer.byteLength(prompt) + Buffer.byteLength(developerInstructions) > 1024 * 1024) fail('input size > 1 MiB')
  return { prompt, instructions: developerInstructions, effort, model: body.model }
}

function supported(exec) {
  return exec?.vm?.id && slotHost(exec.vm).kind === 'local' && !isKvmRuntime(exec.vm) && exec.vm.proxy?.id && !isLocalEgressProxy(exec.vm.proxy) && !!hostProxyUrlForVm(exec.vm)
}
function projectOf(exec) { return path.dirname(path.dirname(path.dirname(exec.homeDir))) }
function requestsRoot(exec) { return path.join(exec.homeDir, '.es2api-requests') }

function accessExpiry(account) {
  let expiry = Number(account?.expires_at) || Date.parse(account?.expires_at || '') || 0
  if (expiry > 0 && expiry < 1e12) expiry *= 1000
  try {
    const jwtExpiry = Number(JSON.parse(Buffer.from(account.access_token.split('.')[1], 'base64url')).exp)
    if (Number.isFinite(jwtExpiry) && jwtExpiry > 0) expiry = jwtExpiry * 1000
  } catch {}
  return Number.isFinite(expiry) ? expiry : 0
}

function needsAccessRefresh(account) {
  return !account?.access_token || accessExpiry(account) < Date.now() + TIMEOUT_MS + 60000
}

export async function codexCliHealth(exec, { timeoutMs = 5000 } = {}) {
  if (!supported(exec)) return { ok: false, reachable: false, code: 'codex_cli_requires_local_dedicated_docker' }
  try { assertCodexCredentialNotHandingOff(projectOf(exec), exec.vm.id) }
  catch (error) { return { ok: false, reachable: false, status: 409, code: error.code || 'codex_credential_unavailable' } }
  const payload = inspectCodexCliPayload()
  if (!payload.ok) return { ok: false, reachable: false, code: payload.code }
  const accounts = readCodexAccounts(projectOf(exec), exec.vm.id)
  if (accounts.length !== 1 || !accounts[0].id_token || !accounts[0].chatgpt_account_id || (!accounts[0].access_token && !accounts[0].refresh_token)) return { ok: false, reachable: false, code: 'codex_cli_identity_required', status: 503 }
  if (needsAccessRefresh(accounts[0]) && !accounts[0].refresh_token) return { ok: false, reachable: false, code: 'codex_cli_refresh_required', status: 503 }
  try {
    for (const entry of fs.readdirSync(requestsRoot(exec))) {
      if (/^req-[a-f0-9-]+$/.test(entry) && !active.has(exec.vmId) && !fs.existsSync(path.join(requestsRoot(exec), entry, 'done'))) return { ok: false, reachable: false, code: 'codex_cli_previous_run_unconfirmed', status: 503 }
    }
  } catch (error) { if (error.code !== 'ENOENT') return { ok: false, reachable: false, code: 'codex_cli_state_unreadable', status: 503 } }
  try {
    const result = await runFile('docker', slotExecArgv(exec.vm, [CODEX_CLI_CONTAINER_BIN, '--version'], { user: slotHost(exec.vm).execUser(exec.vm) }), { timeout: timeoutMs, maxBuffer: 4096, windowsHide: true })
    const ok = result.stdout.trim() === `codex-cli ${CODEX_CLI_VERSION}`
    return { ok, reachable: ok, status: ok ? 200 : 503, code: ok ? null : 'codex_cli_version_mismatch', ...(ok ? { version: CODEX_CLI_VERSION } : {}), backend: 'codex-cli' }
  } catch { return { ok: false, reachable: false, code: 'codex_cli_not_ready', status: 503 } }
}

export const ensureCodexCli = codexCliHealth

// The request copy deliberately has no rotating refresh token. Refresh is owned by
// the control plane, never concurrently by an ephemeral CLI and the quota worker.
export async function refreshCliCredential(projectRoot, vm, { force = false, deadline = Infinity, signal } = {}) {
  if (!supported({ vm })) throw Object.assign(new Error('CLI 固定出口不可用，已停止刷新'), { code: 'codex_cli_proxy_required' })
  return withCodexCredentialLock(projectRoot, vm.id, () => withCodexKernelCredentialOwner(projectRoot, vm.id, async () => {
    if (signal?.aborted) throw Object.assign(new Error('CLI 请求已取消，未开始刷新'), { code: 'codex_cli_cancelled' })
    if (Date.now() >= deadline) throw Object.assign(new Error('CLI 执行预算已用尽，未开始刷新'), { code: 'codex_cli_timeout' })
    const accounts = readCodexAccounts(projectRoot, vm.id)
    if (accounts.length !== 1) throw Object.assign(new Error('Codex CLI 要求每槽恰好一个 OAuth 账号'), { code: 'codex_cli_account_count' })
    let account = accounts[0]
    if (force || needsAccessRefresh(account)) {
      if (!account.refresh_token) throw Object.assign(new Error('OAuth 需要刷新；请重新导入含刷新令牌的凭据'), { code: 'codex_cli_refresh_required' })
      const usedRefresh = account.refresh_token
      const token = await refreshCodexAccessToken({ refreshToken: usedRefresh, proxyUrl: hostProxyUrlForVm(vm), timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())) })
      if (!token.ok || !token.access_token) throw Object.assign(new Error('OAuth 刷新失败，请在账号管理中检查凭据'), { code: Date.now() >= deadline ? 'codex_cli_timeout' : 'codex_cli_refresh_failed' })
      const current = readCodexAccounts(projectRoot, vm.id)
      const latest = current[0]
      if (current.length !== 1 || latest?.refresh_token !== usedRefresh || latest?.access_token !== account.access_token) throw Object.assign(new Error('凭据已在其他操作中变化，请重试'), { code: 'codex_cli_credential_changed' })
      upsertCodexAccount(projectRoot, vm.id, { access_token: token.access_token, refresh_token: token.refresh_token || usedRefresh, id_token: token.id_token || account.id_token, expires_at: token.expires_at || account.expires_at })
      account = readCodexAccounts(projectRoot, vm.id)[0]
    }
    if (!account.id_token || !account.chatgpt_account_id) throw Object.assign(new Error('Codex CLI 需要 id_token 与 ChatGPT account ID，请补全 OAuth 文件'), { code: 'codex_cli_identity_required' })
    return account
  }, { timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())) }))
}

// This supervisor lives inside the slot. It kills the entire CLI process group on
// timeout, cancellation, or loss of the host heartbeat (including host crashes).
const RUNNER = String.raw`import os,sys,time,signal,subprocess,threading
root=sys.argv[1]
limit=int(sys.argv[2])
try:
    proc=subprocess.Popen(sys.argv[3:],start_new_session=True)
except OSError:
    # No child process exists. Mark the request confirmed rather than leaving
    # an unrecoverable-looking request directory after an exec setup failure.
    open(root+'/done','w').close()
    sys.exit(126)
ended=threading.Event()
def kill_group():
    try: os.killpg(proc.pid,signal.SIGTERM)
    except ProcessLookupError: return
    if not ended.wait(2):
        try: os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError: pass
def watch():
    start=time.monotonic(); last=start; prev=None
    while not ended.wait(.2):
        try: stamp=os.stat(root+'/heartbeat').st_mtime_ns
        except OSError: stamp=None
        now=time.monotonic()
        if stamp!=prev: prev=stamp; last=now
        if os.path.exists(root+'/cancel') or now-start>limit or now-last>20:
            kill_group(); return
threading.Thread(target=watch,daemon=True).start()
try:
    rc=proc.wait()
finally:
    ended.set()
    try: os.killpg(proc.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    open(root+'/done','w').close()
sys.exit(rc if rc>=0 else 128-rc)
`

export function cancelCodexCli(vmId) {
  const job = active.get(vmId)
  if (job) job.cancel('codex_cli_cancelled')
  return !!job
}

export async function streamCodexCli({ exec, signal, body, rawBody, onEvent } = {}) {
  const started = Date.now()
  const deadline = started + TIMEOUT_MS
  let request
  try { request = codexCliRequest(body, rawBody || body) } catch (error) { return errorResult(400, error.code, error.message) }
  if (!supported(exec)) return errorResult(503, 'codex_cli_requires_local_dedicated_docker', 'Codex CLI 需要本机 Docker 与固定非直连出口')
  if (codexCliInMaintenance(exec.vmId)) return errorResult(503, 'codex_cli_maintenance', 'CLI 实例正在维护，暂不接收调用')
  if (signal?.aborted) return errorResult(499, 'client_cancelled', '请求已取消')
  if (active.has(exec.vmId)) return errorResult(429, 'codex_cli_busy', '此账号的 Codex CLI 正在执行，请稍后重试')
  const root = requestsRoot(exec)
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    // Leftovers after a host crash may still be winding down. Never delete a
    // live child's auth or start another turn while its outcome is unknown.
    for (const entry of fs.readdirSync(root)) {
      if (!/^req-[a-f0-9-]+$/.test(entry)) continue
      const old = path.join(root, entry)
      if (!fs.existsSync(path.join(old, 'done'))) return errorResult(503, 'codex_cli_previous_run_unconfirmed', '上次 CLI 进程尚未确认退出，请检查实例后恢复')
      fs.rmSync(old, { recursive: true, force: true })
    }
  } catch { return errorResult(503, 'codex_cli_state_unreadable', 'CLI 请求目录不可用，请在实例中检查并恢复') }
  const id = `req-${crypto.randomUUID()}`
  const dir = path.join(root, id)
  const guest = `/home/kincli/.es2api-requests/${id}`
  let failure = null, child, heartbeat, timeout, hardTimeout, cancelTimeout, emitted = false, firstTokenAt = null
  let completed = false, usage = null, text = '', closed = false
  const cancel = code => {
    failure ||= code
    try { fs.writeFileSync(path.join(dir, 'cancel'), '') } catch {}
    if (child && !cancelTimeout) cancelTimeout = setTimeout(() => { clearInterval(heartbeat); child.kill() }, 25000)
  }
  active.set(exec.vmId, { cancel })
  const abort = () => cancel('client_cancelled')
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const account = await refreshCliCredential(projectOf(exec), exec.vm, { deadline, signal })
    if (signal?.aborted) return errorResult(499, 'client_cancelled', '请求已取消')
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.mkdirSync(path.join(dir, 'work'), { mode: 0o700 })
    fs.mkdirSync(path.join(dir, 'home'), { mode: 0o700 })
    // A request-owned config avoids Linux's single-argument length limit and
    // keeps caller instructions out of process argv. No account/home config is copied.
    fs.writeFileSync(path.join(dir, 'home', 'config.toml'), codexCliInstructionConfig(request.instructions), { mode: 0o400, flag: 'wx' })
    fs.writeFileSync(path.join(dir, 'home', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: account.id_token, access_token: account.access_token, refresh_token: '', account_id: account.chatgpt_account_id }, last_refresh: new Date().toISOString() }), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'heartbeat'), '')
    const user = slotHost(exec.vm).execUser(exec.vm)
    if (process.platform !== 'win32') {
      const [uid, gid] = user.split(':').map(Number)
      for (const target of [root, dir, path.join(dir, 'work'), path.join(dir, 'home'), path.join(dir, 'home', 'config.toml'), path.join(dir, 'home', 'auth.json'), path.join(dir, 'heartbeat')]) fs.chownSync(target, uid, gid)
    }
    if (signal?.aborted || failure) return errorResult(499, 'client_cancelled', '请求已取消')
    const remaining = deadline - Date.now()
    if (remaining <= 0) return errorResult(504, 'codex_cli_timeout', 'CLI 执行预算已用尽，未启动推理')
    // CODEX_HOME contains only our generated config and short-lived auth copy.
    // --ignore-user-config would discard the request's developer instructions.
    const argv = [CODEX_CLI_CONTAINER_BIN, 'exec', '--json', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '-C', `${guest}/work`, '-m', request.model]
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_host', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'memories', 'hooks', 'in_app_browser', 'in_app_local_automation', 'in_app_chat', 'workspace_dependencies', 'goals']) argv.push('--disable', feature)
    for (const config of ['web_search="disabled"', 'cli_auth_credentials_store="file"', 'model_provider="openai"', 'model_providers.openai.request_max_retries=0', 'model_providers.openai.stream_max_retries=0', 'model_providers.openai.supports_websockets=false', 'mcp_servers={}', 'analytics.enabled=false', 'feedback.enabled=false']) argv.push('-c', config)
    if (request.effort) argv.push('-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`)
    argv.push('-')
    const args = slotExecArgv(exec.vm, ['python3', '-c', RUNNER, guest, String(Math.max(1, Math.floor(remaining / 1000))), ...argv], { interactive: true, user, workdir: `${guest}/work`, env: { CODEX_HOME: `${guest}/home`, HOME: guest, XDG_CONFIG_HOME: `${guest}/config`, XDG_CACHE_HOME: `${guest}/cache`, RUST_LOG: 'off' } })
    child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stdin.on('error', () => {})
    child.stdin.end(request.prompt)
    child.stderr.resume() // Never persist raw CLI diagnostics or upstream error bodies.
    heartbeat = setInterval(() => { try { const now = new Date(); fs.utimesSync(path.join(dir, 'heartbeat'), now, now) } catch {} }, 3000)
    timeout = setTimeout(() => cancel('codex_cli_timeout'), remaining)
    hardTimeout = setTimeout(() => { cancel('codex_cli_timeout'); clearInterval(heartbeat); child.kill() }, remaining + 30000)
    let bytes = 0, pending = '', queue = Promise.resolve()
    const decoder = new StringDecoder('utf8')
    const responseId = `resp_cli_${crypto.randomUUID().replaceAll('-', '')}`
    const messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`
    let sequence = 0
    const emit = async value => { emitted = true; await onEvent?.(`data: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`) }
    const eventLine = async line => {
      if (failure || !line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { cancel('codex_cli_invalid_jsonl'); return }
      if (event.type === 'turn.failed' || event.type === 'error') { cancel('codex_cli_turn_failed'); return }
      if (event.item && !['agent_message', 'reasoning'].includes(event.item.type)) { cancel('codex_cli_tool_execution_unsupported'); return }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (typeof event.item.text !== 'string' || completed) { cancel('codex_cli_invalid_jsonl'); return }
        if (!emitted) {
          await emit({ type: 'response.created', response: { id: responseId, object: 'response', model: request.model, status: 'in_progress', output: [] } })
          await emit({ type: 'response.output_item.added', output_index: 0, item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
          await emit({ type: 'response.content_part.added', output_index: 0, item_id: messageId, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        }
        const delta = (text ? '\n\n' : '') + event.item.text
        text += delta
        firstTokenAt ||= Date.now()
        await emit({ type: 'response.output_text.delta', output_index: 0, item_id: messageId, content_index: 0, delta })
      }
      if (event.type === 'turn.completed') {
        if (completed || !Number.isSafeInteger(event.usage?.input_tokens) || !Number.isSafeInteger(event.usage?.output_tokens)) { cancel('codex_cli_usage_missing'); return }
        const input = event.usage.input_tokens, output = event.usage.output_tokens, cached = event.usage.cached_input_tokens ?? 0
        const reasoning = event.usage.reasoning_output_tokens
        if (input < 0 || output < 0 || !Number.isSafeInteger(input + output) || !Number.isSafeInteger(cached) || cached < 0 || cached > input || (reasoning != null && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output))) { cancel('codex_cli_usage_invalid'); return }
        completed = true
        usage = { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: cached } }
        if (reasoning != null) usage.output_tokens_details = { reasoning_tokens: reasoning }
      }
    }
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_BYTES) { cancel('codex_cli_output_limit'); return }
      pending += decoder.write(chunk)
      const lines = pending.split('\n'); pending = lines.pop()
      for (const line of lines) queue = queue.then(() => eventLine(line)).catch(() => cancel('codex_cli_delivery_failed'))
    })
    const exit = await new Promise(resolve => {
      child.once('error', () => resolve(-1))
      child.once('close', code => { closed = true; resolve(code) })
    })
    pending += decoder.end()
    await queue
    if (pending.trim()) await eventLine(pending)
    if (!failure && (exit !== 0 || !completed || !text || !usage)) failure = 'codex_cli_incomplete'
    if (failure) {
      const result = errorResult(failure === 'client_cancelled' ? 499 : failure === 'codex_cli_timeout' ? 504 : 502, failure, 'Codex CLI 执行未完成，请在实例中检查状态；本次未自动重试')
      if (emitted) await emit({ type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', error: result.body.error, usage } })
      return { ...result, committed: emitted, usage, firstTokenAt }
    }
    const part = { type: 'output_text', text, annotations: [] }
    const item = { id: messageId, type: 'message', status: 'completed', role: 'assistant', content: [part] }
    const response = { id: responseId, object: 'response', created_at: Math.floor(started / 1000), model: request.model, status: 'completed', output: [item], usage }
    await emit({ type: 'response.output_text.done', output_index: 0, item_id: messageId, content_index: 0, text })
    await emit({ type: 'response.content_part.done', output_index: 0, item_id: messageId, content_index: 0, part })
    await emit({ type: 'response.output_item.done', output_index: 0, item })
    await emit({ type: 'response.completed', response })
    return { ok: true, status: 200, committed: true, terminalState: 'verified', body: response, usage, firstTokenAt, ttftMs: firstTokenAt - started }
  } catch (error) {
    const code = failure || (/^codex_cli_[a-z_]+$/.test(error.code || '') ? error.code : 'codex_cli_execution_failed')
    cancel(code)
    // Do not expose spawn stderr, paths, argv, auth or network diagnostics.
    return { ...errorResult(code === 'codex_cli_timeout' ? 504 : signal?.aborted || code === 'codex_cli_cancelled' || code === 'client_cancelled' ? 499 : 503, code, 'Codex CLI 准备或执行失败，请检查实例与 OAuth 状态'), committed: emitted, usage, firstTokenAt, ttftMs: firstTokenAt == null ? null : firstTokenAt - started }
  } finally {
    clearInterval(heartbeat); clearTimeout(timeout); clearTimeout(hardTimeout); clearTimeout(cancelTimeout)
    signal?.removeEventListener('abort', abort)
    active.delete(exec.vmId)
    // A crashed Docker client is not proof the in-container process exited.
    if (!child || (closed && fs.existsSync(path.join(dir, 'done')))) {
      try { fs.rmSync(dir, { recursive: true, force: true }) }
      catch { console.warn('[codex-cli] completed_request_cleanup_failed') }
    }
  }
}
