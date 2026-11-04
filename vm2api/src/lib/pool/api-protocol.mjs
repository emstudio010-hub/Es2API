import { createSseBuffer, readSseLines, writeDownstream, STREAM_PENDING_BYTES } from '../transport/stream-flow.mjs'
import { canonicalApiPolicyBody, apiPolicyToAnthropic, isApiPolicyInputError } from './api-policy-tools.mjs'
import { prepareClassifierBody } from '../protocol/request-purpose.mjs'
import { consumeClaudeSSEData } from '../protocol/convert.mjs'
import { isCompleteAssistantMessage, mapUpstreamError, clientCancelledResult } from '../core/errors.mjs'
import { isContentPolicyErrorCode } from '../core/refusal-guard.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { messagesUrl, normalizeProtocol, resolvePreset, responsesUrl, upstreamAuthHeaders } from './api-presets.mjs'
import { claudeToOpenAIResponsesRequest } from './api-openai.mjs'
import {
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  createChatSseState,
  responsesSseToAnthropicEvents,
  isToolArgumentsError,
  responsesSseToChatChunk,
} from '../protocol/codex-convert.mjs'
import { usageFromSseLine } from '../protocol/handle-codex.mjs'
import { finishChatSse, isCodexChatStreamError } from '../protocol/codex-chat-stream.mjs'
import { codexBodyToChatCompletion, isCodexChatResponseError } from '../protocol/codex-chat-response.mjs'
import { BETA_CONTEXT_1M } from '../protocol/claude-code-betas.mjs'
import { shouldPassContext1mByPolicy } from '../protocol/model-policy.mjs'
import { hasCustomChatTools, isCodexChatInputError } from '../protocol/codex-chat-input.mjs'

export function resolveInferenceBackend(req) {
  if (req?.apiKeyKind !== 'managed') return 'oauth'
  return String(req.apiKeyRecord?.category || '')
    .trim()
    .toLowerCase() === 'api'
    ? 'api'
    : 'oauth'
}

export { messagesUrl, responsesUrl } from './api-presets.mjs'

function joinHeaderMap(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v == null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * Native Anthropic Messages is a compatibility boundary.  Keep protocol
 * headers supplied by the caller, including beta names this gateway does not
 * know yet.  Headers the operator configured on the endpoint win; anthropic-beta
 * is the union of endpoint and caller tokens so neither opt-in is dropped.
 */
function forwardAnthropicProtocolHeaders(headers = {}, protocol = '', protocolKind = '') {
  if (protocol !== 'anthropic.messages' || protocolKind !== 'anthropic') return {}
  const out = {}
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '').toLowerCase()
    if (
      !name.startsWith('anthropic-') &&
      !name.startsWith('x-claude-code-') &&
      !name.startsWith('x-stainless-') &&
      name !== 'x-app' &&
      name !== 'x-client-request-id' &&
      name !== 'user-agent' &&
      name !== 'accept-language' &&
      name !== 'sec-fetch-mode'
    )
      continue
    if (rawValue == null || rawValue === '') continue
    out[name] = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue)
  }
  return out
}

function splitBetas(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Caller context-1m follows the model-page 1M policy, same as the slot path. */
function callerBetaTokens(value, model) {
  const tokens = splitBetas(value)
  if (!tokens.includes(BETA_CONTEXT_1M) || shouldPassContext1mByPolicy(model)) return tokens
  return tokens.filter((t) => t !== BETA_CONTEXT_1M)
}

function mergeCallerProtocolHeaders(base = {}, caller = {}, configured = {}, model = '') {
  const out = { ...base }
  const configuredNames = new Set(Object.keys(configured).map((k) => k.toLowerCase()))
  for (const [name, value] of Object.entries(caller)) {
    const existing = Object.keys(out).filter((k) => k.toLowerCase() === name)
    if (name === 'anthropic-beta') {
      const merged = new Set([...existing.flatMap((k) => splitBetas(out[k])), ...callerBetaTokens(value, model)])
      for (const k of existing) delete out[k]
      if (merged.size) out[name] = [...merged].join(',')
      continue
    }
    if (configuredNames.has(name)) continue
    for (const k of existing) delete out[k]
    out[name] = value
  }
  return out
}

function openAIResponsesSseEvent(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  const payload = raw.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function openAIResponsesItemHasOutput(item) {
  if (!item || typeof item !== 'object') return false
  if (item.arguments || item.input || item.result || item.encrypted_content) return true
  for (const value of [item.content, item.summary]) {
    if (!Array.isArray(value)) continue
    if (
      value.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part.text || part.transcript || part.arguments || part.input || part.result || part.encrypted_content),
      )
    )
      return true
  }
  return false
}

