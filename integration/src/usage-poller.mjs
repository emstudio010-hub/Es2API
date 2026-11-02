// Pull completion metadata across the same authenticated VM2 control channel.
// Acknowledge only after durable integration-side deduplication. No inference
// request is ever issued or replayed by this worker.
export function createUsagePoller({ vm2, modeltrace, store, clock = () => Date.now() }) {
  let active = null
  let closed = false
  let retryAt = 0

  async function deliver() {
    try {
      await vm2.ensureSession()
      const items = store.listAllAccounts().filter(account => account.vm_id).map(account => ({
        vm_id: account.vm_id,
        blocked: !account.schedulable || account.status !== 'ready' || account.deletion_pending || account.slot_binding_stale || account.modeltrace?.state?.auto_paused === true,
        deprioritized: account.modeltrace?.state?.deprioritized === true,
      }))
      const dispatch = await vm2.request('/api/panel/integration/dispatch', { method: 'PUT', body: { items } })
      if (dispatch.ok !== true) throw new Error('dispatch_sync_failed')
      const pending = await vm2.request('/api/panel/integration/usage-events')
      if (pending.ok !== true || pending.reporter?.enabled !== true || pending.reporter?.mode !== 'pull' ||
          !Array.isArray(pending.items) || pending.items.length > 100) throw new Error('invalid_outbox')
      const eventIds = []
      for (const event of pending.items) {
        await modeltrace.recordUsage({ ...event, source: 'vm2' })
        eventIds.push(event.event_id)
      }
      if (eventIds.length) {
        const ack = await vm2.request('/api/panel/integration/usage-events/ack', { method: 'POST', body: { event_ids: eventIds } })
        if (ack.ok !== true) throw new Error('ack_failed')
      }
      store.setSetting('modeltrace_usage_bridge_poll', { last_poll_at: new Date(clock()).toISOString(), last_error: null,
        dispatch_synced_at: new Date(clock()).toISOString(), mode: 'pull', reporter: { pending: pending.reporter.pending, accepted: pending.reporter.accepted,
          delivered: pending.reporter.delivered, failed: pending.reporter.failed, dropped: pending.reporter.dropped,
          skipped: pending.reporter.skipped || {} } })
      retryAt = 0
      return { delivered: eventIds.length }
    } catch {
      store.setSetting('modeltrace_usage_bridge_poll', { last_poll_at: new Date(clock()).toISOString(), last_error: 'usage_delivery_unavailable' })
      retryAt = clock() + 5000
      return { delivered: 0, error: 'usage_delivery_unavailable' }
    }
  }

  return {
    poll() {
      if (closed || clock() < retryAt) return Promise.resolve(null)
      if (!active) active = deliver().finally(() => { active = null })
      return active
    },
    async close() { closed = true; if (active) await active },
  }
}
