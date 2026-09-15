import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { D1Like, D1StatementLike, Env } from '../src/types';
import { auditV3ReadToolCall, V3ReadAuditError } from '../src/finance-v3/auditor';
import { planV3ReadRequest } from '../src/finance-v3/agent';
import { resolveV3TimeScope } from '../src/finance-v3/time';
import { executeV3ReadTool } from '../src/finance-v3/tools';
import type { V3ReadToolCall } from '../src/finance-v3/protocol';

class SqliteStatement implements D1StatementLike {
  constructor(private readonly db: DatabaseSync, readonly sql: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]): D1StatementLike { return new SqliteStatement(this.db, this.sql, values); }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values as never[]) as T | undefined;
    return row ?? null;
  }
  async run(): Promise<unknown> { return this.db.prepare(this.sql).run(...this.values as never[]); }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] };
  }
}

class SqliteD1 implements D1Like {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(query: string): D1StatementLike { return new SqliteStatement(this.sqlite, query); }
  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, currency TEXT, is_active INTEGER, created_at TEXT);
CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, parent_id TEXT, is_active INTEGER, created_at TEXT);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, amount_fen INTEGER NOT NULL, currency TEXT NOT NULL,
  account_id TEXT, category_id TEXT, merchant TEXT, description TEXT, occurred_at TEXT NOT NULL,
  source TEXT, source_id TEXT, raw_text TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE transaction_items (
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, name TEXT NOT NULL, quantity REAL,
  unit_price_fen INTEGER, line_total_fen INTEGER, category TEXT, created_at TEXT
);
CREATE TABLE finance_sessions (
  ledger_scope_id TEXT NOT NULL, session_key TEXT NOT NULL, active_result_set_id TEXT,
  PRIMARY KEY (ledger_scope_id, session_key)
);
CREATE TABLE finance_result_sets (
  result_set_id TEXT PRIMARY KEY, ledger_scope_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL, session_key TEXT NOT NULL, result_set_version INTEGER NOT NULL,
  row_count INTEGER NOT NULL, page_size INTEGER NOT NULL, sort_filter_fingerprint TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE finance_result_set_items (
  result_set_id TEXT NOT NULL, ordinal INTEGER NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, entity_fingerprint TEXT NOT NULL, row_snapshot_json TEXT NOT NULL,
  row_snapshot_bytes INTEGER NOT NULL, PRIMARY KEY (result_set_id, ordinal)
);
CREATE TABLE finance_session_references (
  reference_id TEXT PRIMARY KEY, ledger_scope_id TEXT NOT NULL, session_key TEXT NOT NULL,
  reference_kind TEXT NOT NULL, entity_id TEXT NOT NULL, source_turn_id TEXT NOT NULL,
  source_result_id TEXT, created_at TEXT NOT NULL, expires_at TEXT
);
`);

sqlite.prepare(`INSERT INTO accounts VALUES ('account-wallet', '支付宝', 'wallet', 'CNY', 1, CURRENT_TIMESTAMP)`).run();
sqlite.prepare(`INSERT INTO categories VALUES ('cat-food', '外食', 'expense', NULL, 1, CURRENT_TIMESTAMP)`).run();
sqlite.prepare(`INSERT INTO categories VALUES ('cat-daily', '日用', 'expense', NULL, 1, CURRENT_TIMESTAMP)`).run();
sqlite.prepare(`INSERT INTO categories VALUES ('cat-salary', '工资', 'income', NULL, 1, CURRENT_TIMESTAMP)`).run();

const insert = sqlite.prepare(`
  INSERT INTO transactions (
    id, type, amount_fen, currency, account_id, category_id, merchant, description,
    occurred_at, source, source_id, raw_text, created_at, updated_at
  ) VALUES (?, ?, ?, 'CNY', 'account-wallet', ?, ?, ?, ?, 'fixture', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`);

// More than 200 ledger rows: aggregation must use the complete set, not presentation limits.
for (let i = 0; i < 230; i += 1) {
  const day = String((i % 28) + 1).padStart(2, '0');
  const category = i < 150 ? 'cat-food' : 'cat-daily';
  insert.run(`aug-exp-${i}`, 'expense', 100, category, i < 150 ? '外食商户' : '日用商户', `八月支出 ${i}`, `2026-08-${day}T12:00:00`, `aug-exp-${i}`);
}
insert.run('aug-income', 'income', 5000, 'cat-salary', '工资', '八月工资', '2026-08-10T09:00:00', 'aug-income');

// September data used for active-result-set follow-up tests.
const septemberRows = [
  ['sep-1', 1500, '2026-09-03T08:00:00'],
  ['sep-2', 1200, '2026-09-05T12:00:00'],
  ['sep-3', 4700, '2026-09-14T11:00:00'],
  ['sep-4', 2290, '2026-09-14T13:00:00'],
  ['sep-5', 11390, '2026-09-14T18:00:00']
] as const;
for (const [id, amount, occurredAt] of septemberRows) {
  insert.run(id, 'expense', amount, 'cat-food', '外食商户', id, occurredAt, id);
}

const resultSetId = 'rs-september-active';
sqlite.prepare(`INSERT INTO finance_result_sets VALUES (?, 'personal:primary', 'plan-test', 1, 'telegram:1:topic:0', 1, 5, 20, 'fp', 1000, CURRENT_TIMESTAMP, '2099-01-01T00:00:00Z')`).run(resultSetId);
for (let index = 0; index < septemberRows.length; index += 1) {
  const [id, amount, occurredAt] = septemberRows[index];
  const snapshot = JSON.stringify({
    id,
    type: 'expense',
    amount_fen: amount,
    currency: 'CNY',
    occurred_at: occurredAt,
    account_id: 'account-wallet',
    category_id: 'cat-food',
    merchant: '外食商户',
    description: id,
    items: []
  });
  sqlite.prepare(`INSERT INTO finance_result_set_items VALUES (?, ?, 'transaction', ?, ?, ?, ?)`)
    .run(resultSetId, index + 1, id, `fp-${id}`, snapshot, Buffer.byteLength(snapshot));
}
sqlite.prepare(`INSERT INTO finance_sessions VALUES ('personal:primary', 'telegram:1:topic:0', ?)`).run(resultSetId);

const db = new SqliteD1(sqlite);
const eventTime = '2026-09-15T08:20:00+08:00';

const lastMonth = resolveV3TimeScope({ kind: 'preset', preset: 'last_month' }, eventTime);
assert.deepEqual(lastMonth, { from_date: '2026-08-01', to_date: '2026-09-01', timezone: 'Asia/Shanghai', source: 'last_month' });
const crossYear = resolveV3TimeScope({ kind: 'preset', preset: 'last_month' }, '2026-01-15T12:00:00+08:00');
assert.deepEqual(crossYear, { from_date: '2025-12-01', to_date: '2026-01-01', timezone: 'Asia/Shanghai', source: 'last_month' });

const augustSummary = await executeV3ReadTool(db, {
  tool: 'summarize_transactions',
  source: { kind: 'ledger' },
  scope: { kind: 'preset', preset: 'last_month' },
  filters: { types: ['expense'] }
}, eventTime);
assert.equal(augustSummary.tool, 'summarize_transactions');
if (augustSummary.tool === 'summarize_transactions') {
  assert.deepEqual(augustSummary.summary, {
    transaction_count: 230,
    expense_fen: 23000,
    income_fen: 0,
    transfer_fen: 0,
    net_fen: -23000
  });
}

const augustDetails = await executeV3ReadTool(db, {
  tool: 'find_transactions',
  source: { kind: 'ledger' },
  scope: { kind: 'preset', preset: 'last_month' },
  filters: { types: ['expense'] },
  limit: 20
}, eventTime);
assert.equal(augustDetails.tool, 'find_transactions');
if (augustDetails.tool === 'find_transactions') {
  assert.equal(augustDetails.rows.length, 20);
  assert.equal(augustDetails.total_matching, 230, 'detail limit must not change matching truth');
}

const grouped = await executeV3ReadTool(db, {
  tool: 'group_transactions',
  source: { kind: 'ledger' },
  scope: { kind: 'preset', preset: 'last_month' },
  filters: { types: ['expense'] },
  dimension: 'category',
  metric: 'amount',
  limit: 10
}, eventTime);
assert.equal(grouped.tool, 'group_transactions');
if (grouped.tool === 'group_transactions') {
  assert.deepEqual(grouped.groups[0], { key: '外食', value: 15000, transaction_count: 150 });
  assert.equal(grouped.summary.expense_fen, 23000);
}

const described = await executeV3ReadTool(db, {
  tool: 'describe_result_set',
  source: { kind: 'active_result_set', session_key: 'telegram:1:topic:0' }
}, eventTime);
assert.equal(described.tool, 'describe_result_set');
if (described.tool === 'describe_result_set') {
  assert.equal(described.description.transaction_count, 5);
  assert.equal(described.description.earliest_date, '2026-09-03');
  assert.equal(described.description.latest_date, '2026-09-14');
  assert.equal(described.description.min_amount_fen, 1200);
  assert.equal(described.description.max_amount_fen, 11390);
}

const earliest = await executeV3ReadTool(db, {
  tool: 'get_extrema',
  source: { kind: 'active_result_set', session_key: 'telegram:1:topic:0' },
  field: 'occurred_at',
  direction: 'min'
}, eventTime);
assert.equal(earliest.tool, 'get_extrema');
if (earliest.tool === 'get_extrema') assert.equal(earliest.row?.occurred_at.slice(0, 10), '2026-09-03');

const explicitSearch = await executeV3ReadTool(db, {
  tool: 'search_transactions',
  source: { kind: 'ledger' },
  scope: { kind: 'preset', preset: 'this_month_to_date' },
  explicit_search: true,
  query: '外食',
  limit: 20
}, eventTime);
assert.equal(explicitSearch.tool, 'search_transactions');
if (explicitSearch.tool === 'search_transactions') assert.equal(explicitSearch.total_matching, 5);

assert.throws(
  () => auditV3ReadToolCall({
    tool: 'search_transactions',
    source: { kind: 'ledger' },
    explicit_search: false,
    query: '消费支出'
  } as unknown as V3ReadToolCall),
  (error: unknown) => error instanceof V3ReadAuditError && error.code === 'EXPLICIT_SEARCH_REQUIRED'
);

const mockEnv = {
  AI_MODEL: 'test-model',
  AI: {
    run: async () => ({
      response: {
        kind: 'tool_calls',
        calls: [{ tool: 'describe_result_set', source: { kind: 'active_result_set' } }],
        message: null
      }
    })
  }
} as unknown as Env;
const decision = await planV3ReadRequest(mockEnv, '这些记录开始日期是几号', {
  event_time: eventTime,
  session_key: 'telegram:1:topic:0',
  active_result_set_id: resultSetId
});
assert.equal(decision.kind, 'tool_calls');
if (decision.kind === 'tool_calls') {
  assert.deepEqual(decision.calls[0], {
    tool: 'describe_result_set',
    source: { kind: 'active_result_set', session_key: 'telegram:1:topic:0' }
  });
}

console.log('finance-v3-read-agent.test.ts: PASS');