/** Lifecycle events are transport metadata, not downstream model output. */
export function isOpenAIResponsesCommitEvent(event) {
  if (!event || typeof event !== 'object') return false
  const type = String(event.type || '').trim()
  if (
    !type ||
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.created' ||
    type === 'response.queued' ||
    type === 'response.in_progress' ||
    type === 'response.metadata' ||
    type === 'keepalive'
  )
    return false
  if (type === 'response.output_item.added' || type === 'response.output_item.done')
    return openAIResponsesItemHasOutput(event.item)
  if (
    type === 'response.content_part.added' ||
    type === 'response.content_part.done' ||
    type === 'response.reasoning_summary_part.added' ||
    type === 'response.reasoning_summary_part.done'
  )
    return !!(event.part?.text || event.part?.transcript)
  if (type === 'response.function_call_arguments.done') return !!event.arguments
  if (type === 'response.custom_tool_call_input.done') return !!event.input
  if (type === 'response.image_generation_call.partial_image') return !!event.partial_image_b64
  return type.startsWith('response.output_') || (type.startsWith('response.') && /\.(delta|done)$/.test(type))
}

function openAIResponsesFailure(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'error') return event
  if (event.type !== 'response.failed') return null
  return {
    type: 'error',
    error: event.response?.error || event.error || { type: 'server_error', message: 'Response failed' },
  }
}

function mappedOpenAIResponsesFailure(resultBase, event, committed, extras = {}) {
  const declared = Number(event?.error?.status || event?.status)
  const mapped = mapUpstreamError(declared >= 400 && declared < 600 ? declared : 500, event)
  return {
    ...resultBase,
    ...mapped,
    ok: false,
    terminalState: committed ? 'incomplete' : 'rejected',
    committed,
    ...extras,
  }
}

