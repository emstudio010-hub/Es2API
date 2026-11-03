import fs from 'node:fs'
import path from 'node:path'
import { inspectContainerOrNull } from '../cluster/docker-remote.mjs'
import { slotExecContainer } from '../vm/slot-exec.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { codexCliClaimPath } from './codex-cli-claim.mjs'

export const codexCliJobs = new Map()
const maintenance = new Set()
const requestName = /^req-[a-f0-9-]+$/

export function codexCliInMaintenance(vmId) { return maintenance.has(vmId) }

export function holdCodexCliMaintenance(vmId) {
  if (maintenance.has(vmId)) throw Object.assign(new Error('CLI 实例正在维护，请稍后重试'), { status: 409, code: 'codex_cli_maintenance' })
  maintenance.add(vmId)
  codexCliJobs.get(vmId)?.cancel('codex_cli_cancelled')
  let released = false
  return () => { if (!released) { maintenance.delete(vmId); released = true } }
}

/** Call only during an explicit recovery, after stopping this exact container. */
export async function clearStoppedCodexCliRequests(exec) {
  const id = exec?.vm?.id
  if (!maintenance.has(id) || slotHost(exec.vm).kind !== 'local') throw Object.assign(new Error('CLI 清理要求本机实例处于维护状态'), { code: 'codex_cli_maintenance_required' })
  const info = await inspectContainerOrNull(slotHost(exec.vm).dockerApi(), slotExecContainer(exec.vm))
  if (info && (info.State?.Running !== false || info.State?.Restarting || info.State?.Paused || info.State?.Pid > 0)) throw Object.assign(new Error('尚未确认容器完全停止，未清理请求目录'), { code: 'codex_cli_stop_unconfirmed' })
  // docker stop kills the container process tree, but the host pipe may close a
  // moment later. Do not race the old hop's finalizer against a new request.
  const until = Date.now() + 5000
  while (codexCliJobs.has(id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
  if (codexCliJobs.has(id)) throw Object.assign(new Error('CLI 请求尚未释放，未清理目录'), { code: 'codex_cli_busy' })
  const confirmed = await inspectContainerOrNull(slotHost(exec.vm).dockerApi(), slotExecContainer(exec.vm))
  if (confirmed && (confirmed.State?.Running !== false || confirmed.State?.Restarting || confirmed.State?.Paused || confirmed.State?.Pid > 0)) throw Object.assign(new Error('容器停止状态已变化，未清理请求目录'), { code: 'codex_cli_stop_unconfirmed' })
  const root = path.resolve(exec.homeDir, '.es2api-requests')
  let entries
  try {
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('invalid request root')
    entries = fs.readdirSync(root)
  } catch (error) { if (error.code === 'ENOENT') return { cleared: 0 }; throw error }
  let cleared = 0
  for (const name of entries) {
    if (!requestName.test(name)) continue
    const target = path.resolve(root, name)
    if (path.dirname(target) !== root || fs.lstatSync(target).isSymbolicLink()) throw new Error('invalid request directory')
    fs.rmSync(target, { recursive: true, force: true })
    cleared++
  }
  // Recovery reached this point only after two exact-container stopped checks
  // and the local request finalizer drain. Never clear a claim just for age/PID.
  const claim = codexCliClaimPath(root)
  try {
    const stat = fs.lstatSync(claim)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid CLI request claim')
    fs.unlinkSync(claim)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { cleared }
}
