import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/app';
import { buildApiFinanceTurn } from '../src/finance-v2/turn';
import { handleFinanceV2Turn } from '../src/finance-v2/service';
import { ensureSession, loadSession, markSessionCompatibilityInterrupted, readRuntimeControl, transitionRuntimeControl } from '../src/finance-v2/persistence';
import type { D1Like, D1StatementLike, Env } from '../src/types';

class SqliteStatement implements D1StatementLike {
  constructor(private readonly db: DatabaseSync, readonly sql: string, private readonly values: unknown[] = []) {}

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
  beforeCommit?: () => void;
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1StatementLike {
    return new SqliteStatement(this.sqlite, query);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    if (this.beforeCommit && statements.some((statement) => statement instanceof SqliteStatement && statement.sql.includes('write_assertion'))) {
      const hook = this.beforeCommit;
      this.beforeCommit = undefined;
      hook();
    }
    this.sqlite.exec('BEGIN');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
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
const env = {
  DB: d1,
  AI: { run: async () => { throw new Error('AI should not be called by structured E2E'); } },
  FILES: {},
  APP_TIMEZONE: 'Asia/Shanghai',
  AI_MODEL: 'test-model',
  FINANCE_PAGE_TOKEN_SECRET: 'in-memory-test-secret',
  TELEGRAM_OWNER_CHAT_ID: 'owner-chat',
  API_BEARER_TOKEN: 'api-test-token',
  TELEGRAM_WEBHOOK_SECRET: 'telegram-test-secret',
  TELEGRAM_OWNER_USER_ID: 'owner-user'
} as unknown as Env;

await transitionRuntimeControl(d1, 1, { finance_route_mode: 'shadow_v2', outbox_mode: 'enabled' });
await transitionRuntimeControl(d1, 2, { finance_route_mode: 'canary_v2' });
await transitionRuntimeControl(d1, 3, { finance_route_mode: 'primary_v2' });
const runtime = await readRuntimeControl(d1);
assert.equal(runtime.finance_route_mode, 'primary_v2');
assert.equal(runtime.outbox_mode, 'enabled');

const optionsResponse = await worker.fetch(new Request('https://test.local/v2/finance', { method: 'OPTIONS' }), env);
assert.equal(optionsResponse.status, 204);
const runtimeResponse = await worker.fetch(new Request('https://test.local/v2/finance/runtime', {
  headers: { Authorization: 'Bearer api-test-token' }
}), env);
assert.equal(runtimeResponse.status, 200);
const runtimeBody = await runtimeResponse.json() as { ok: boolean; data?: { runtime?: { finance_route_mode?: string } } };
assert.equal(runtimeBody.ok, true);
assert.equal(runtimeBody.data?.runtime?.finance_route_mode, 'primary_v2');
const unauthorizedResponse = await worker.fetch(new Request('https://test.local/v2/finance', { method: 'POST' }), env);
assert.equal(unauthorizedResponse.status, 401);

const terminalErrorOwnerChatId = env.TELEGRAM_OWNER_CHAT_ID;
const terminalErrorOwnerUserId = env.TELEGRAM_OWNER_USER_ID;
env.TELEGRAM_OWNER_CHAT_ID = '10001';
env.TELEGRAM_OWNER_USER_ID = '10002';
(env as unknown as { __mockFinancePlan?: unknown }).__mockFinancePlan = {
  kind: 'clarification',
  clarification: { message: '需要补充测试信息' }
};
const previousReceiptQueue = env.RECEIPT_QUEUE;
env.RECEIPT_QUEUE = { send: async () => undefined };
const terminalErrorWebhookResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 9001,
    message: {
      message_id: 9001,
      date: 1788868800,
      chat: { id: 10001, type: 'private' },
      from: { id: 10002 },
      text: '终态错误 webhook 确认测试'
    }
  })
}), env);
assert.equal(terminalErrorWebhookResponse.status, 200,
  'Telegram must acknowledge a persisted terminal Finance V2 error');
