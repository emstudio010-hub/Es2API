/**
 * proxies repository — SOCKS5 pool rows + pool config in settings.
 * The ProxyPool keeps its working set in memory (probe loop mutates it);
 * this repo is the persistence surface: loadAll / replaceAll.
 */

import crypto from 'node:crypto'
import { getDb, withTransaction } from '../database.mjs'
import { SettingsRepo } from './settings-repo.mjs'

const CONFIG_KEY = 'proxy_pool_config'

const COLUMNS = [
  'id',
  'protocol',
  'host',
  'port',
  'username',
  'password',
  'raw',
  'status',
  'enabled',
  'name',
  'label',
  'owner_user_id',
  'bound_vm_id',
  'consecutive_failures',
  'latency_ms',
  'last_probe_at',
  'last_error',
  'geo_ip',
  'geo_country',
  'geo_country_code',
  'geo_region',
  'geo_city',
  'geo_isp',
  'geo_timezone',
  'geo_checked_at',
  'geo_error',
  'geo_v6_ip',
  'geo_v6_country',
  'geo_v6_country_code',
  'geo_v6_region',
  'geo_v6_city',
  'geo_v6_isp',
  'geo_v6_timezone',
  'geo_v6_checked_at',
  'geo_v6_error',
  'created_at',
  'updated_at',
  'domain_forward',
]

function rowToProxy(row) {
  if (!row) return null
  // ProxyPool still speaks `scheme`; the column is sub2api's `protocol`.
  return { ...row, scheme: row.protocol, enabled: !!row.enabled, domain_forward: !!row.domain_forward }
}

export class ProxiesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
    this._all = db.prepare('SELECT * FROM proxies ORDER BY created_at, id')
    this._config = db.prepare('SELECT value FROM settings WHERE key = ?')
    this._clear = db.prepare('DELETE FROM proxies')
    this._insert = db.prepare(`
      INSERT INTO proxies (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
  }

  loadAll() {
    return this._all.all().map(rowToProxy)
  }

  /** Rows and config must come from the same SQLite read snapshot. The private
   * fingerprint is a CAS token, never a panel response or credential identity. */
  loadSnapshot() {
    return withTransaction(this.db, () => {
      const rows = this._all.all()
      const rawConfig = this._config.get(CONFIG_KEY)?.value ?? null
      let config = null
      try {
        config = rawConfig == null ? null : JSON.parse(rawConfig)
        if (config != null && (typeof config !== 'object' || Array.isArray(config))) throw new Error()
      } catch {
        throw Object.assign(new Error('代理池配置无法读取，已拒绝覆盖原数据'), { code: 'proxy_pool_store_invalid', status: 503 })
      }
      return { config, proxies: rows.map(rowToProxy),
        fingerprint: crypto.createHash('sha256').update(JSON.stringify([rawConfig, rows])).digest('hex') }
    })
  }

  replaceAll(proxies = [], { expectedFingerprint, config } = {}) {
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint || '')) {
      throw Object.assign(new Error('缺少代理池数据快照，已拒绝覆盖原数据'), { code: 'proxy_pool_snapshot_required', status: 409 })
    }
    return withTransaction(this.db, () => {
      if (this.loadSnapshot().fingerprint !== expectedFingerprint) {
        throw Object.assign(new Error('代理池已被其他操作更新，请重新读取后再操作'), { code: 'proxy_pool_changed', status: 409 })
      }
      this._clear.run()
      for (const p of proxies) {
        this._insert.run(
          ...COLUMNS.map((c) => {
            if (c === 'enabled') return p.enabled === false ? 0 : 1
            if (c === 'domain_forward') return p.domain_forward ? 1 : 0
            if (c === 'protocol') return p.protocol ?? p.scheme ?? 'socks5'
            if (c === 'name') return p.name ?? (p.host && p.port != null ? `${p.host}:${p.port}` : p.id)
            return p[c] ?? null
          }),
        )
      }
      // Commit settings and bindings together; a failed row insert or CAS may
      // not leave a new configuration paired with old bindings.
      if (config !== undefined) this.settings.set(CONFIG_KEY, config)
      return this.loadSnapshot().fingerprint
    })
  }

  getConfig(fallback = null) {
    return this.settings.get(CONFIG_KEY, fallback)
  }

  setConfig(config) {
    return this.settings.set(CONFIG_KEY, config)
  }
}
