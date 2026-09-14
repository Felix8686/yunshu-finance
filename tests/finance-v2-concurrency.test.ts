import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApiFinanceTurn } from '../src/finance-v2/turn';
import {
  ensureSession,
  reserveTurn,
  updateSessionProjection
} from '../src/finance-v2/persistence';
import type { D1Like, D1StatementLike } from '../src/types';

class SqliteStatement implements D1StatementLike {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: unknown[] = []) {}

  bind(...values: unknown[]): D1StatementLike {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values as never[]) as T | undefined;
    return row ?? null;
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
const migrationDir = path.join(root, 'migrations');
const db = new DatabaseSync(':memory:');
for (const file of fs.readdirSync(migrationDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
  db.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
}
const d1 = new SqliteD1(db);

const turnA = await buildApiFinanceTurn({
  requestId: 'concurrent-idempotency',
  sessionKey: 'api:concurrency',
  baseSessionVersion: 0,
  text: '并发幂等测试'
});
const turnB = await buildApiFinanceTurn({
  requestId: 'concurrent-idempotency',
  sessionKey: 'api:concurrency',
  baseSessionVersion: 0,
  text: '并发幂等测试'
});
const turnResults = await Promise.all([
  reserveTurn(d1, turnA),
  reserveTurn(d1, turnB)
]);
assert.equal(turnResults.filter((result) => result.created).length, 1);
assert.equal(turnResults.filter((result) => !result.created).length, 1);
assert.equal(
  new Set(turnResults.map((result) => result.turn_id)).size,
  1,
  'all concurrent idempotent callers must converge on one turn'
);

const identityBase = { requestId: 'identity-plan', sessionKey: 'api:identity', text: 'same text', baseSessionVersion: 0 };
const identityA = await buildApiFinanceTurn({ ...identityBase, structuredPayload: { amount: 100 } });
const identityB = await buildApiFinanceTurn({ ...identityBase, structuredPayload: { amount: 200 } });
assert.notEqual(identityA.payload_hash, identityB.payload_hash, 'changed plan must not replay a previous result');
const patchA = await buildApiFinanceTurn({ ...identityBase, structuredPatch: { value: 1 } });
const patchB = await buildApiFinanceTurn({ ...identityBase, structuredPatch: { value: 2 } });
assert.notEqual(patchA.payload_hash, patchB.payload_hash, 'changed patch must not replay a previous result');
const otherSession = await buildApiFinanceTurn({ ...identityBase, sessionKey: 'api:other', structuredPayload: { amount: 100 } });
assert.notEqual(identityA.payload_hash, otherSession.payload_hash);
const canonicalA = await buildApiFinanceTurn({ ...identityBase, structuredPayload: { a: 1, b: 2 } });
const canonicalB = await buildApiFinanceTurn({ ...identityBase, structuredPayload: { b: 2, a: 1 } });
assert.equal(canonicalA.payload_hash, canonicalB.payload_hash);

await ensureSession(d1, 'personal:primary', 'api:concurrency');
const projectionInput = {
  ledger_scope_id: 'personal:primary',
  session_key: 'api:concurrency',
  expected_session_version: 0,
  active_plan_id: 'plan-concurrent',
  active_plan_version: 1,
  last_turn_id: turnA.turn_id
};
const projections = await Promise.allSettled([
  updateSessionProjection(d1, projectionInput),
  updateSessionProjection(d1, projectionInput)
]);
assert.equal(projections.filter((result) => result.status === 'fulfilled').length, 1);
const rejected = projections.find((result) => result.status === 'rejected');
assert.ok(rejected && rejected.status === 'rejected');
assert.match(String(rejected.reason), /SESSION_CAS_CONFLICT/);

const session = await ensureSession(d1, 'personal:primary', 'api:concurrency');
assert.equal(session.session_version, 1);
assert.equal(session.active_plan_id, 'plan-concurrent');

db.close();
console.log('finance-v2-concurrency.test.ts: PASS');