const terminalErrorWebhookBody = await terminalErrorWebhookResponse.json() as { ok?: boolean; finance_v2?: boolean };
assert.equal(terminalErrorWebhookBody.ok, false);
assert.equal(terminalErrorWebhookBody.finance_v2, true);
env.RECEIPT_QUEUE = previousReceiptQueue;
delete (env as unknown as { __mockFinancePlan?: unknown }).__mockFinancePlan;
env.TELEGRAM_OWNER_CHAT_ID = terminalErrorOwnerChatId;
env.TELEGRAM_OWNER_USER_ID = terminalErrorOwnerUserId;

function scalar<T>(sql: string, ...values: unknown[]): T {
  const row = db.prepare(sql).get(...values as never[]) as Record<string, T>;
  return Object.values(row)[0];
}

function planBase(turnId: string, baseSessionVersion: number, planId: string, operation: string): Record<string, unknown> {
  return {
    schema_version: 2,
    plan_id: planId,
    plan_version: 1,
    base_session_version: baseSessionVersion,
    source_turn_id: turnId,
    ledger_scope_id: 'personal:primary',
    confidence: 0.99,
    presentation: { mode: operation === 'query' ? 'details' : 'summary', page_size: 10 },
    operation
  };
}

const createTurn = await buildApiFinanceTurn({
  requestId: 'in-memory-create',
  sessionKey: 'api:in-memory-e2e',
  baseSessionVersion: 0,
  text: '结构化创建'
});
const createResponse = await handleFinanceV2Turn(env, createTurn, {
  telegramDestinationId: 'owner-chat',
  structuredPlan: {
    ...planBase(createTurn.turn_id, 0, 'plan-in-memory-create', 'create'),
    entries: [{
      client_entry_key: 'entry-1',
      type: 'expense',
      money: { amount_fen: 1250, currency: 'CNY' },
      occurred_at: '2026-09-08T12:00:00+08:00',
      account: { kind: 'account', value: '未指定' },
      category: { kind: 'category', value: '餐饮' },
      merchant: '内存测试商户',
      description: 'V2 in-memory E2E',
      items: [{
        client_item_key: 'item-1',
        name: '测试商品',
        quantity: 1,
        unit_price_fen: 1250,
        line_total_fen: 1250,
        category: '食品',
        confidence: 1
      }]
    }]
  }
});
assert.equal(createResponse.result.kind, 'success');
assert.equal(createResponse.result.commit_status, 'committed');
assert.equal(createResponse.result.transaction_ids?.length, 1);
assert.equal(scalar<number>('SELECT count(*) FROM transactions WHERE source = \'finance_v2\''), 1);
assert.equal(scalar<number>('SELECT count(*) FROM finance_outbox WHERE result_id = ?', createResponse.result.result_id), 1);
const transactionId = createResponse.result.transaction_ids?.[0];
const createOperationId = createResponse.operation_id;
assert.ok(transactionId && createOperationId);

// Simulate a session CAS losing after ledger statements have run. The whole
// database batch must roll back, not just return an error after committing.
db.exec(`CREATE TRIGGER lose_session_cas BEFORE UPDATE ON finance_sessions
  WHEN OLD.session_key = 'api:atomic-conflict'
  BEGIN SELECT RAISE(IGNORE); END`);
const conflictTurn = await buildApiFinanceTurn({
  requestId: 'atomic-conflict', sessionKey: 'api:atomic-conflict', baseSessionVersion: 0, text: '冲突回滚'
});
const beforeConflictCount = scalar<number>('SELECT count(*) FROM transactions');
const conflictResponse = await handleFinanceV2Turn(env, conflictTurn, {
  structuredPlan: {
    ...planBase(conflictTurn.turn_id, 0, 'plan-atomic-conflict', 'create'),
    entries: [{ client_entry_key: 'conflict-entry', type: 'expense',
      money: { amount_fen: 100, currency: 'CNY' }, occurred_at: '2026-09-08T12:00:00+08:00',
      account: { kind: 'account', value: '未指定' }, category: { kind: 'category', value: '餐饮' },
      merchant: 'atomic-conflict', description: 'must roll back' }]
  }
});
assert.equal(conflictResponse.result.kind, 'error');
assert.equal(scalar<number>('SELECT count(*) FROM transactions'), beforeConflictCount,
  'failed session CAS must roll back all preceding ledger writes');
