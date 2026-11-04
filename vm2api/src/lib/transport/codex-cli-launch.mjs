// Trusted launch policy shared by bootstrap validation and actual execution.
// Do not redefine reserved built-in model_providers.openai (CLI 0.155.1).
const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_host', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'memories', 'hooks', 'in_app_browser', 'in_app_local_automation', 'in_app_chat', 'workspace_dependencies', 'goals', 'unbounded_connection_retries']
const config = ['web_search="disabled"', 'cli_auth_credentials_store="file"',
  'model_provider="es2api_codex"', 'model_providers.es2api_codex.name="Es2API Codex OAuth"',
  'model_providers.es2api_codex.base_url="https://chatgpt.com/backend-api/codex"',
  'model_providers.es2api_codex.wire_api="responses"', 'model_providers.es2api_codex.requires_openai_auth=true',
  'model_providers.es2api_codex.request_max_retries=0', 'model_providers.es2api_codex.stream_max_retries=0',
  'model_providers.es2api_codex.supports_websockets=false', 'mcp_servers={}', 'analytics.enabled=false', 'feedback.enabled=false']

export function codexCliLaunchArgs() {
  return [...disabled.flatMap(feature => ['--disable', feature]), ...config.flatMap(value => ['-c', value])]
}
