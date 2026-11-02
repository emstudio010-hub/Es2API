export const traceDefaults = Object.freeze({
  enabled: true,
  trigger: 'requests',
  model_mode: 'specified',
  every_requests: 10,
  interval_seconds: 3600,
  sampling_probability: 0.1,
  idle_seconds: 1800,
  cooldown_seconds: 0,
  model: 'gpt-6.1-sol',
  sample_count: 3,
  confidence_threshold: 0.8,
  consecutive_mismatches: 2,
  action: 'observe',
  timeout_ms: 90000,
})

export function validateTraceConfig(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('ModelTrace 配置必须为对象'), { status: 400, code: 'invalid_trace_config' })
  const unknown = Object.keys(input).filter(key => !(key in traceDefaults))
  if (unknown.length) throw Object.assign(new Error(`ModelTrace 配置字段无效：${unknown.join(',')}`), { status: 400, code: 'invalid_trace_config' })
  const config = { ...traceDefaults, ...input }
  if (typeof config.enabled !== 'boolean') throw Object.assign(new Error('enabled 必须为布尔值'), { status: 400, code: 'invalid_trace_config' })
  if (!['requests', 'interval', 'both', 'manual', 'requests_and_interval', 'active_interval', 'probability', 'idle_return'].includes(config.trigger)) throw Object.assign(new Error('trigger 无效'), { status: 400, code: 'invalid_trace_config' })
  if (!['specified', 'most_used'].includes(config.model_mode)) throw Object.assign(new Error('model_mode 无效'), { status: 400, code: 'invalid_trace_config' })
  if (!['observe', 'deprioritize', 'pause'].includes(config.action)) throw Object.assign(new Error('action 无效'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isInteger(config.every_requests) || config.every_requests < 1 || config.every_requests > 1000000) throw Object.assign(new Error('every_requests 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isInteger(config.interval_seconds) || config.interval_seconds < 60 || config.interval_seconds > 604800) throw Object.assign(new Error('interval_seconds 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isFinite(config.sampling_probability) || config.sampling_probability < 0.01 || config.sampling_probability > 1) throw Object.assign(new Error('sampling_probability 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isInteger(config.idle_seconds) || config.idle_seconds < 60 || config.idle_seconds > 604800) throw Object.assign(new Error('idle_seconds 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isInteger(config.cooldown_seconds) || config.cooldown_seconds < 0 || config.cooldown_seconds > 604800) throw Object.assign(new Error('cooldown_seconds 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isInteger(config.sample_count) || config.sample_count < 3 || config.sample_count > 10) throw Object.assign(new Error('sample_count 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isInteger(config.consecutive_mismatches) || config.consecutive_mismatches < 1 || config.consecutive_mismatches > 20) throw Object.assign(new Error('consecutive_mismatches 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (!Number.isInteger(config.timeout_ms) || config.timeout_ms < 1000 || config.timeout_ms > 300000) throw Object.assign(new Error('timeout_ms 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (typeof config.confidence_threshold !== 'number' || config.confidence_threshold < 0.5 || config.confidence_threshold > 1) throw Object.assign(new Error('confidence_threshold 超出范围'), { status: 400, code: 'invalid_trace_config' })
  if (typeof config.model !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,149}$/i.test(config.model)) throw Object.assign(new Error('model 无效'), { status: 400, code: 'invalid_trace_config' })
  return partial ? Object.fromEntries(Object.keys(input).map(key => [key, config[key]])) : config
}