assert.equal(scalar<number>("SELECT count(*) FROM finance_operations WHERE turn_id = ? AND status = 'committed'", conflictTurn.turn_id), 0);
db.exec('DROP TRIGGER lose_session_cas');

const invalidTurn = await buildApiFinanceTurn({
  requestId: 'in-memory-invalid',
  sessionKey: 'api:in-memory-e2e',
  baseSessionVersion: 1,
  text: '结构化错误'
});
const invalidResponse = await handleFinanceV2Turn(env, invalidTurn, {
  telegramDestinationId: 'owner-chat',
  structuredPlan: {
    ...planBase(invalidTurn.turn_id, 1, 'plan-in-memory-invalid', 'create')
  }
});
assert.equal(invalidResponse.result.kind, 'error');
assert.ok(invalidResponse.render_payload);
assert.equal(scalar<number>('SELECT count(*) FROM finance_outbox WHERE result_id = ?', invalidResponse.result.result_id), 1);

await markSessionCompatibilityInterrupted(d1, 'personal:primary', 'api:in-memory-e2e');
const interruptedSession = await loadSession(d1, 'personal:primary', 'api:in-memory-e2e');
assert.equal(interruptedSession?.compatibility_interrupted, 1);

const httpResponse = await worker.fetch(new Request('https://test.local/v2/finance', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer api-test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'http-in-memory-create'
  },
  body: JSON.stringify({
    request_id: 'http-in-memory-create',
    session_key: 'api:http-in-memory-e2e',
    base_session_version: 0,
    plan: {
      schema_version: 2,
      plan_id: 'plan-http-in-memory-create',
      plan_version: 1,
      ledger_scope_id: 'personal:primary',
      confidence: 0.99,
      presentation: { mode: 'summary' },
      operation: 'create',
      entries: [{
        client_entry_key: 'http-entry-1',
        type: 'expense',
        money: { amount_fen: 880, currency: 'CNY' },
        occurred_at: '2026-09-08T13:00:00+08:00',
        account: { kind: 'account', value: '未指定' },
        category: { kind: 'category', value: '餐饮' },
        merchant: 'HTTP测试商户',
        description: 'HTTP structured E2E',
        items: []
      }]
    }
  })
}), env);
assert.equal(httpResponse.status, 200);
const httpBody = await httpResponse.json() as { ok: boolean; result?: { kind?: string; commit_status?: string } };
assert.equal(httpBody.ok, true);
assert.equal(httpBody.result?.kind, 'success');
assert.equal(httpBody.result?.commit_status, 'committed');

const replayOne = await handleFinanceV2Turn(env, createTurn, {
  telegramDestinationId: 'owner-chat',
  delivery: { kind: 'replay', replayIdempotencyKey: 'replay-in-memory-1' }
});
assert.equal(replayOne.duplicate, true);
assert.equal(scalar<number>('SELECT count(*) FROM finance_outbox WHERE result_id = ?', createResponse.result.result_id), 2);
const replayTwo = await handleFinanceV2Turn(env, createTurn, {
  telegramDestinationId: 'owner-chat',
  delivery: { kind: 'replay', replayIdempotencyKey: 'replay-in-memory-1' }
});
assert.equal(replayTwo.duplicate, true);
assert.equal(scalar<number>('SELECT count(*) FROM finance_outbox WHERE result_id = ?', createResponse.result.result_id), 2);