export async function runApiInference({
  req,
  res,
  cfg,
  scheduler,
  store,
  protocol,
  inbound,
  convertedBody,
  clientStream,
  deliveryMode,
  signal,
  timeoutMs,
  personaHideTokens,
  cacheTtl,
  converters,
  requestContext = null,
  apiToolPolicy = false,
} = {}) {
  const rejectInput = code => ({ ok: false, status: 400, via: 'api-kernel', terminalState: 'rejected',
    body: { error: { type: 'invalid_request_error', code, message: 'This API bridge cannot preserve the requested choices or tool input.' } } })
  // Neither bridge produces multiple choices. Custom Chat requires the typed
  // representation created before the normal policy chain, never raw bypass.
  if (['openai.chat', 'openai.completions'].includes(protocol) && inbound?.n != null && inbound.n !== 1) return rejectInput('api_bridge_n_unsupported')
  if (protocol === 'openai.chat' && hasCustomChatTools(inbound) && !apiToolPolicy) return rejectInput('api_bridge_policy_tools_required')
  let canonical
  try { canonical = canonicalApiPolicyBody(convertedBody, { allowInternalTools: apiToolPolicy && ['openai.chat', 'openai.responses'].includes(protocol) }) }
  catch (error) { if (!isApiPolicyInputError(error)) throw error; return rejectInput(error.code) }
  const model = canonical.model
  const picked = scheduler.pick(model)
  if (!picked.ok) {
    return {
      ok: false,
      status: picked.code === 'model_not_found' ? 404 : 503,
      via: 'api-kernel',
      body: { type: 'error', error: { type: 'api_error', code: picked.code, message: picked.message } },
      terminalState: 'exhausted',
    }
  }

  const preset = resolvePreset(picked.endpoint.kind, picked.endpoint)
  const protocolKind = normalizeProtocol(picked.endpoint.protocol || preset.protocol, preset.kind)
  const extraHeaders = joinHeaderMap(picked.endpoint.headers)
  const isOpenAI = protocolKind === 'openai'
  if (requestContext && (isOpenAI || picked.upstream_model !== canonical.model)) {
    return {
      ok: false,
      status: 400,
      terminalState: 'rejected',
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'classifier_model_incompatible',
          message: 'Classifier requests require the selected Anthropic model without endpoint model substitution.',
        },
      },
    }
  }
  let body
  try {
    body = isOpenAI
      ? { ...claudeToOpenAIResponsesRequest({ ...canonical, model: picked.upstream_model }), stream: true }
      : { ...apiPolicyToAnthropic(canonical), model: picked.upstream_model, stream: true }
  } catch (error) {
    if (!isCodexChatInputError(error) && !isApiPolicyInputError(error)) throw error
    return rejectInput(error.code)
  }
  if (requestContext) Object.assign(body, prepareClassifierBody(body))
  const callerProtocolHeaders = forwardAnthropicProtocolHeaders(req?.headers, protocol, protocolKind)
  const headers = mergeCallerProtocolHeaders(
    {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...upstreamAuthHeaders(protocolKind, picked.key.api_key, {
        ...extraHeaders,
        auth_scheme:
          picked.endpoint.auth_scheme || extraHeaders.auth_scheme || extraHeaders.anthropic_apikey_auth_scheme,
      }),
    },
    callerProtocolHeaders,
    extraHeaders,
    canonical.model,
  )

  let upstream
  try {
    upstream = await forwardApi({
      cfg,
      url: isOpenAI ? responsesUrl(preset.base_url) : messagesUrl(preset.base_url),
      headers,
      body,
      proxyUrl: picked.key.proxy_url,
      signal,
      timeoutMs,
    })
  } catch (error) {
    if (signal?.aborted) return clientCancelledResult({ via: 'api-kernel', committed: false })
    return {
      ok: false,
      status: 502,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: error.code || 'api_kernel_transport',
          message: String(error.message || error).slice(0, 300),
        },
      },
      terminalState: 'transport_error',
      transportError: true,
    }
  }

  let resultBase = {}
  const observation = { usage: null, committed: false, ttftMs: null, clientStreamTerminated: false }
  const consumeUpstream = async () => {
    const status = Number(upstream.statusCode) || 502
    if (status === 429 && !picked.endpoint.disable_cooling) {
      const retry = Number(upstream.headers['retry-after'] || 30)
      const until = new Date(Date.now() + Math.max(1, retry) * 1000).toISOString()
      try {
        store.setKeyCooldown(picked.key.id, until)
      } catch {}
      scheduler.reload(store.listRaw())
    }

    resultBase = {
      ok: status >= 200 && status < 300,
      status,
      via: 'api-kernel',
      vmId: null,
      accountId: picked.key.id,
      endpointId: picked.endpoint.id,
      model: picked.upstream_model,
      headers: { ...upstream.headers },
    }

    if (status >= 400) {
      const payload = await readApiJson(upstream).catch(() => ({}))
      const message = payload?.error?.message || payload?.message || `upstream ${status}`
      const upstreamCode = String(payload?.error?.code || payload?.code || '').trim()
      const contentCode = isContentPolicyErrorCode(upstreamCode) ? upstreamCode.toLowerCase() : ''
      return {
        ...resultBase,
        ok: false,
        body: {
          type: 'error',
          error: {
            ...(requestContext ? payload?.error : {}),
            ...(requestContext && payload?.error?.code ? { upstream_code: payload.error.code } : {}),
            ...(!requestContext && contentCode ? { code: contentCode } : {}),
            type: requestContext ? payload?.error?.type || 'api_error' : 'api_error',
            message: String(message).slice(0, 300),
          },
        },
        terminalState: 'rejected',
      }
    }

    if (isOpenAI) {
      return await runOpenAIResponsesUpstream({
        upstream,
        resultBase,
        protocol,
        inbound,
        clientStream,
        deliveryMode,
        res,
        converters,
        body,
        signal,
        observation,
      })
    }

    const classifierSseState = { dataBuf: '' }
    let classifierError = null
    let classifierStopped = false
    const readUpstreamLines = async (onLine) => {
      try {
        await readSseLines(upstream, async (line) => {
          const event = openAIResponsesSseEvent(line)
          const usage = usageFromSseLine(line) || event?.message?.usage
          if (usage) observation.usage = { ...observation.usage, ...usage }
          if (requestContext) {
            const event = consumeClaudeSSEData(line, classifierSseState)
            if (event?.type === 'error')
              classifierError = {
                ...event,
                error: { ...event.error, ...(event.error?.code ? { upstream_code: event.error.code } : {}) },
              }
            if (event?.type === 'message_stop') classifierStopped = true
          }
          await onLine(line)
        }, { signal })
      } catch (error) {
        if (!requestContext || signal?.aborted || error?.code?.startsWith('downstream_') || error?.code?.startsWith('stream_')) throw error
        classifierError = {
          type: 'error',
          error: {
            type: 'api_error',
            code: 'upstream_stream_interrupted',
            status: 502,
            message: String(error.message || 'Classifier stream interrupted').slice(0, 300),
          },
        }
      }
    }
    const classifierFailure = () => {
      if (!requestContext || (!classifierError && classifierStopped)) return null
      const body = classifierError || {
        type: 'error',
        error: {
          type: 'api_error',
          code: 'upstream_stream_interrupted',
          status: 502,
          message: 'Classifier stream ended before message_stop',
        },
      }
      const declared = Number(body.error?.status)
      const status = declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, body).status
      return {
        ...resultBase,
        ok: false,
        status,
        body,
        headers: {
          ...resultBase.headers,
          ...(body.error?.retry_after ? { 'retry-after': String(body.error.retry_after) } : {}),
        },
        terminalState: 'rejected',
      }
    }

    if (!clientStream) {
      const assembler = converters.createClaudeMessageAssembler()
      let committed = false
      let sawMessageStop = false
      let terminalError = null
      await readUpstreamLines(async (line) => {
        applyMaybeUsageHide(line, personaHideTokens, cacheTtl, converters)
        converters.applyClaudeSSELineToMessage(line, assembler)
        const raw = String(line || '')
        if (raw.startsWith('data:')) {
          if (!committed) committed = true
          const piece = raw.slice(5).trim()
          if (piece && piece !== '[DONE]') {
            try {
              const evt = JSON.parse(piece)
              if (evt?.type === 'message_stop') sawMessageStop = true
              if (evt?.type === 'error') terminalError = evt
            } catch {}
          }
        }
      })
      const failure = classifierFailure()
      if (failure) return { ...failure, committed: false }
      if (terminalError) {
        const declared = Number(terminalError.error?.status)
        const status = declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, terminalError).status
        return {
          ...resultBase,
          ok: false,
          status,
          body: terminalError,
          usage: assembler.message?.usage || null,
          terminalState: 'rejected',
          committed,
          sawMessageStop,
        }
      }
      const assembled = assembler.message
      if (!sawMessageStop) {
        return {
          ...resultBase,
          ok: false,
          body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
          usage: assembled?.usage || null,
          terminalState: assembled || committed ? 'incomplete' : 'rejected',
          committed,
          sawMessageStop: false,
        }
      }
      const hop = { body: assembled, stopReason: assembled?.stop_reason, sawMessageStop: true }
      const complete = resultBase.ok && isCompleteAssistantMessage(hop)
      return {
        ...resultBase,
        ok: complete,
        body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
        usage: assembled?.usage || null,
        terminalState: complete ? 'verified' : 'incomplete',
        committed,
        sawMessageStop: true,
      }
    }

    let state
    if (protocol === 'openai.chat')
      state = converters.createOpenAIChatStreamState(inbound.model || body.model, picked.endpoint.id)
    else if (protocol === 'openai.completions')
      state = converters.createOpenAICompletionStreamState(inbound.model || body.model, picked.endpoint.id)
    else if (protocol === 'openai.responses')
      state = converters.createResponsesStreamState(inbound.model || body.model, picked.endpoint.id)

    let committed = false
    let sawStop = false
    const started = Date.now()
    let ttftMs = null
    await readUpstreamLines(async (line) => {
      if (personaHideTokens) line = converters.hidePersonaUsageInSseLine(line, personaHideTokens, cacheTtl) || line
      if (String(line).startsWith('data:') && ttftMs == null) ttftMs = Date.now() - started
      observation.ttftMs = ttftMs
      const event = openAIResponsesSseEvent(line)
      if (event?.type === 'message_stop') sawStop = true
      if (event?.type === 'error') observation.failedEvent = event
      if (!committed && String(line).startsWith('data:')) {
        committed = true
        observation.committed = true
        if (protocol === 'anthropic.messages' && !res.headersSent) converters.writeSSEHeaders(res)
      }
      if (protocol === 'anthropic.messages') {
        if (!res.headersSent) converters.writeSSEHeaders(res)
        await writeDownstream(res, `${line}\n`, { signal })
        if (event?.type === 'error' || event?.type === 'message_stop') observation.pendingTerminal = true
        if (line === '' && observation.pendingTerminal) observation.clientStreamTerminated = true
        return
      }
      const writeChunks = async (chunks) => {
        if (!chunks.length) return
        if (!res.headersSent) converters.writeSSEHeaders(res)
        for (const chunk of chunks) await writeDownstream(res, `data: ${JSON.stringify(chunk)}\n\n`, { signal })
      }
      // An upstream error must not become a later synthetic success terminal.
      if (observation.failedEvent) return
      if (protocol === 'openai.chat') await writeChunks(converters.claudeSSELineToOpenAIChatChunks(line, state))
      else if (protocol === 'openai.completions')
        await writeChunks(converters.claudeSSELineToOpenAICompletionChunks(line, state))
      else await writeChunks(converters.claudeSSELineToResponsesEvents(line, state))
    })

    const failure = classifierFailure()
    if (failure) return { ...failure, committed, ttftMs }

    return {
      ...resultBase,
      ok: resultBase.ok && sawStop && !observation.failedEvent && (protocol !== 'anthropic.messages' || observation.clientStreamTerminated),
      terminalState: sawStop && !observation.failedEvent && (protocol !== 'anthropic.messages' || observation.clientStreamTerminated) ? 'verified' : committed ? 'incomplete' : 'rejected',
      usage: observation.usage,
      ...(observation.failedEvent ? { body: observation.failedEvent } : {}),
      committed,
      ttftMs,
    }
  }
  try {
    const result = await consumeUpstream()
    return { ...result, clientStreamTerminated: result.clientStreamTerminated || observation.clientStreamTerminated }
  } catch (error) {
    const base = { ...resultBase, committed: observation.committed || res.headersSent, usage: observation.usage, ttftMs: observation.ttftMs }
    if (signal?.aborted) return clientCancelledResult(base)
    const code = error?.code?.startsWith('stream_') || error?.code?.startsWith('downstream_') ? error.code : 'api_upstream_stream_interrupted'
    return { ...base, ok: false, status: error?.code === 'downstream_backpressure_timeout' ? 504 : 502,
      terminalState: 'incomplete', clientStreamTerminated: observation.clientStreamTerminated,
      downstreamFailure: code.startsWith('downstream_'),
      body: { error: { type: 'api_error', code, message: 'API stream could not complete' } } }
  } finally {
    if (!upstream.readableEnded && !upstream.destroyed) upstream.destroy()
  }
}

