import { SettingsRepo } from '../db/repos/settings-repo.mjs'

export function integrationDispatchRules() {
  if (process.env.ES2API_USAGE_MODE !== 'pull') return {}
  return new SettingsRepo().get('es2api_dispatch_rules', null)
}

export function applyIntegrationDispatch(vm, rules) {
  if (!vm || rules === null) return null
  const rule = rules[vm.id]
  if (!rule) return vm
  if (rule.blocked) return null
  if (!rule.deprioritized) return vm
  return { ...vm, policy: { ...vm.policy, weight: Math.min(Number(vm.policy?.weight || vm.weight || 1), 0.05) } }
}

export function saveIntegrationDispatch(input) {
  if (!Array.isArray(input) || input.length > 50000) throw new Error('Invalid dispatch rules')
  const rules = Object.create(null)
  for (const item of input) {
    if (typeof item?.vm_id !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(item.vm_id) || typeof item.blocked !== 'boolean' || typeof item.deprioritized !== 'boolean') throw new Error('Invalid dispatch rule')
    rules[item.vm_id] = { blocked: item.blocked, deprioritized: item.deprioritized }
  }
  const settings = new SettingsRepo()
  if (JSON.stringify(settings.get('es2api_dispatch_rules')) !== JSON.stringify(rules)) settings.set('es2api_dispatch_rules', rules)
  return Object.keys(rules).length
}
