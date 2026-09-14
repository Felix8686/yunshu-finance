import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'migrations');
const migrationFiles = fs.readdirSync(migrationDir)
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort();
assert.equal(migrationFiles.length, 9);

function applyMigrations(db: DatabaseSync, from = 0, to = migrationFiles.length): void {
  for (const file of migrationFiles.slice(from, to)) {
    db.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
  }
}

function freshDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  return db;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function scalar<T>(db: DatabaseSync, sql: string, ...values: unknown[]): T {
  const row = db.prepare(sql).get(...values as never[]) as Record<string, T>;
  return Object.values(row)[0];
}

const fresh = freshDatabase();
const upgrade = new DatabaseSync(':memory:');
applyMigrations(upgrade, 0, 7);
applyMigrations(upgrade, 7);
assert.deepEqual(tableColumns(upgrade, 'finance_runtime_control'), tableColumns(fresh, 'finance_runtime_control'));

for (const table of [
  'finance_runtime_control', 'finance_channel_cursors', 'finance_turns', 'finance_sessions',
  'finance_plans', 'finance_result_sets', 'finance_result_set_items', 'finance_results',
  'finance_operations', 'finance_audit_snapshots', 'finance_session_references', 'finance_outbox',
  'finance_receipt_jobs', 'finance_receipt_provider_attempts', 'finance_receipt_artifacts'
]) {
  assert.equal(scalar<number>(fresh, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table), 1, `missing table ${table}`);
}
assert.ok(tableColumns(fresh, 'finance_turns').includes('context_snapshot_hash'));
assert.ok(tableColumns(fresh, 'finance_receipt_jobs').includes('source_event_id'));
assert.ok(tableColumns(fresh, 'finance_receipt_artifacts').includes('artifact_hash'));
assert.ok(tableColumns(fresh, 'finance_fidelity_recovery_log').includes('original_transaction_id'));
assert.ok(!tableColumns(fresh, 'finance_outbox').includes('provider_response_json'));

fresh.prepare(
  `INSERT INTO finance_operations (
     operation_id, ledger_scope_id, idempotency_key, payload_hash, turn_id, session_key,
     operation_type, status, route_epoch
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`
).run('op-1', 'personal:primary', 'idem-1', 'hash-1', 'turn-1', 'api:test', 'create', 1);
assert.throws(() => fresh.prepare(
  `INSERT INTO finance_operations (
     operation_id, ledger_scope_id, idempotency_key, payload_hash, turn_id, session_key,
     operation_type, status, route_epoch
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`
).run('op-2', 'personal:primary', 'idem-1', 'hash-2', 'turn-2', 'api:test', 'create', 1));

fresh.prepare(
  `INSERT INTO finance_results (
     result_id, ledger_scope_id, turn_id, schema_version, operation_type,
     result_json, render_payload_json, render_hash, result_json_bytes
   ) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?)`
).run('result-1', 'personal:primary', 'turn-1', 'query', '{}', '{"schema_version":2,"telegram_parts":[]}', 'a'.repeat(64), 2);
const insertOutbox = fresh.prepare(
  `INSERT INTO finance_outbox (
     outbox_id, ledger_scope_id, result_id, delivery_request_id, part_index, render_hash,
     destination_type, destination_id, status, route_epoch
   ) VALUES (?, ?, ?, ?, ?, ?, 'telegram_owner', ?, 'pending', ?)`
);
insertOutbox.run('outbox-initial-0', 'personal:primary', 'result-1', 'delivery-initial', 0, 'a'.repeat(64), 'owner', 1);
assert.throws(() => insertOutbox.run('outbox-duplicate-0', 'personal:primary', 'result-1', 'delivery-initial', 0, 'a'.repeat(64), 'owner', 1));
insertOutbox.run('outbox-replay-0', 'personal:primary', 'result-1', 'delivery-replay', 0, 'a'.repeat(64), 'owner', 1);
assert.equal(scalar<number>(fresh, 'SELECT count(*) FROM finance_outbox WHERE result_id = ?', 'result-1'), 2);

const resultSetInsert = fresh.prepare(
  `INSERT INTO finance_result_sets (
     result_set_id, ledger_scope_id, plan_id, plan_version, session_key,
     result_set_version, row_count, page_size, sort_filter_fingerprint, snapshot_bytes, expires_at
   ) VALUES (?, ?, ?, 1, ?, 1, 0, 20, ?, ?, ?)`
);
assert.throws(() => resultSetInsert.run('set-too-large', 'personal:primary', 'plan-1', 'api:test', 'b'.repeat(64), 262145, '2026-09-09T00:00:00Z'));
resultSetInsert.run('set-1', 'personal:primary', 'plan-1', 'api:test', 'b'.repeat(64), 2, '2026-09-09T00:00:00Z');
assert.throws(() => fresh.prepare(
  `INSERT INTO finance_result_set_items (
     result_set_id, ordinal, entity_type, entity_id, entity_fingerprint, row_snapshot_json, row_snapshot_bytes
   ) VALUES (?, 1, 'transaction', ?, ?, ?, ?)`
).run('set-1', 'tx-1', 'c'.repeat(64), '{}', 8193));

fresh.prepare(
  `INSERT INTO transactions (
     id, type, amount_fen, currency, account_id, category_id, merchant, description,
     occurred_at, source, source_id, raw_text, created_at, updated_at
   ) VALUES (?, 'expense', 1250, 'CNY', 'account-unspecified', 'cat-expense-food', ?, ?, ?, 'finance_v2', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
).run('tx-delete-1', '测试商户', '测试删除', '2026-09-08T12:00:00', 'source-delete-1', '测试删除');
fresh.prepare(
  `INSERT INTO transaction_items (
     id, transaction_id, name, quantity, unit_price_fen, line_total_fen, category, confidence, created_at
   ) VALUES (?, ?, ?, 1, 1250, 1250, '食品', 1, CURRENT_TIMESTAMP)`
).run('item-delete-1', 'tx-delete-1', '测试商品');
fresh.prepare(
  `INSERT INTO finance_fidelity_recovery_log (
     run_id, original_transaction_id, transaction_id, old_category_id, old_account_id,
     target_category_name, target_account_name, category_changed, account_changed, evidence_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
).run('run-1', 'tx-delete-1', 'tx-delete-1', 'cat-expense-food', 'account-unspecified', '餐饮', '未指定', '{"evidence":true}');
fresh.prepare('DELETE FROM transactions WHERE id = ?').run('tx-delete-1');
assert.equal(scalar<number>(fresh, 'SELECT count(*) FROM transaction_items WHERE transaction_id = ?', 'tx-delete-1'), 0);
const recovery = fresh.prepare(
  `SELECT original_transaction_id, transaction_id, evidence_json
     FROM finance_fidelity_recovery_log WHERE run_id = ? AND original_transaction_id = ?`
).get('run-1', 'tx-delete-1') as { original_transaction_id: string; transaction_id: string | null; evidence_json: string };
assert.equal(recovery.original_transaction_id, 'tx-delete-1');
assert.equal(recovery.transaction_id, null);
assert.equal(recovery.evidence_json, '{"evidence":true}');

fresh.close();
upgrade.close();
console.log('finance-v2-migrations.test.ts: PASS');