const matrixScope = {
  from: '2026-09-01T00:00:00+08:00',
  to: '2026-09-09T00:00:00+08:00',
  timezone: 'Asia/Shanghai' as const,
  end_exclusive: true as const
};
async function matrixCall(operation: string, extra: Record<string, unknown>) {
  const session = await loadSession(d1, 'personal:primary', 'api:service-matrix');
  const baseSessionVersion = session?.session_version || 0;
  const turn = await buildApiFinanceTurn({
    requestId: `service-matrix-${operation}`,
    sessionKey: 'api:service-matrix',
    baseSessionVersion,
    text: `服务矩阵 ${operation}`
  });
  const response = await handleFinanceV2Turn(env, turn, {
    structuredPlan: {
      ...planBase(turn.turn_id, baseSessionVersion, `plan-service-matrix-${operation}`, operation),
      presentation: { mode: operation === 'compare' ? 'comparison' : operation === 'analyze' ? 'analysis' : operation === 'query' ? 'details' : 'summary' },
      ...extra
    }
  });
  assert.equal(response.result.kind, 'success', `${operation} must execute through the service`);
  return { response, turn };
}
const matrixCreate = await matrixCall('create', {
  entries: [{
    client_entry_key: 'matrix-entry-1',
    type: 'expense',
    money: { amount_fen: 660, currency: 'CNY' },
    occurred_at: '2026-09-08T10:00:00+08:00',
    account: { kind: 'account', value: '未指定' },
    category: { kind: 'category', value: '餐饮' },
    merchant: '服务矩阵商户',
    description: '服务执行矩阵',
    items: []
  }]
});
const matrixTransactionId = matrixCreate.response.result.kind === 'success' ? matrixCreate.response.result.transaction_ids?.[0] : undefined;
assert.ok(matrixTransactionId);
const matrixQuery = await matrixCall('query', { filters: { merchant_text: '服务矩阵商户' }, temporal_scope: matrixScope, reference: null });
await matrixCall('summarize', { filters: { merchant_text: '服务矩阵商户' }, temporal_scope: matrixScope, reference: null });
await matrixCall('analyze', { filters: { merchant_text: '服务矩阵商户' }, temporal_scope: matrixScope, metric: 'expense', dimension: 'category', reference: null });
await matrixCall('compare', {
  left_scope: matrixScope,
  right_scope: { ...matrixScope, from: '2026-08-01T00:00:00+08:00', to: '2026-09-01T00:00:00+08:00' },
  filters: { merchant_text: '服务矩阵商户' },
  metric: 'expense',
  dimension: 'none',
  reference: null
});
await matrixCall('update', {
  filters: { merchant_text: '服务矩阵商户' },
  selection: { mode: 'exactly_one' },
  changes: { merchant: '服务矩阵已更新' }
});
assert.equal(scalar<string>('SELECT merchant FROM transactions WHERE id = ?', matrixTransactionId), '服务矩阵已更新');

async function rejectedMutation(
  requestId: string,
  sessionKey: string,
  operation: 'update' | 'delete',
  extra: Record<string, unknown>
) {
  const session = await loadSession(d1, 'personal:primary', sessionKey);
  const baseSessionVersion = session?.session_version || 0;
  const turn = await buildApiFinanceTurn({ requestId, sessionKey, baseSessionVersion, text: '结构化拒绝测试' });
  const beforeTransactions = scalar<number>('SELECT count(*) FROM transactions');
  const beforeItems = scalar<number>('SELECT count(*) FROM transaction_items');
  const response = await handleFinanceV2Turn(env, turn, {
    structuredPlan: {
      ...planBase(turn.turn_id, baseSessionVersion, `plan-${requestId}`, operation),
      filters: {},
      ...extra
    }
  });
  assert.equal(response.result.kind, 'error', `${requestId} must fail closed`);
  assert.equal(scalar<number>('SELECT count(*) FROM transactions'), beforeTransactions);
  assert.equal(scalar<number>('SELECT count(*) FROM transaction_items'), beforeItems);
  return response;
}

await rejectedMutation('untrusted-direct-transaction', 'api:untrusted-direct-transaction', 'update', {
  selection: { mode: 'reference', reference: { kind: 'transaction', transaction_id: matrixTransactionId } },
  changes: { merchant: 'untrusted-overwrite' }
});
assert.equal(scalar<string>('SELECT merchant FROM transactions WHERE id = ?', matrixTransactionId), '服务矩阵已更新');

const existingItemId = scalar<string>('SELECT id FROM transaction_items WHERE transaction_id = ? LIMIT 1', transactionId);
await rejectedMutation('untrusted-direct-item', 'api:untrusted-direct-item', 'delete', {
  selection: { mode: 'reference', reference: { kind: 'transaction_item', item_id: existingItemId } }
});
assert.equal(scalar<number>('SELECT count(*) FROM transaction_items WHERE id = ?', existingItemId), 1);

await rejectedMutation('all-matching-empty-filters', 'api:all-matching-empty-filters', 'delete', {
  selection: { mode: 'all_matching' }
});

const staleResultSetId = matrixQuery.response.result.kind === 'success'
  ? matrixQuery.response.result.result_set_id
  : undefined;
