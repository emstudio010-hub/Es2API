import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/store.mjs'

const ENCRYPTION_KEY = 'ef'.repeat(32)

test('opens the previous SQLite schema, adds dispatch columns and recovers in-flight state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'es2api-store-migration-'))
  const filename = path.join(directory, 'legacy.sqlite')
  const now = new Date().toISOString()
  const legacy = new DatabaseSync(filename)
  legacy.exec(`
    CREATE TABLE account_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', strategy TEXT NOT NULL DEFAULT 'shared',
      lease_account_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE pool_accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
      group_ids TEXT NOT NULL, credential_ciphertext TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL UNIQUE,
      has_access_token INTEGER NOT NULL, has_refresh_token INTEGER NOT NULL,
      has_id_token INTEGER NOT NULL, has_api_key INTEGER NOT NULL,
      vm_id TEXT, status TEXT NOT NULL, schedulable INTEGER NOT NULL DEFAULT 0,
      concurrency INTEGER NOT NULL, priority INTEGER NOT NULL,
      slot_json TEXT, error_code TEXT, error_message TEXT,
      deletion_pending INTEGER NOT NULL DEFAULT 0,
      successful_requests INTEGER NOT NULL DEFAULT 0,
      modeltrace_overrides TEXT NOT NULL DEFAULT '{}',
      modeltrace_state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE control_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE modeltrace_runs (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
    );
  `)
  legacy.prepare(`INSERT INTO pool_accounts(
    id,name,mode,group_ids,credential_ciphertext,credential_fingerprint,
    has_access_token,has_refresh_token,has_id_token,has_api_key,vm_id,status,
    schedulable,concurrency,priority,slot_json,error_code,error_message,
    deletion_pending,successful_requests,modeltrace_overrides,modeltrace_state,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'legacy-account', 'Legacy', 'pool', '[]', 'legacy-envelope', 'legacy-fingerprint',
    1, 0, 0, 0, null, 'provisioning', 0, 2, 50, null, null, null,
    0, 0, '{}', '{}', now, now,
  )
  legacy.prepare('INSERT INTO modeltrace_runs(id,account_id,status,created_at,updated_at,payload) VALUES(?,?,?,?,?,?)')
    .run('legacy-run', 'legacy-account', 'running', now, now, JSON.stringify({
      id: 'legacy-run', account_id: 'legacy-account', status: 'running', model: 'model-a',
    }))
  legacy.close()

  const store = new Store({ filename, encryptionKey: ENCRYPTION_KEY })
  try {
    const columns = store.db.prepare('PRAGMA table_info(pool_accounts)').all().map(row => row.name)
    for (const column of ['binding_json', 'provision_generation', 'group_pause_restore', 'slot_binding_stale',
      'inflight_requests', 'rate_limited_until', 'overload_until', 'temp_unschedulable_until', 'last_health_check_at']) {
      assert.equal(columns.includes(column), true, `missing migrated column ${column}`)
    }
    const account = store.getAccount('legacy-account')
    assert.equal(account.provision_generation, 1)
    assert.equal(account.dispatch.inflight_requests, 0)
    assert.equal(account.status, 'error')
    assert.equal(account.error.code, 'process_interrupted')
    assert.equal(store.getRun('legacy-run').status, 'interrupted')
    assert.equal(store.getRun('legacy-run').error.code, 'process_interrupted')
  } finally {
    store.close()
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Windows may release SQLite handles shortly after close. */ }
  }
})
