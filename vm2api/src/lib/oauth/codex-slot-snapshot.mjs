import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'

const changed = () => Object.assign(new Error('账号、实例归属或固定出口已变化，已拒绝使用旧快照；请重新同步'), {
  status: 409, code: 'codex_slot_snapshot_changed',
})
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

// Private comparison value, not an authorization proof. Include the actual
// route/auth fields, not just a proxy ID whose connection settings may change.
export function codexSlotSnapshot(vm) {
  if (!vm || !isValidVmId(vm.id) || !isCodexVm(vm)) throw changed()
  const proxy = vm.proxy || {}
  const route = Object.fromEntries(['id', 'scheme', 'kind', 'url', 'host', 'port', 'username', 'password'].map(key => [key, proxy[key] ?? null]))
  return crypto.createHash('sha256').update(JSON.stringify(canonical({
    id: vm.id, platform: vm.platform || null, family: vm.family || null, kind: vm.kind || null,
    integration_binding: vm.integration_binding || null, node_id: vm.node_id || null,
    execution_backend: vm.execution_backend || 'kernel', created_at: vm.created_at || vm.createdAt || null,
    runtime_type: vm.runtime_type || vm.runtime?.type || null, container: vm.runtime?.container || null,
    identity_policy: vm.identity_policy || null, timezone: vm.timezone || null, proxy: route,
  }))).digest('hex')
}

export function assertCodexSlotSnapshot(vm, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || codexSlotSnapshot(vm) !== expected) throw changed()
  return vm
}

export function readCodexSlotSnapshot(projectRoot, vmId, expected) {
  if (!isValidVmId(vmId)) throw changed()
  let vm
  try { vm = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', `${vmId}.json`), 'utf8')) }
  catch { throw changed() }
  if (vm.id !== vmId) throw changed()
  return assertCodexSlotSnapshot(vm, expected)
}