assert.ok(staleResultSetId);
await rejectedMutation('stale-result-fingerprint', 'api:service-matrix', 'delete', {
  selection: { mode: 'reference', reference: { kind: 'result_ordinal', result_set_id: staleResultSetId, ordinal: 1 } }
});
assert.equal(scalar<number>('SELECT count(*) FROM transactions WHERE id = ?', matrixTransactionId), 1);

const matrixDelete = await matrixCall('delete', {
  filters: {},
  selection: { mode: 'reference', reference: { kind: 'transaction', transaction_id: matrixTransactionId } }
});
assert.equal(scalar<number>('SELECT count(*) FROM transactions WHERE id = ?', matrixTransactionId), 0);
await matrixCall('restore', { reference: { kind: 'operation', operation_id: matrixDelete.response.operation_id } });
assert.equal(scalar<number>('SELECT count(*) FROM transactions WHERE id = ?', matrixTransactionId), 1);

const rowConflictSession = await loadSession(d1, 'personal:primary', 'api:service-matrix');
const rowConflictVersion = rowConflictSession?.session_version || 0;
const rowConflictTurn = await buildApiFinanceTurn({
  requestId: 'row-conflict',
  sessionKey: 'api:service-matrix',
  baseSessionVersion: rowConflictVersion
});
d1.beforeCommit = () => { db.prepare('UPDATE transactions SET merchant = ? WHERE id = ?').run('concurrent-winner', matrixTransactionId); };
const rowConflict = await handleFinanceV2Turn(env, rowConflictTurn, {
  structuredPlan: { ...planBase(rowConflictTurn.turn_id, rowConflictVersion, 'row-conflict-plan', 'update'), filters: {},
    selection: { mode: 'reference', reference: { kind: 'transaction', transaction_id: matrixTransactionId } },
    changes: { merchant: 'stale-overwrite' } }
});
assert.equal(rowConflict.result.kind, 'error');
assert.equal(scalar<string>('SELECT merchant FROM transactions WHERE id = ?', matrixTransactionId), 'concurrent-winner',
  'a cross-session write after selection must not be overwritten');

const queryTurn = await buildApiFinanceTurn({
  requestId: 'in-memory-query',
  sessionKey: 'api:in-memory-e2e',
  baseSessionVersion: 1,
  text: '查询本月'
});
const queryResponse = await handleFinanceV2Turn(env, queryTurn, {
  structuredPlan: {
    ...planBase(queryTurn.turn_id, 1, 'plan-in-memory-query', 'query'),
    filters: { merchant_text: '内存测试商户' },
    temporal_scope: {
      from: '2026-09-01T00:00:00+08:00',
      to: '2026-09-09T00:00:00+08:00',
      timezone: 'Asia/Shanghai',
      end_exclusive: true
    },
    reference: null
  }
});
assert.equal(queryResponse.result.kind, 'success');
assert.equal(queryResponse.result.rows?.length, 1);
assert.equal(queryResponse.result.commit_status, 'not_required');
const resumedSession = await loadSession(d1, 'personal:primary', 'api:in-memory-e2e');
assert.equal(resumedSession?.compatibility_interrupted, 0);

