import http from 'node:http'
import crypto from 'node:crypto'

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function readJson(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('请求体超过大小限制'), { status: 413, code: 'body_too_large' })
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('请求体顶层必须为 JSON 对象'), { status: 400, code: 'invalid_json_shape' })
    }
    return body
  } catch (error) {
    if (error?.status) throw error
    throw Object.assign(new Error('请求体不是有效 JSON'), { status: 400, code: 'invalid_json' })
  }
}

function send(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(data)
}

function success(res, status, data) { return send(res, status, { ok: true, data }) }

export function createIntegrationServer({ store, accountPool, modeltrace, managementToken, gateway, maxBodyBytes = 10 * 1024 * 1024 }) {
  if (!store || !accountPool || !modeltrace || !managementToken) throw new TypeError('store, accountPool, modeltrace, and managementToken are required')
  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID()
    res.setHeader('x-request-id', requestId)
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const execution = url.pathname.match(/^\/gateway\/([a-zA-Z0-9._:-]{1,160})\/v1\/(models|responses(?:\/compact)?|chat\/completions)$/)
      if (execution && gateway) return await gateway(req, res, execution[1], execution[2])
      if (req.method === 'GET' && url.pathname === '/health') {
        return success(res, 200, { service: 'es2api-integration', status: 'ready', vm2_configured: Boolean(modeltrace.runner) })
      }
      const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]
      if (!sameSecret(bearer, managementToken)) return send(res, 401, { ok: false, error: { code: 'unauthorized', message: '管理认证失败' } })

      let match
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/accounts') {
        return success(res, 200, accountPool.listAccounts(Object.fromEntries(url.searchParams)))
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/pool/stats') {
        return success(res, 200, accountPool.poolStats({
          group_id: url.searchParams.get('group_id') || undefined,
          mode: url.searchParams.get('mode') || undefined,
        }))
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/pool/acquire') {
        const body = await readJson(req, maxBodyBytes)
        return success(res, 200, accountPool.acquireRequest({
          request_id: body.request_id,
          account_id: body.account_id,
          group_ids: body.group_ids,
          mode: body.mode,
        }))
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/pool/release') {
        const body = await readJson(req, maxBodyBytes)
        return success(res, 200, accountPool.releaseRequest(body.request_id, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/accounts') {
        const body = await readJson(req, maxBodyBytes)
        const account = await accountPool.importAccount(body, { idempotencyKey: req.headers['idempotency-key'] })
        return success(res, 201, account)
      }
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/accounts\/([^/]+)$/))) {
        const id = decodeURIComponent(match[1])
        if (req.method === 'GET') return success(res, 200, accountPool.getAccount(id))
        if (req.method === 'PUT') return success(res, 200, accountPool.updateAccount(id, await readJson(req, maxBodyBytes)))
        if (req.method === 'DELETE') return success(res, 200, await accountPool.removeAccount(id))
      }
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/(retry|retry-delete)$/)) && req.method === 'POST') {
        const id = decodeURIComponent(match[1])
        return success(res, 200, match[2] === 'retry' ? await accountPool.retryProvision(id) : await accountPool.retryDelete(id))
      }
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/sync$/)) && req.method === 'POST') {
        return success(res, 200, await accountPool.syncAccount(decodeURIComponent(match[1])))
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/groups') return success(res, 200, accountPool.listGroups())
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/groups') return success(res, 201, accountPool.createGroup(await readJson(req, maxBodyBytes)))
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/groups\/([^/]+)$/))) {
        const id = decodeURIComponent(match[1])
        if (req.method === 'PUT') return success(res, 200, accountPool.updateGroup(id, await readJson(req, maxBodyBytes)))
        if (req.method === 'DELETE') return success(res, 200, accountPool.deleteGroup(id))
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/admin/modeltrace/config') return success(res, 200, modeltrace.getGlobalConfig())
      if (req.method === 'PUT' && url.pathname === '/api/v1/admin/modeltrace/config') {
        return success(res, 200, modeltrace.configureGlobal(await readJson(req, maxBodyBytes)))
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/modeltrace/bank') return success(res, 200, modeltrace.bank())
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/modeltrace/summary') return success(res, 200, modeltrace.summary())
      if (req.method === 'PUT' && url.pathname === '/api/v1/admin/modeltrace/bank') {
        return success(res, 200, modeltrace.installBank(await readJson(req, maxBodyBytes)))
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/modeltrace/run') {
        const body = await readJson(req, maxBodyBytes)
        const run = modeltrace.run(String(body.account_id || ''))
        return success(res, 202, run)
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/admin/modeltrace/runs') {
        return success(res, 200, store.listRuns({ account_id: url.searchParams.get('account_id') || undefined,
          status: url.searchParams.get('status') || undefined,
          reason: url.searchParams.get('reason') || undefined,
          model: url.searchParams.get('model') || undefined,
          page: url.searchParams.get('page'), page_size: url.searchParams.get('page_size') }))
      }
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/modeltrace\/runs\/([^/]+)$/)) && req.method === 'GET') {
        const run = store.getRun(decodeURIComponent(match[1]))
        if (!run) throw Object.assign(new Error('检测记录不存在'), { status: 404, code: 'trace_run_not_found' })
        return success(res, 200, run)
      }
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/modeltrace\/runs\/([^/]+)\/cancel$/)) && req.method === 'POST') {
        const runId = decodeURIComponent(match[1])
        const run = store.getRun(runId)
        if (!run) throw Object.assign(new Error('检测记录不存在'), { status: 404, code: 'trace_run_not_found' })
        return success(res, 200, { canceled: modeltrace.cancel(run.account_id, run.id) })
      }
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/modeltrace$/))) {
        const id = decodeURIComponent(match[1])
        if (req.method === 'GET') {
          const account = accountPool.getAccount(id)
          return success(res, 200, { account_id: id, overrides: account.modeltrace.overrides,
            effective_config: modeltrace.getAccountConfig(account), state: account.modeltrace.state, readiness: modeltrace.readiness(account), automation: modeltrace.automation(account) })
        }
        if (req.method === 'PUT') return success(res, 200, modeltrace.configureAccount(id, await readJson(req, maxBodyBytes)))
      }
      if ((match = url.pathname.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/modeltrace\/reset-action$/)) && req.method === 'POST') {
        const account = accountPool.getAccount(decodeURIComponent(match[1]))
        const prior = account.modeltrace.state
        const state = { ...prior, auto_paused: false, deprioritized: false, consecutive: 0, evidence_context: null }
        const fields = { modeltrace_state: state }
        if (prior.auto_paused && typeof prior.original_schedulable === 'boolean' && account.status === 'ready') fields.schedulable = prior.original_schedulable
        if (prior.deprioritized && Number.isInteger(prior.original_priority)) fields.priority = prior.original_priority
        delete state.original_schedulable
        delete state.original_priority
        return success(res, 200, store.updateAccount(account.id, fields))
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/usage/success') {
        const body = await readJson(req, maxBodyBytes)
        const result = await modeltrace.recordUsage({ account_id: body.account_id, model: body.model,
          vm_id: body.vm_id, event_id: body.event_id, source: body.source,
          upstream_model: body.upstream_model, success: body.success === true })
        return success(res, 200, { trace_run: result })
      }

      return send(res, 404, { ok: false, error: { code: 'not_found', message: '接口不存在' } })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      const code = String(error?.code || 'internal_error').slice(0, 80)
      const message = status >= 500 && !error?.code ? '服务内部错误' : String(error?.message || '请求失败').slice(0, 500)
      return send(res, status, { ok: false, error: { code, message, request_id: requestId } })
    }
  })
  return server
}
