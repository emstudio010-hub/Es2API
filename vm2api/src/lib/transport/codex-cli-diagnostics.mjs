// Pinned CLI 0.155.1 emits non-fatal warnings as completed `error` items.
// Only this observed metadata fallback is safe to ignore. Rerouting and other
// error items must remain failures; an unrecognized warning is not approval.
export function isCodexCliMetadataWarning(event, model) {
  return event?.type === 'item.completed' && event.item?.type === 'error'
    && typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)
    && event.item.message === `Model metadata for \`${model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`
}

// Inspect only bounded, transient diagnostics. Return fixed codes, never raw
// messages, URLs, credentials, provider bodies or local filesystem paths.
export function classifyCodexCliDiagnostic(value) {
  if (typeof value !== 'string') return null
  const text = value.slice(-8192)
  if (/model rerouted:/i.test(text)) return 'codex_cli_model_rerouted'
  if (/failed to load bootstrap configuration|model_providers contains reserved built-in provider IDs|Error loading config\.toml/i.test(text)) return 'codex_cli_launch_config_invalid'
  if (/failed to initialize in-process app-server client/i.test(text)) return 'codex_cli_app_server_init_failed'
  if (/no space left on device|disk quota exceeded/i.test(text)) return 'codex_cli_storage_full'
  if (/invalid_grant|invalid_token|token[_ ]expired|expired (?:access )?token|not logged in|authentication (?:failed|required)|incorrect api key|unexpected status (?:code[: ]*)?401\b/i.test(text)) return 'codex_cli_auth_rejected'
  if (/rate[_ -]limit(?:ed| exceeded|_exceeded)|too many requests|usage limit|quota (?:exceeded|exhausted)|unexpected status (?:code[: ]*)?429\b/i.test(text)) return 'codex_cli_rate_limited'
  if (/model_not_found|model [^\r\n]{0,150}(?:does not exist|is not supported|is not available)|do not have access to (?:the )?model/i.test(text)) return 'codex_cli_model_unavailable'
  if (/certificate verify failed|invalid peer certificate|tls handshake|ssl certificate/i.test(text)) return 'codex_cli_tls_failed'
  if (/SOCKS[^\r\n]{0,80}(?:auth|credential)|proxy authentication|required proxy authentication/i.test(text)) return 'codex_cli_proxy_auth_failed'
  if (/Connection failed: error sending request|connection refused|connection reset|error sending request|proxy connect|SOCKS.*(?:connect|handshake)/i.test(text)) return 'codex_cli_connection_failed'
  return null
}

export function codexCliFailureMessage(code) {
  if (/^codex_cli_egress_(?:unsupported|inspection_unavailable|slot_network_mismatch|network_policy_mismatch|process_unavailable|config_mismatch|listener_unavailable|rules_mismatch)$/.test(code || '')) {
    return 'CLI 固定出口的本地网络配置未通过检查，请在实例中检查出口；未启动模型请求'
  }
  return ({
    codex_cli_model_rerouted: '上游报告模型被切换，本次请求已停止；未自动重试',
    codex_cli_launch_config_invalid: 'Codex 启动配置无效，请更新执行实例；未自动重试',
    codex_cli_app_server_init_failed: 'Codex 客户端初始化失败，请检查实例运行目录；未自动重试',
    codex_cli_storage_full: '实例临时空间不足，请检查实例；未自动重试',
    codex_cli_auth_rejected: 'OAuth 认证被拒绝，请检查账号凭据；未自动重试',
    codex_cli_rate_limited: '上游报告额度或调用频率受限；未自动重试',
    codex_cli_model_unavailable: '该账号无法使用所请求的模型；未自动切换模型或重试',
    codex_cli_tls_failed: '实例到上游的加密连接失败，请检查固定出口；未自动重试',
    codex_cli_proxy_auth_failed: '固定出口代理认证失败；未自动重试',
    codex_cli_connection_failed: '实例未能连接上游，请检查固定出口；未自动重试',
  })[code] || 'Codex CLI 执行未完成，请在实例中检查状态；本次未自动重试'
}