async function runOpenAIResponsesUpstream({
  upstream,
  resultBase,
  protocol,
  inbound,
  clientStream,
  deliveryMode,
  res,
  converters,
  body,
  signal,
  observation,
}) {
  const chunks = createSseBuffer()
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse = createChatSseState()
  chatSse.model = inbound?.model || body?.model || ''
  let conversionError = null
  let committed = false
  let completed = false
  let upstreamCompleted = false
  let sawTerminal = false
  let ttftMs = null
  let streamedUsage = null
  let terminalFailure = null
  const pendingLines = createSseBuffer({ maxBytes: STREAM_PENDING_BYTES, maxLines: 8192 })
  const started = Date.now()

  const writeStreamLine = async (raw) => {
    if (!res.headersSent) converters.writeSSEHeaders(res)
    if (protocol === 'openai.responses') {
      await writeDownstream(res, raw + '\n', { signal })
      const event = openAIResponsesSseEvent(raw)
      if (openAIResponsesFailure(event) ||
          (['response.completed', 'response.done'].includes(event?.type) && event?.response?.status === 'completed') ||
          (event?.type === 'response.incomplete' && event?.response?.status === 'incomplete')) observation.pendingTerminal = true
      if (raw === '' && observation.pendingTerminal) observation.clientStreamTerminated = true
      return
    }
    try {
      const mapped =
        protocol === 'anthropic.messages'
          ? responsesSseToAnthropicEvents(raw, anthropicSse)
          : responsesSseToChatChunk(raw, 'codex', chatSse)
      if (mapped) {
        await writeDownstream(res, mapped, { signal })
        if (mapped.includes('[DONE]') || mapped.includes('event: message_stop\n')) completed = true
        if (completed) observation.clientStreamTerminated = true
      }
    } catch (error) {
      if (error.code !== 'tool_arguments_mismatch' && !isCodexChatStreamError(error)) throw error
      conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
      const payload = JSON.stringify({ error: conversionError, ...(error.usage ? { usage: error.usage } : {}) })
      await writeDownstream(res,
        protocol === 'anthropic.messages'
          ? 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: conversionError }) + '\n\n'
          : 'data: ' + payload + '\n\ndata: [DONE]\n\n',
        { signal },
      )
      observation.clientStreamTerminated = true
    }
  }

  await readSseLines(upstream, async (line) => {
    const raw = String(line || '')
    const event = openAIResponsesSseEvent(raw)
    const failure = openAIResponsesFailure(event)
    if (failure) terminalFailure = failure
    const seen = usageFromSseLine(raw)
    if (seen) { streamedUsage = seen; observation.usage = seen }
    if (conversionError) return
    if (terminalFailure && !failure) return
    const startsOutput = isOpenAIResponsesCommitEvent(event)
    const completes = (['response.completed', 'response.done'].includes(event?.type) && event?.response?.status === 'completed') ||
      (event?.type === 'response.incomplete' && event?.response?.status === 'incomplete')
    if (completes) {
      sawTerminal = true
      upstreamCompleted = event.response.status === 'completed' && !event.response.error
      if (protocol === 'openai.responses') completed = true
    }
    const wasCommitted = committed
    if ((startsOutput || completes) && ttftMs == null) ttftMs = Date.now() - started
    if (!committed && (startsOutput || completes)) committed = true
    observation.committed = committed
    observation.ttftMs = ttftMs
    if (!clientStream) {
      chunks.push(raw)
      return
    }
    if (!wasCommitted) {
      if (!committed) { pendingLines.push(raw); return }
      for (const pending of pendingLines.take()) await writeStreamLine(pending)
      await writeStreamLine(raw)
      return
    }
    await writeStreamLine(raw)
  }, { signal })

  if (!clientStream) {
    if (terminalFailure)
      return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, { usage: streamedUsage, ttftMs })
    let assembled
    let outBody
    try {
      assembled = assembleCodexBodyFromSse(chunks.take(), {})
      outBody =
        protocol === 'anthropic.messages' || protocol === 'openai.completions'
          ? codexBodyToAnthropicMessage(assembled, inbound?.model || body?.model)
          : protocol === 'openai.chat'
            ? codexBodyToChatCompletion(assembled, inbound?.model || body?.model)
            : assembled
    } catch (error) {
      if (!isToolArgumentsError(error) && !isCodexChatResponseError(error)) throw error
      return {
        ...resultBase,
        ok: false,
        status: 502,
        body: { error: { type: 'upstream_protocol_error', code: error.code, message: error.message } },
        terminalState: 'incomplete',
        committed,
        usage: streamedUsage,
      }
    }
    const hasBody = !!(assembled && typeof assembled.id === 'string' && assembled.id && Array.isArray(assembled.output))
    const partialChat = protocol === 'openai.chat' && assembled.status === 'incomplete' &&
      ['max_output_tokens', 'content_filter'].includes(assembled.incomplete_details?.reason)
    const complete = resultBase.ok && sawTerminal && hasBody && (upstreamCompleted || partialChat)
    return {
      ...resultBase,
      ok: complete,
      body: outBody,
      clientBodyProtocol: ['openai.chat', 'openai.responses'].includes(protocol) ? protocol : null,
      usage: assembled?.usage || streamedUsage || outBody?.usage || null,
      terminalState: complete && upstreamCompleted ? 'verified' : hasBody ? 'incomplete' : 'rejected',
      committed,
    }
  }
  if (clientStream && protocol !== 'openai.responses' && protocol !== 'anthropic.messages' && !conversionError && !terminalFailure && (committed || resultBase.ok)) {
    try { finishChatSse(chatSse) }
    catch (error) {
      if (!isCodexChatStreamError(error)) throw error
      conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
      if (res.headersSent && !res.destroyed && !res.writableEnded) {
        await writeDownstream(res, `data: ${JSON.stringify({ error: conversionError })}\n\ndata: [DONE]\n\n`, { signal })
        observation.clientStreamTerminated = true
      }
    }
  }
  if (terminalFailure)
    return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, { usage: streamedUsage, ttftMs })
  if (conversionError)
    return {
      ...resultBase,
      ok: false,
      status: 502,
      body: { error: conversionError },
      terminalState: 'incomplete',
      committed,
      usage: streamedUsage,
      ttftMs,
    }

  return {
    ...resultBase,
    ok: resultBase.ok && sawTerminal && completed && (protocol !== 'openai.responses' || observation.clientStreamTerminated) && (upstreamCompleted || (protocol === 'openai.chat' && chatSse.chatStream?.finished)),
    usage: streamedUsage,
    terminalState: completed && upstreamCompleted && (protocol !== 'openai.responses' || observation.clientStreamTerminated) ? 'verified' : committed ? 'incomplete' : 'rejected',
    clientStreamTerminated: protocol === 'openai.chat' && chatSse.chatStream?.finished === true,
    committed,
    ttftMs,
  }
}

function applyMaybeUsageHide() {}
