// One bounded, content-free last-run record per slot. Never store stderr,
// prompts, outputs, tokens, provider bodies, URLs, argv or receipt nonces.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { codexSlotSnapshot } from '../oauth/codex-slot-snapshot.mjs'
import { CODEX_CLI_DIAGNOSTIC_CODES } from './codex-cli-diagnostics.mjs'

const FORMAT = 'es2api-cli-observation-v1'
const PHASES = new Set(['egress', 'credential', 'prepare', 'spawn', 'events', 'exit', 'delivery'])
const SYSTEM_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM'])
const ERROR_CODES = new Set([...CODEX_CLI_DIAGNOSTIC_CODES, 'client_cancelled', 'codex_cli_cancelled', 'codex_cli_timeout',
  'codex_cli_spawn_failed', 'codex_cli_execution_failed', 'codex_cli_turn_failed', 'codex_cli_incomplete',
  'codex_cli_invalid_jsonl', 'codex_cli_output_limit', 'codex_cli_usage_missing', 'codex_cli_usage_invalid',
  'codex_cli_tool_execution_unsupported', 'codex_cli_delivery_failed', 'codex_cli_exit_unconfirmed',
  'codex_cli_supervisor_state_unreadable', 'codex_cli_supervisor_state_invalid', 'codex_cli_heartbeat_lost',
  'codex_cli_identity_required', 'codex_cli_account_count', 'codex_cli_proxy_required', 'codex_cli_refresh_required',
  'codex_slot_snapshot_changed', 'provider_identity_invalid', 'provider_identity_verification_unavailable',
  'codex_refresh_recovery_required', 'codex_refresh_outcome_unknown', 'codex_refresh_response_incomplete',
  ...['unsupported', 'inspection_unavailable', 'slot_network_mismatch', 'network_policy_mismatch', 'process_unavailable',
    'config_mismatch', 'listener_unavailable', 'rules_mismatch'].map(code => 'codex_cli_egress_' + code)])
const COUNTERS = ['stdout_bytes', 'stderr_bytes', 'jsonl_events', 'turn_started', 'turn_completed', 'turn_failed', 'error_events', 'agent_messages']
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 1024 * 1024 * 1024 ? value : null
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))

/** Rebuild a public allowlist even when reading an untrusted/older peer. */
export function publicCodexCliObservation(value) {
  if (!value || value.format !== FORMAT || !/^req-[a-f0-9-]{36}$/.test(value.request_id || '') ||
    !instant(value.started_at) || !instant(value.completed_at) || Date.parse(value.completed_at) < Date.parse(value.started_at) ||
    !['failed', 'verified'].includes(value.outcome) || !PHASES.has(value.phase) || integer(value.duration_ms) === null) return null
  const counters = Object.fromEntries(COUNTERS.map(key => [key, integer(value.counters?.[key])]))
  if (Object.values(counters).some(n => n === null)) return null
  const exit = value.exit
  if (!exit || typeof exit.confirmed !== 'boolean' || typeof exit.host_spawn_failed !== 'boolean' ||
    ![null, 'exited', 'not_started'].includes(exit.phase) ||
    !(exit.code === null || (Number.isInteger(exit.code) && exit.code >= 0 && exit.code <= 255))) return null
  if (exit.host_spawn_failed ? (!exit.confirmed || exit.phase !== null || exit.code !== null)
    : exit.confirmed ? (exit.phase === null || exit.code === null || (exit.phase === 'not_started' && exit.code !== 126))
      : (exit.phase !== null || exit.code !== null)) return null
  if (value.outcome === 'verified' && (!value.usage_observed || !exit.confirmed || exit.host_spawn_failed ||
    exit.phase !== 'exited' || exit.code !== 0 || value.error_code != null)) return null
  return { format: FORMAT, request_id: value.request_id, started_at: value.started_at, completed_at: value.completed_at,
    duration_ms: value.duration_ms, outcome: value.outcome, phase: value.phase,
    error_code: ERROR_CODES.has(value.error_code) ? value.error_code : null,
    diagnostic_signals: CODEX_CLI_DIAGNOSTIC_CODES.filter(code => Array.isArray(value.diagnostic_signals) && value.diagnostic_signals.includes(code)),
    system_error: SYSTEM_ERRORS.has(value.system_error) ? value.system_error : null,
    counters, usage_observed: value.usage_observed === true, metadata_warning_observed: value.metadata_warning_observed === true,
    exit: { confirmed: exit.confirmed, host_spawn_failed: exit.host_spawn_failed, phase: exit.phase, code: exit.code } }
}

export function codexCliSystemError(value) { return SYSTEM_ERRORS.has(value) ? value : null }

function recordPaths(projectRoot, vm) {
  if (!projectRoot || vm?.execution_backend !== 'codex-cli' || !vm.integration_binding?.account_id ||
    vm.id !== `es2-${vm.integration_binding.account_id}` || !Number.isSafeInteger(vm.integration_binding.provision_generation) ||
    vm.integration_binding.provision_generation < 1) return null
  const root = path.join(projectRoot, '.codex-cli-observations')
  return { root, target: path.join(root, crypto.createHash('sha256').update(vm.id).digest('hex') + '.json') }
}

export function writeCodexCliObservation(projectRoot, vm, value) {
  const locations = recordPaths(projectRoot, vm), summary = publicCodexCliObservation(value)
  if (!locations || !summary) return false
  fs.mkdirSync(locations.root, { recursive: true, mode: 0o700 })
  const directory = fs.lstatSync(locations.root)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('cli_observation_store_unavailable')
  const data = JSON.stringify({ slot_snapshot: codexSlotSnapshot(vm), summary }) + '\n'
  if (Buffer.byteLength(data) > 8192) throw new Error('cli_observation_limit')
  const temporary = path.join(locations.root, `.write-${crypto.randomUUID()}.tmp`)
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, locations.target)
    if (process.platform !== 'win32') {
      const descriptor = fs.openSync(locations.root, fs.constants.O_RDONLY)
      try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    }
    return true
  } finally { try { fs.unlinkSync(temporary) } catch {} }
}

export function readCodexCliObservation(projectRoot, vm) {
  try {
    const locations = recordPaths(projectRoot, vm)
    if (!locations) return null
    const directory = fs.lstatSync(locations.root), info = fs.lstatSync(locations.target)
    if (!directory.isDirectory() || directory.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > 8192) return null
    const descriptor = fs.openSync(locations.target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    let data
    try {
      const opened = fs.fstatSync(descriptor)
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 8192) return null
      const bytes = Buffer.alloc(8193), size = fs.readSync(descriptor, bytes, 0, bytes.length, 0)
      if (size > 8192) return null
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
    } finally { fs.closeSync(descriptor) }
    return data.slot_snapshot === codexSlotSnapshot(vm) ? publicCodexCliObservation(data.summary) : null
  } catch { return null }
}