db.prepare(
  `INSERT INTO finance_fidelity_recovery_log (
     run_id, original_transaction_id, transaction_id, old_category_id, old_account_id,
     target_category_name, target_account_name, category_changed, account_changed, evidence_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
).run('e2e-run', transactionId, transactionId, 'cat-expense-food', 'account-unspecified', '餐饮', '未指定', '{"source":"e2e"}');

const deleteTurn = await buildApiFinanceTurn({
  requestId: 'in-memory-delete',
  sessionKey: 'api:in-memory-e2e',
  baseSessionVersion: 2,
  text: '删除这笔'
});
const deleteResponse = await handleFinanceV2Turn(env, deleteTurn, {
  structuredPlan: {
    ...planBase(deleteTurn.turn_id, 2, 'plan-in-memory-delete', 'delete'),
    filters: {},
    selection: { mode: 'reference', reference: { kind: 'transaction', transaction_id: transactionId } }
  }
});
assert.equal(deleteResponse.result.kind, 'success');
assert.equal(deleteResponse.result.commit_status, 'committed');
assert.equal(scalar<number>('SELECT count(*) FROM transactions WHERE id = ?', transactionId), 0);
assert.equal(scalar<number>('SELECT count(*) FROM transaction_items WHERE transaction_id = ?', transactionId), 0);
const deletedRecovery = db.prepare(
  `SELECT original_transaction_id, transaction_id, evidence_json
     FROM finance_fidelity_recovery_log WHERE run_id = 'e2e-run'`
).get() as { original_transaction_id: string; transaction_id: string | null; evidence_json: string };
assert.equal(deletedRecovery.original_transaction_id, transactionId);
assert.equal(deletedRecovery.transaction_id, null);
assert.equal(deletedRecovery.evidence_json, '{"source":"e2e"}');
const deleteAudit = db.prepare(
  `SELECT before_json, child_set_json FROM finance_audit_snapshots WHERE operation_id = ? AND before_json IS NOT NULL`
).get(deleteResponse.operation_id) as { before_json: string; child_set_json: string };
assert.match(deleteAudit.before_json, /测试商品/);
assert.match(deleteAudit.child_set_json, /测试商品/);

const restoreTurn = await buildApiFinanceTurn({
  requestId: 'in-memory-restore',
  sessionKey: 'api:in-memory-e2e',
  baseSessionVersion: 3,
  text: '恢复这笔'
});
const restoreResponse = await handleFinanceV2Turn(env, restoreTurn, {
  structuredPlan: {
    ...planBase(restoreTurn.turn_id, 3, 'plan-in-memory-restore', 'restore'),
    reference: { kind: 'operation', operation_id: deleteResponse.operation_id }
  }
});
assert.equal(restoreResponse.result.kind, 'success');
assert.equal(restoreResponse.result.commit_status, 'committed');
assert.equal(scalar<number>('SELECT count(*) FROM transactions WHERE id = ?', transactionId), 1);
assert.equal(scalar<number>('SELECT count(*) FROM transaction_items WHERE transaction_id = ?', transactionId), 1);

await transitionRuntimeControl(d1, (await readRuntimeControl(d1)).config_epoch, { outbox_mode: 'draining' });
const outboxRowsBeforeDrainingReplay = scalar<number>('SELECT count(*) FROM finance_outbox WHERE result_id = ?', createResponse.result.result_id);
await assert.rejects(
  handleFinanceV2Turn(env, createTurn, {
    telegramDestinationId: 'owner-chat',
    delivery: { kind: 'replay', replayIdempotencyKey: 'replay-during-draining' }
  }),
  /OUTBOX_NOT_ENABLED/
);
assert.equal(scalar<number>('SELECT count(*) FROM finance_outbox WHERE result_id = ?', createResponse.result.result_id), outboxRowsBeforeDrainingReplay);
await transitionRuntimeControl(d1, (await readRuntimeControl(d1)).config_epoch, { outbox_mode: 'enabled' });

env.TELEGRAM_OWNER_CHAT_ID = '999';
env.TELEGRAM_OWNER_USER_ID = '999';
await ensureSession(d1, 'personal:primary', 'telegram:999:topic:0');
const receiptCompatibilityResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 997,
    message: {
      message_id: 997,
      date: 1788868800,
      chat: { id: 999, type: 'private' },
      from: { id: 999 },
      photo: [{ file_id: 'file-compat', file_unique_id: 'unique-compat', width: 100, height: 100 }]
    }
  })
}), env);
assert.equal(receiptCompatibilityResponse.status, 200);
const receiptCompatibilitySession = await loadSession(d1, 'personal:primary', 'telegram:999:topic:0');
assert.equal(receiptCompatibilitySession?.compatibility_interrupted, 1);

await transitionRuntimeControl(d1, (await readRuntimeControl(d1)).config_epoch, { receipt_route_mode: 'draining_v1' });
const receiptDrainingResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 998,
    message: {
      message_id: 998,
      date: 1788868800,
      chat: { id: 999, type: 'private' },
      from: { id: 999 },
      caption: '记一笔',
      photo: [{ file_id: 'file-1', file_unique_id: 'unique-1', width: 100, height: 100 }]
    }
  })
}), env);
assert.equal(receiptDrainingResponse.status, 503);

await transitionRuntimeControl(d1, (await readRuntimeControl(d1)).config_epoch, { finance_route_mode: 'draining_v2' });
const drainingResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 999,
    message: {
      message_id: 999,
      date: 1788868800,
      chat: { id: 999, type: 'private' },
      from: { id: 999 },
      text: '记一笔'
    }
  })
}), env);
assert.equal(drainingResponse.status, 503);
await transitionRuntimeControl(d1, (await readRuntimeControl(d1)).config_epoch, { finance_route_mode: 'primary_v1' });
const mockIntake = {
  intent: 'create_transaction',
  confidence: 0.99,
  transactions: [{
    transaction_type: 'expense',
    amount: 12.5,
    currency: 'CNY',
    category_name: '餐饮',
    account_name: '未指定',
    merchant: 'V1回退商户',
    description: 'V1应用回退E2E',
    occurred_at: '2026-09-08T14:00:00+08:00'
  }]
};
(env as unknown as { __mockParsedIntake?: unknown }).__mockParsedIntake = mockIntake;
const v1FallbackResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 9990,
    message: {
      message_id: 9990,
      date: 1788868800,
      chat: { id: 999, type: 'private' },
      from: { id: 999 },
      text: 'V1回退应用链路测试'
    }
  })
}), env);
assert.equal(v1FallbackResponse.status, 200);
assert.equal(scalar<number>('SELECT count(*) FROM transactions WHERE source = \'telegram\' AND source_id = ?', 'tg_9990'), 1);
delete (env as unknown as { __mockParsedIntake?: unknown }).__mockParsedIntake;
await transitionRuntimeControl(d1, (await readRuntimeControl(d1)).config_epoch, { finance_route_mode: 'shadow_v2' });
const shadowUnavailableResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 9991,
    message: {
      message_id: 9991,
      date: 1788868800,
      chat: { id: 999, type: 'private' },
      from: { id: 999 },
      text: '影子路由测试'
    }
  })
}), env);
assert.equal(shadowUnavailableResponse.status, 503);
const shadowUnavailableBody = await shadowUnavailableResponse.json() as { error?: string };
assert.equal(shadowUnavailableBody.error, 'SHADOW_DB_NOT_CONFIGURED');
await transitionRuntimeControl(d1, (await readRuntimeControl(d1)).config_epoch, { finance_route_mode: 'primary_v1' });
let pumpAcks = 0;
let pumpRetries = 0;
const pumpMessages: unknown[] = [];
db.prepare("UPDATE finance_outbox SET status = 'accepted' WHERE status IN ('pending', 'failed_retryable')").run();
env.RECEIPT_QUEUE = { send: async (message: unknown) => { pumpMessages.push(message); } };
await worker.queue({ messages: [{
  body: { kind: 'finance_outbox_dispatch' },
  ack: () => { pumpAcks += 1; }, retry: () => { pumpRetries += 1; }
}] }, env);
assert.equal(pumpAcks, 1);
assert.equal(pumpRetries, 0);
assert.equal(pumpMessages.length, 0, 'an empty outbox must not create an endless queue loop');
delete env.RECEIPT_QUEUE;
db.prepare('DELETE FROM finance_runtime_control').run();
const unavailableRuntimeResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 1000,
    message: {
      message_id: 1000,
      date: 1788868800,
      chat: { id: 999, type: 'private' },
      from: { id: 999 },
      text: '记一笔'
    }
  })
}), env);
assert.equal(unavailableRuntimeResponse.status, 503);
let queueRetries = 0;
let queueAcks = 0;
await worker.queue({
  messages: [{
    body: {
      chatId: 999,
      threadId: null,
      messageId: 1001,
      updateId: 1001,
      photo: { file_id: 'file-2', file_unique_id: 'unique-2', width: 100, height: 100 },
      caption: '',
      localNow: '2026-09-08T12:00:00+08:00'
    },
    ack: () => { queueAcks += 1; },
    retry: () => { queueRetries += 1; }
  }]
}, env);
assert.equal(queueRetries, 1);
assert.equal(queueAcks, 0);

db.close();
console.log('finance-v2-inmemory-e2e.test.ts: PASS');
