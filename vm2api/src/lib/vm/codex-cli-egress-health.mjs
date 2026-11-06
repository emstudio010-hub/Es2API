// Passive local configuration checks only. Never opens an outbound connection,
// repairs firewall state, refreshes OAuth, or proves supplier reachability.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { slotExecContainer } from './slot-exec.mjs'
import { EGRESS_BIN, boundProxyUrl, bridgeName, chainName, egressRunDir, inspectEgressProcess,
  iptablesPlan, isLocalEgressProxy, networkName, portsForProxy } from './egress.mjs'

const runFile = promisify(execFile)
const failed = reason => ({ ok: false, reachable: false, status: 503, code: `codex_cli_egress_${reason}` })

// iptables-save canonicalizes option order and adds protocol match modules.
// Compare complete rules, retaining negation and duplicate options; never use
// substring matching that could accept a wider subnet or another chain.
function ruleKey(tokens) {
  const atoms = []
  for (let i = 0; i < tokens.length; i++) {
    let negative = false
    if (tokens[i] === '!') { negative = true; i++ }
    const key = tokens[i], value = tokens[++i]
    if (!key?.startsWith('-') || !value || value.startsWith('-') || value === '!') return null
    if (!negative && key === '-m' && ['tcp', 'udp'].includes(value)) continue
    atoms.push(`${negative ? '!' : ''}${key}=${value}`)
  }
  return atoms.sort().join('|')
}

function rulesPresent(nat, filter, plan, chain) {
  const saved = text => text.split('\n').filter(line => line.startsWith('-A ')).map(line => line.trim().split(/\s+/))
  const natRules = saved(nat), filterRules = saved(filter)
  const wantedChain = plan.add.filter(a => a[1] === 'nat' && a[2] === '-A' && a[3] === chain).map(a => ruleKey(a.slice(2)))
  const actualChain = natRules.filter(a => a[1] === chain).map(ruleKey)
  if (wantedChain.length !== actualChain.length || wantedChain.some((r, i) => !r || r !== actualChain[i])) return false
  return plan.add.filter(a => a[2] === '-C').every(a => {
    const wanted = ruleKey(['-A', ...a.slice(3)])
    return wanted && (a[1] === 'nat' ? natRules : filterRules).some(r => ruleKey(r) === wanted)
  })
}

function ownedSocket(lines, kind, host, port, pid) {
  return lines.split('\n').some(line => {
    const fields = line.trim().split(/\s+/)
    return fields[0] === kind && fields[4] === `${host}:${port}`
      && new RegExp(`pid=${pid}(?:\\D|$)`).test(fields.slice(6).join(' '))
  })
}

export async function inspectCodexCliEgress(projectRoot, vm, { timeoutMs = 4000 } = {}) {
  if (process.platform !== 'linux' || !vm?.id || !vm.proxy?.id || isLocalEgressProxy(vm.proxy)) return failed('unsupported')
  const deadline = Date.now() + Math.max(1, Math.min(5000, Number(timeoutMs) || 4000))
  async function command(bin, args) {
    try {
      const r = await runFile(bin, args, { encoding: 'utf8', windowsHide: true,
        timeout: Math.max(1, deadline - Date.now()), maxBuffer: 512 * 1024 })
      return { ok: true, stdout: r.stdout }
    } catch { return { ok: false } } // Never surface stderr/configuration/secrets.
  }
  try {
    const expectedNetwork = networkName(vm.proxy.id), ports = portsForProxy(vm.proxy.id)
    const [containerResult, networkResult, sockets, nat, filter] = await Promise.all([
      command('docker', ['inspect', '--type', 'container', slotExecContainer(vm)]),
      command('docker', ['network', 'inspect', expectedNetwork]),
      command('ss', ['-H', '-lntup']),
      command('iptables-save', ['-t', 'nat']),
      command('iptables-save', ['-t', 'filter']),
    ])
    if (![containerResult, networkResult, sockets, nat, filter].every(r => r.ok)) return failed('inspection_unavailable')
    const container = JSON.parse(containerResult.stdout)[0], network = JSON.parse(networkResult.stdout)[0]
    if (!container?.State?.Running || container.State.Restarting || container.Config?.Labels?.['kin.vm.id'] !== vm.id
      || container.Config?.Labels?.['kin.vm.role'] !== 'codex' || container.HostConfig?.NetworkMode !== expectedNetwork
      || Object.keys(container.NetworkSettings?.Networks || {}).length !== 1
      || !container.NetworkSettings.Networks[expectedNetwork]) return failed('slot_network_mismatch')
    // A stale image's proxy variables could override the transparent route.
    if ((container.Config.Env || []).some(v => /^(?:https?|all|no)_proxy=.+/i.test(v))) return failed('slot_network_mismatch')
    const ipv4 = network?.IPAM?.Config?.filter(c => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(c.Subnet || '')) || []
    const options = network?.Options || {}
    if (network?.Name !== expectedNetwork || network.Driver !== 'bridge' || network.EnableIPv6 !== false || ipv4.length !== 1
      || options['com.docker.network.bridge.name'] !== bridgeName(vm.proxy.id)
      || options['com.docker.network.bridge.enable_ip_masquerade'] !== 'false'
      || options['com.docker.network.bridge.enable_icc'] !== 'false') return failed('network_policy_mismatch')
    const { Subnet: subnet, Gateway: gateway } = ipv4[0]
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway || '')) return failed('network_policy_mismatch')
    const state = inspectEgressProcess(projectRoot, vm.proxy.id)
    if (!state.ok || fs.statSync(`/proc/${state.pid}`).uid !== process.getuid()
      || fs.realpathSync(`/proc/${state.pid}/exe`) !== fs.realpathSync(EGRESS_BIN)) return failed('process_unavailable')
    const config = JSON.parse(fs.readFileSync(path.join(egressRunDir(projectRoot, vm.proxy.id), 'egress.json'), 'utf8'))
    if (config.proxy_id !== vm.proxy.id || config.proxy_url !== boundProxyUrl(vm.proxy)
      || config.listen_tcp !== `${gateway}:${ports.tcp}` || config.listen_dns !== `${gateway}:${ports.dns}`
      || !!config.domain_forward !== (vm.proxy.domain_forward === true)) return failed('config_mismatch')
    if (!ownedSocket(sockets.stdout, 'tcp', gateway, ports.tcp, state.pid)
      || !ownedSocket(sockets.stdout, 'tcp', gateway, ports.dns, state.pid)
      || !ownedSocket(sockets.stdout, 'udp', gateway, ports.dns, state.pid)) return failed('listener_unavailable')
    const chain = chainName(vm.proxy.id)
    const plan = iptablesPlan({ chain, bridge: bridgeName(vm.proxy.id), subnet, tcpPort: ports.tcp, dnsPort: ports.dns })
    if (!rulesPresent(nat.stdout, filter.stdout, plan, chain)) return failed('rules_mismatch')
    // The process may have disappeared during the asynchronous inventory.
    const finalState = inspectEgressProcess(projectRoot, vm.proxy.id)
    if (finalState.pid !== state.pid || !finalState.ok) return failed('process_unavailable')
    return { ok: true, scope: 'local_configuration_only', upstream_reachability_verified: false }
  } catch { return failed('inspection_unavailable') }
}
