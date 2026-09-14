import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildReceiptSourceId } from '../src/receipt';
import { processReceiptQueueJobV3 } from '../src/receipt-job-v3';
import { canonicalizeJson, sha256Hex } from '../src/finance-v2/protocol';
import { transitionRuntimeControl } from '../src/finance-v2/persistence';
import type { D1Like, D1StatementLike, Env } from '../src/types';

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
const env = {
  DB: d1,
  AI: { run: async () => { throw new Error('provider must not run for prebuilt artifact'); } },
  FILES: {},
  APP_TIMEZONE: 'Asia/Shanghai',
  AI_MODEL: 'test-model',
  FINANCE_PAGE_TOKEN_SECRET: 'receipt-e2e-page-secret',
  TELEGRAM_OWNER_CHAT_ID: '321'
} as unknown as Env;

await transitionRuntimeControl(d1, 1, { outbox_mode: 'enabled' });
await transitionRuntimeControl(d1, 2, { receipt_route_mode: 'draining_v1' });
await transitionRuntimeControl(d1, 3, { receipt_route_mode: 'v2' });

const photo = { file_id: 'file-v3', file_unique_id: 'unique-v3', width: 1000, height: 1000 };
const sourceId = buildReceiptSourceId(321, photo, 42, 42);
const jobId = sourceId;
const artifactId = `artifact_${sourceId}`;
const providerAttemptId = 'provider-prebuilt-v3';
const turnId = 'turn-prebuilt-v3';
const artifactBody = {
  schema_version: 2 as const,
  receipt_artifact_id: artifactId,
  job_id: jobId,
  turn_id: turnId,
  source_event_id: sourceId,
  attachment_ref: artifactId,
  provider_attempt_id: providerAttemptId,
  job_lease_epoch: 1,
  merchant: '预置超市',
  total_fen: 1250,
  currency: 'CNY' as const,
  occurred_at: '2026-09-08T12:00:00',
  payment_hint: '微信',
  items: [{
    item_key: 'receipt_item_1',
    name: '测试商品',
    quantity: 1,
    unit_price_fen: 1250,
    line_total_fen: 1250,
    raw_category_label: '食品',
    mapped_category: '食品' as const,
    category_mapping_version: 'receipt-item-v1' as const,
    confidence: 1
  }],
  reconciliation: {
    status: 'matched' as const,
    items_total_fen: 1250,
    receipt_total_fen: 1250,
    delta_fen: 0,
    tolerance_fen: 2
  },
  validated_at: '2026-09-08T12:00:00.000Z'
};
const artifact = {
  ...artifactBody,
  artifact_hash: await sha256Hex(canonicalizeJson(artifactBody))
};

db.prepare(
  `INSERT INTO finance_receipt_jobs (
     job_id, ledger_scope_id, turn_id, source_event_id, attachment_ref, caption,
     status, lease_epoch, attempt_count, route_epoch, receipt_artifact_id
   ) VALUES (?, 'personal:primary', ?, ?, ?, NULL, 'artifact_ready', 0, 0, 4, ?)`
).run(jobId, turnId, sourceId, artifactId, artifactId);
db.prepare(
  `INSERT INTO finance_receipt_provider_attempts (
     provider_attempt_id, ledger_scope_id, job_id, provider, job_lease_epoch,
     attempt_number, status, started_at, finished_at
   ) VALUES (?, 'personal:primary', ?, 'veryfi', 1, 1, 'succeeded', ?, ?)`
).run(providerAttemptId, jobId, '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:01.000Z');
db.prepare(
  `INSERT INTO finance_receipt_artifacts (
     receipt_artifact_id, ledger_scope_id, job_id, turn_id, source_event_id,
     attachment_ref, provider_attempt_id, job_lease_epoch, schema_version,
     artifact_json, artifact_hash
   ) VALUES (?, 'personal:primary', ?, ?, ?, ?, ?, 1, 2, ?, ?)`
).run(artifactId, jobId, turnId, sourceId, artifactId, providerAttemptId, canonicalizeJson(artifact), artifact.artifact_hash);
db.prepare(
  `INSERT INTO ingestion_log (id, source, source_id, intent, status, created_at)
   VALUES (?, 'telegram', ?, 'create_transaction', 'queued', CURRENT_TIMESTAMP)`
).run('ingest-v3', jobId);

