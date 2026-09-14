import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApiFinanceTurn } from '../src/finance-v2/turn';
import {
  reserveTurn,
  settleRolloutInterruptedOperations,
  transitionRuntimeControl
} from '../src/finance-v2/persistence';
import type { D1Like, D1StatementLike } from '../src/types';

class SqliteStatement implements D1StatementLike {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: unknown[] = []) {}

  bind(...values: unknown[]): D1StatementLike {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values as never[]) as T | undefined) ?? null;
  }

  async run(): Promise<unknown> {
    const result = this.db.prepare(this.sql).run(...this.values as never[]);
    return { meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] };
  }
}

class SqliteD1 implements D1Like {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): D1StatementLike {
    return new SqliteStatement(this.db, query);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    this.db.exec('BEGIN');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');
for (const file of fs.readdirSync(path.join(root, 'migrations')).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
  db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
}
const d1 = new SqliteD1(db);

const reservedTurn = await buildApiFinanceTurn({
  requestId: 'rollback-reserved',
  sessionKey: 'api:rollback',
  baseSessionVersion: 0,
  text: '旧版本保留请求'
});
const executingTurn = await buildApiFinanceTurn({
  requestId: 'rollback-executing',
  sessionKey: 'api:rollback',
  baseSessionVersion: 0,
  text: '旧版本执行请求'
});
await reserveTurn(d1, reservedTurn);
await reserveTurn(d1, executingTurn);

db.prepare(
  `INSERT INTO finance_operations (
     operation_id, ledger_scope_id, idempotency_key, payload_hash, turn_id, session_key,
     operation_type, status, lease_owner, lease_epoch, attempt_count, route_epoch
   ) VALUES (?, 'personal:primary', ?, ?, ?, ?, 'create', 'reserved', NULL, 0, 0, 1)`
).run('op-rollout-reserved', 'rollback-idem-1', 'rollback-hash-1', reservedTurn.turn_id, reservedTurn.session_key);
db.prepare(
  `INSERT INTO finance_operations (
     operation_id, ledger_scope_id, idempotency_key, payload_hash, turn_id, session_key,
     operation_type, status, lease_owner, lease_epoch, attempt_count, route_epoch, lease_expires_at
   ) VALUES (?, 'personal:primary', ?, ?, ?, ?, 'update', 'executing', 'old-worker', 1, 1, 1, ?)`
).run('op-rollout-executing', 'rollback-idem-2', 'rollback-hash-2', executingTurn.turn_id, executingTurn.session_key, new Date(Date.now() + 60_000).toISOString());

await transitionRuntimeControl(d1, 1, { finance_route_mode: 'shadow_v2' });
assert.equal(await settleRolloutInterruptedOperations(d1), 2);
assert.equal(await settleRolloutInterruptedOperations(d1), 0);

const operations = db.prepare(
  `SELECT operation_id, status, error_code, result_id
     FROM finance_operations WHERE operation_id LIKE 'op-rollout-%' ORDER BY operation_id`
).all() as Array<{ operation_id: string; status: string; error_code: string; result_id: string }>;
assert.deepEqual(operations.map((row) => row.status), ['failed_terminal', 'failed_terminal']);
assert.deepEqual(operations.map((row) => row.error_code), ['rollout_interrupted', 'rollout_interrupted']);
assert.ok(operations.every((row) => row.result_id.startsWith('rollout_op-rollout-')));
assert.equal(db.prepare("SELECT count(*) AS count FROM finance_results WHERE operation_id LIKE 'op-rollout-%'").get().count, 2);
assert.equal(db.prepare("SELECT count(*) AS count FROM finance_turns WHERE result_id LIKE 'rollout_op-rollout-%' AND completed_at IS NOT NULL").get().count, 2);
const result = db.prepare("SELECT result_json, render_payload_json FROM finance_results WHERE result_id = 'rollout_op-rollout-reserved'").get() as { result_json: string; render_payload_json: string };
assert.match(result.result_json, /rollout_interrupted/);
assert.match(result.render_payload_json, /版本切换期间请求被中止/);

db.close();
console.log('finance-v2-rollback.test.ts: PASS');