const result = await processReceiptQueueJobV3(env, {
  chatId: 321,
  messageId: 42,
  updateId: 42,
  photo,
  caption: '',
  localNow: '2026-09-08T12:00:00+08:00'
});
assert.equal(result.ok, true);
assert.ok(result.transactionId);
assert.equal(result.viaOutbox, true);
assert.equal(db.prepare('SELECT status FROM finance_receipt_jobs WHERE job_id = ?').get(jobId).status, 'committed');
assert.equal(db.prepare("SELECT count(*) AS count FROM transactions WHERE source = 'telegram' AND source_id = ?").get(jobId).count, 1);
assert.equal(db.prepare("SELECT count(*) AS count FROM finance_outbox WHERE result_id IN (SELECT result_id FROM finance_turns WHERE turn_id = ?)").get(turnId).count, 1);
assert.equal(db.prepare('SELECT count(*) AS count FROM finance_receipt_provider_attempts WHERE job_id = ?').get(jobId).count, 1);
assert.equal(db.prepare('SELECT context_snapshot_json FROM finance_turns WHERE turn_id = ?').get(turnId).context_snapshot_json !== null, true);

// A route transition can fence the final job-status update after the ledger
// and outbox committed. A retry must reconcile the job without duplicating data.
db.prepare(`UPDATE finance_receipt_jobs
  SET status = 'processing', lease_owner = 'lost-worker', lease_expires_at = ?, completed_at = NULL
  WHERE job_id = ?`).run('2026-09-08T12:10:00.000Z', jobId);
const duplicate = await processReceiptQueueJobV3(env, {
  chatId: 321,
  messageId: 42,
  updateId: 43,
  photo,
  caption: '',
  localNow: '2026-09-08T12:00:00+08:00'
});
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.viaOutbox, true);
assert.equal(db.prepare('SELECT status FROM finance_receipt_jobs WHERE job_id = ?').get(jobId).status, 'committed');
assert.equal(db.prepare("SELECT count(*) AS count FROM transactions WHERE source = 'telegram' AND source_id = ?").get(jobId).count, 1);

const stalePhoto = { file_id: 'file-stale', file_unique_id: 'unique-stale', width: 1000, height: 1000 };
const staleJobId = buildReceiptSourceId(321, stalePhoto, 43, 43);
db.prepare(`INSERT INTO finance_receipt_jobs (
  job_id, ledger_scope_id, turn_id, source_event_id, attachment_ref, caption,
  status, lease_owner, lease_epoch, lease_expires_at, attempt_count, route_epoch
) VALUES (?, 'personal:primary', 'turn-stale', ?, ?, NULL, 'processing', 'old-worker', 1,
  '2099-01-01T00:00:00.000Z', 1, 3)`).run(staleJobId, staleJobId, `artifact_${staleJobId}`);
await assert.rejects(
  processReceiptQueueJobV3(env, {
    chatId: 321, messageId: 43, updateId: 43, photo: stalePhoto, caption: '',
    localNow: '2026-09-08T12:00:00+08:00'
  }),
  /RECEIPT_ROUTE_RETRY/
);
const recoveredJob = db.prepare('SELECT status, route_epoch, lease_owner FROM finance_receipt_jobs WHERE job_id = ?').get(staleJobId);
assert.equal(recoveredJob.status, 'queued');
assert.equal(recoveredJob.route_epoch, 4);
assert.equal(recoveredJob.lease_owner, null);

db.close();
console.log('finance-v2-receipt-e2e.test.ts: PASS');
