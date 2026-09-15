import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { D1Like, D1StatementLike, Env } from '../src/types';
import type { FinancePlan, FinanceTurn } from '../src/finance-v2/protocol';
import { interpretFinanceTurn } from '../src/finance-v2/orchestrator';
import { planV3ReadRequest } from '../src/finance-v3/agent';
import { resolveV3TimeScope } from '../src/finance-v3/time';
import { executeV3ReadTool } from '../src/finance-v3/tools';
import type { V3ReadToolCall, V3ReadToolResult } from '../src/finance-v3/protocol';
import {
  FINANCE_V3_ACTIVE_RESULT_SET_ID,
  FINANCE_V3_BENCHMARK_EVENT_TIME,
  FINANCE_V3_BENCHMARK_SESSION_KEY,
  financeV3BenchmarkCases,
  type ExpectedToolShape,
  type FinanceV3BenchmarkCase,
  type TruthExpectation
} from '../benchmarks/finance-v3-cases';

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

interface BenchmarkRecord {
  id: string;
  family: string;
  text: string;
  critical: boolean;
  v3_plan_pass: boolean;
  v3_truth_pass: boolean | null;
  v2_plan_pass: boolean | null;
  v3_decision?: unknown;
  v2_plan?: unknown;
  error?: string;
}

function getWranglerAuthToken(): string {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const output = execFileSync(npx, ['wrangler', 'auth', 'token', '--json'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  const parsed = JSON.parse(output) as { token?: string; type?: string };
  if (!parsed.token) throw new Error(`WRANGLER_AUTH_TOKEN_UNAVAILABLE:${parsed.type || 'unknown'}`);
  return parsed.token;
}

function realWorkersAiBinding(): Env['AI'] {
  const authToken = getWranglerAuthToken();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || 'ffda4d04feec5de2ef3fb4fbbe35b496';
  const proxy = process.env.YUNSHU_BENCHMARK_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  return {
    run: async (model: string, input: Record<string, unknown>) => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
      const tmp = path.join(os.tmpdir(), `yunshu-v3-bench-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
      fs.writeFileSync(tmp, JSON.stringify(input), 'utf8');
      const args = ['-sS', '-X', 'POST', url, '-H', `Authorization: Bearer ${authToken}`, '-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', `@${tmp}`];
      if (proxy) args.splice(1, 0, '-x', proxy);
      try {
        const text = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        const body = JSON.parse(text) as { success?: boolean; errors?: unknown; result?: unknown };
        if (!body.success) throw new Error(`WORKERS_AI_FAILED:${JSON.stringify(body.errors)}`);
        return body.result;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    }
  };
}

function seedFixture(): { sqlite: DatabaseSync; db: SqliteD1 } {
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
  sqlite.prepare(`INSERT INTO categories VALUES ('cat-transfer', '转账', 'transfer', NULL, 1, CURRENT_TIMESTAMP)`).run();

  const insert = sqlite.prepare(`
    INSERT INTO transactions (
      id, type, amount_fen, currency, account_id, category_id, merchant, description,
      occurred_at, source, source_id, raw_text, created_at, updated_at
    ) VALUES (?, ?, ?, 'CNY', 'account-wallet', ?, ?, ?, ?, 'fixture', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  for (let i = 0; i < 230; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const category = i < 150 ? 'cat-food' : 'cat-daily';
    insert.run(`aug-exp-${i}`, 'expense', 100, category, i < 150 ? '外食商户' : '日用商户', `八月支出 ${i}`, `2026-08-${day}T12:00:00`, `aug-exp-${i}`);
  }
  insert.run('aug-income', 'income', 5000, 'cat-salary', '工资', '八月工资', '2026-08-10T09:00:00', 'aug-income');

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

  sqlite.prepare(`INSERT INTO finance_result_sets VALUES (?, 'personal:primary', 'plan-test', 1, ?, 1, 5, 20, 'fp', 1000, CURRENT_TIMESTAMP, '2099-01-01T00:00:00Z')`)
    .run(FINANCE_V3_ACTIVE_RESULT_SET_ID, FINANCE_V3_BENCHMARK_SESSION_KEY);
  for (let index = 0; index < septemberRows.length; index += 1) {
    const [id, amount, occurredAt] = septemberRows[index];
    const snapshot = JSON.stringify({
      id, type: 'expense', amount_fen: amount, currency: 'CNY', occurred_at: occurredAt,
      account_id: 'account-wallet', category_id: 'cat-food', merchant: '外食商户', description: id, items: []
    });
    sqlite.prepare(`INSERT INTO finance_result_set_items VALUES (?, ?, 'transaction', ?, ?, ?, ?)`)
      .run(FINANCE_V3_ACTIVE_RESULT_SET_ID, index + 1, id, `fp-${id}`, snapshot, Buffer.byteLength(snapshot));
  }
  sqlite.prepare(`INSERT INTO finance_sessions VALUES ('personal:primary', ?, ?)`).run(FINANCE_V3_BENCHMARK_SESSION_KEY, FINANCE_V3_ACTIVE_RESULT_SET_ID);
  return { sqlite, db: new SqliteD1(sqlite) };
}

function v3ContextFor(testCase: FinanceV3BenchmarkCase) {
  const hasActive = testCase.context === 'active_result_set';
  return {
    event_time: FINANCE_V3_BENCHMARK_EVENT_TIME,
    session_key: FINANCE_V3_BENCHMARK_SESSION_KEY,
    active_result_set_id: hasActive ? FINANCE_V3_ACTIVE_RESULT_SET_ID : null,
    previous_result_set_id: null
  };
}

function sourceKind(call: V3ReadToolCall): string | undefined {
  return 'source' in call ? call.source.kind : undefined;
}

function checkToolShape(call: V3ReadToolCall, expected: ExpectedToolShape): boolean {
  if (call.tool !== expected.tool) return false;
  if (expected.source_kind && sourceKind(call) !== expected.source_kind) return false;
  if ('scope' in call) {
    const scope = call.scope;
    if (expected.preset) {
      if (!scope || scope.kind !== 'preset' || scope.preset !== expected.preset) return false;
    }
    if (expected.explicit_from_prefix || expected.explicit_to_prefix) {
      if (!scope || scope.kind !== 'explicit') return false;
      if (expected.explicit_from_prefix && !scope.from.startsWith(expected.explicit_from_prefix)) return false;
      if (expected.explicit_to_prefix && !scope.to.startsWith(expected.explicit_to_prefix)) return false;
    }
  }
  if (expected.types) {
    if (!('filters' in call) || !call.filters?.types || expected.types.some((type) => !call.filters?.types?.includes(type))) return false;
  }
  if (expected.dimension && (!('dimension' in call) || call.dimension !== expected.dimension)) return false;
  if (expected.metric && (!('metric' in call) || call.metric !== expected.metric)) return false;
  if (expected.field && (!('field' in call) || call.field !== expected.field)) return false;
  if (expected.direction && (!('direction' in call) || call.direction !== expected.direction)) return false;
  if (expected.order_field) {
    if (call.tool !== 'find_transactions' || call.order_by?.field !== expected.order_field) return false;
  }
  if (expected.order_direction) {
    if (call.tool !== 'find_transactions' || call.order_by?.direction !== expected.order_direction) return false;
  }
  if (expected.explicit_search !== undefined) {
    if (call.tool !== 'search_transactions' || call.explicit_search !== expected.explicit_search) return false;
  }
  if (expected.query) {
    if (call.tool !== 'search_transactions' || call.query !== expected.query) return false;
  }
  return true;
}

function v3DecisionPass(decision: Awaited<ReturnType<typeof planV3ReadRequest>>, testCase: FinanceV3BenchmarkCase): boolean {
  if (decision.kind !== testCase.expected_kind) return false;
  if (decision.kind !== 'tool_calls') return true;
  if (!testCase.expected_tool) return true;
  if (!decision.calls.length) return false;
  if (decision.calls.some((call) => call.tool === 'search_transactions') && testCase.family !== 'search') return false;
  return checkToolShape(decision.calls[0], testCase.expected_tool);
}

function expectedRange(expected: ExpectedToolShape): { from: string; to: string } | null {
  if (expected.preset) {
    const range = resolveV3TimeScope({ kind: 'preset', preset: expected.preset as never }, FINANCE_V3_BENCHMARK_EVENT_TIME);
    return range ? { from: range.from_date, to: range.to_date } : null;
  }
  if (expected.explicit_from_prefix && expected.explicit_to_prefix) {
    return { from: expected.explicit_from_prefix.slice(0, 10), to: expected.explicit_to_prefix.slice(0, 10) };
  }
  return null;
}

function directSqlTruth(sqlite: DatabaseSync, testCase: FinanceV3BenchmarkCase): TruthExpectation | null {
  if (!testCase.truth || !testCase.expected_tool) return null;
  const truth = testCase.truth;
  const expected = testCase.expected_tool;
  if (expected.source_kind === 'active_result_set') return truth;
  const range = expectedRange(expected);
  const dateClause = range ? ` AND substr(t.occurred_at, 1, 10) >= ? AND substr(t.occurred_at, 1, 10) < ?` : '';
  const params: unknown[] = [];
  if (range) params.push(range.from, range.to);
  const typeClause = expected.types?.length ? ` AND t.type IN (${expected.types.map(() => '?').join(',')})` : '';
  if (expected.types?.length) params.push(...expected.types);

  if (truth.kind === 'summary') {
    const row = sqlite.prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount_fen ELSE 0 END),0) AS expense,
      COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount_fen ELSE 0 END),0) AS income
      FROM transactions t WHERE 1=1${dateClause}${typeClause}`).get(...params as never[]) as Record<string, number>;
    return { kind: 'summary', transaction_count: Number(row.n), expense_fen: Number(row.expense), income_fen: Number(row.income) };
  }
  if (truth.kind === 'group_top') {
    const row = sqlite.prepare(`SELECT c.name AS key, SUM(t.amount_fen) AS value, COUNT(*) AS n
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE 1=1${dateClause}${typeClause} GROUP BY c.name ORDER BY value DESC, key ASC LIMIT 1`).get(...params as never[]) as Record<string, string | number>;
    const total = sqlite.prepare(`SELECT COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount_fen ELSE 0 END),0) AS expense
      FROM transactions t WHERE 1=1${dateClause}${typeClause}`).get(...params as never[]) as Record<string, number>;
    return { kind: 'group_top', key: String(row.key), value: Number(row.value), transaction_count: Number(row.n), expense_fen: Number(total.expense) };
  }
  if (truth.kind === 'details_count') {
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE 1=1${dateClause}${typeClause}`).get(...params as never[]) as Record<string, number>;
    return { kind: 'details_count', total_matching: Number(row.n) };
  }
  if (truth.kind === 'search_count') {
    const like = `%${expected.query || ''}%`;
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM transactions t
      LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN accounts a ON a.id=t.account_id
      WHERE 1=1${dateClause}${typeClause} AND (COALESCE(t.description,'') LIKE ? OR COALESCE(t.merchant,'') LIKE ? OR COALESCE(c.name,'') LIKE ? OR COALESCE(a.name,'') LIKE ?)`)
      .get(...params as never[], like, like, like, like) as Record<string, number>;
    return { kind: 'search_count', total_matching: Number(row.n) };
  }
  if (truth.kind === 'extrema') {
    const orderField = expected.field === 'amount_fen' ? 't.amount_fen' : 't.occurred_at';
    const orderDirection = expected.direction === 'max' ? 'DESC' : 'ASC';
    const row = sqlite.prepare(`SELECT t.id, t.amount_fen, substr(t.occurred_at,1,10) AS d FROM transactions t
      WHERE 1=1${dateClause}${typeClause} ORDER BY ${orderField} ${orderDirection}, t.id ASC LIMIT 1`).get(...params as never[]) as Record<string, string | number>;
    return { kind: 'extrema', transaction_id: String(row.id), amount_fen: Number(row.amount_fen), date: String(row.d) };
  }
  return truth;
}

function compareTruth(result: V3ReadToolResult, truth: TruthExpectation): boolean {
  if (truth.kind === 'summary' && result.tool === 'summarize_transactions') {
    return result.summary.transaction_count === truth.transaction_count && result.summary.expense_fen === truth.expense_fen && result.summary.income_fen === truth.income_fen;
  }
  if (truth.kind === 'group_top' && result.tool === 'group_transactions') {
    const top = result.groups[0];
    return !!top && top.key === truth.key && top.value === truth.value && top.transaction_count === truth.transaction_count && result.summary.expense_fen === truth.expense_fen;
  }
  if (truth.kind === 'result_set_description' && result.tool === 'describe_result_set') {
    const d = result.description;
    return d.transaction_count === truth.transaction_count && d.earliest_date === truth.earliest_date && d.latest_date === truth.latest_date && d.min_amount_fen === truth.min_amount_fen && d.max_amount_fen === truth.max_amount_fen;
  }
  if (truth.kind === 'extrema' && result.tool === 'get_extrema') {
    return result.row?.id === truth.transaction_id && result.row.amount_fen === truth.amount_fen && result.row.occurred_at.slice(0, 10) === truth.date;
  }
  if (truth.kind === 'search_count' && result.tool === 'search_transactions') return result.total_matching === truth.total_matching;
  if (truth.kind === 'details_count' && result.tool === 'find_transactions') return result.total_matching === truth.total_matching;
  if (truth.kind === 'summary' && result.tool === 'group_transactions') {
    return result.summary.transaction_count === truth.transaction_count && result.summary.expense_fen === truth.expense_fen && result.summary.income_fen === truth.income_fen;
  }
  return false;
}

function financeTurn(text: string, index: number): FinanceTurn {
  return {
    schema_version: 2,
    turn_id: `bench-turn-${index}`,
    channel: 'telegram',
    channel_event_id: `bench-event-${index}`,
    idempotency_key: `bench-idem-${index}`,
    payload_hash: `bench-hash-${index}`,
    actor: {
      schema_version: 2,
      ledger_scope_id: 'personal:primary',
      subject_id: 'benchmark-owner',
      auth_source: 'telegram_owner',
      permissions: ['finance:read']
    },
    session_key: FINANCE_V3_BENCHMARK_SESSION_KEY,
    ordering: { kind: 'telegram', epoch: 0, update_id: index + 1 },
    event_time: FINANCE_V3_BENCHMARK_EVENT_TIME,
    received_time: FINANCE_V3_BENCHMARK_EVENT_TIME,
    timezone: 'Asia/Shanghai',
    text,
    attachments: [],
    correlation_id: `bench-correlation-${index}`,
    base_session_version: 0
  };
}

function v2ComparablePass(plan: FinancePlan, testCase: FinanceV3BenchmarkCase): boolean {
  if (!testCase.expected_tool) return false;
  const expected = testCase.expected_tool;
  const expectedOperation = expected.tool === 'summarize_transactions' ? 'summarize'
    : expected.tool === 'group_transactions' ? 'analyze'
      : expected.tool === 'find_transactions' || expected.tool === 'search_transactions' ? 'query'
        : expected.tool === 'compare_periods' ? 'compare'
          : null;
  if (!expectedOperation || plan.operation !== expectedOperation) return false;
  if ('filters' in plan && expected.types?.some((type) => !plan.filters.types?.includes(type))) return false;
  if (expected.tool !== 'search_transactions' && 'filters' in plan && plan.filters.semantic_search === true) return false;
  if (expected.tool === 'search_transactions') {
    if (!('filters' in plan) || plan.filters.semantic_search !== true || plan.filters.semantic_text !== expected.query) return false;
  }
  if (plan.operation === 'analyze') {
    if (expected.dimension && plan.dimension !== expected.dimension) return false;
  }
  if (expected.preset && plan.operation !== 'compare') {
    const range = resolveV3TimeScope({ kind: 'preset', preset: expected.preset as never }, FINANCE_V3_BENCHMARK_EVENT_TIME);
    const scope = 'temporal_scope' in plan ? plan.temporal_scope : null;
    if (!range || !scope || !scope.from.startsWith(range.from_date) || !scope.to.startsWith(range.to_date)) return false;
  }
  if (expected.explicit_from_prefix && plan.operation !== 'compare') {
    const scope = 'temporal_scope' in plan ? plan.temporal_scope : null;
    if (!scope || !scope.from.startsWith(expected.explicit_from_prefix) || !scope.to.startsWith(expected.explicit_to_prefix || '')) return false;
  }
  return true;
}

async function main() {
  const { sqlite, db } = seedFixture();
  const ai = realWorkersAiBinding();
  const model = process.env.YUNSHU_BENCHMARK_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const env = {
    DB: db,
    AI: ai,
    AI_MODEL: model,
    APP_TIMEZONE: 'Asia/Shanghai'
  } as unknown as Env;
  const referenceCatalog = {
    categories: [
      { id: 'cat-food', name: '外食', type: 'expense' as const, parent_name: null },
      { id: 'cat-daily', name: '日用', type: 'expense' as const, parent_name: null },
      { id: 'cat-salary', name: '工资', type: 'income' as const, parent_name: null },
      { id: 'cat-transfer', name: '转账', type: 'transfer' as const, parent_name: null }
    ],
    accounts: [{ id: 'account-wallet', name: '支付宝', type: 'wallet' as const }]
  };

  const records: BenchmarkRecord[] = [];
  for (let i = 0; i < financeV3BenchmarkCases.length; i += 1) {
    const testCase = financeV3BenchmarkCases[i];
    const record: BenchmarkRecord = {
      id: testCase.id,
      family: testCase.family,
      text: testCase.text,
      critical: !!testCase.critical,
      v3_plan_pass: false,
      v3_truth_pass: null,
      v2_plan_pass: null
    };
    try {
      const decision = await planV3ReadRequest(env, testCase.text, v3ContextFor(testCase));
      record.v3_decision = decision;
      record.v3_plan_pass = v3DecisionPass(decision, testCase);
      if (record.v3_plan_pass && decision.kind === 'tool_calls' && testCase.truth) {
        const directTruth = directSqlTruth(sqlite, testCase) || testCase.truth;
        const result = await executeV3ReadTool(db, decision.calls[0], FINANCE_V3_BENCHMARK_EVENT_TIME);
        record.v3_truth_pass = compareTruth(result, directTruth);
      }
      if (testCase.v2_comparable) {
        try {
          const plan = await interpretFinanceTurn(env, financeTurn(testCase.text, i), {
            sessionVersion: 0,
            activePlan: null,
            recentTurnSummaries: [],
            referenceCatalog
          });
          record.v2_plan = plan;
          record.v2_plan_pass = v2ComparablePass(plan, testCase);
        } catch (error) {
          record.v2_plan_pass = false;
          record.v2_plan = { error: error instanceof Error ? error.message : String(error) };
        }
      }
    } catch (error) {
      record.error = error instanceof Error ? error.stack || error.message : String(error);
    }
    records.push(record);
    console.log(`${record.v3_plan_pass ? 'PASS' : 'FAIL'} ${record.id} | V3-plan=${record.v3_plan_pass} V3-truth=${record.v3_truth_pass ?? 'n/a'} V2=${record.v2_plan_pass ?? 'n/a'}`);
  }

  const count = records.length;
  const v3PlanPassed = records.filter((r) => r.v3_plan_pass).length;
  const truthRecords = records.filter((r) => r.v3_truth_pass !== null);
  const v3TruthPassed = truthRecords.filter((r) => r.v3_truth_pass).length;
  const critical = records.filter((r) => r.critical);
  const criticalPassed = critical.filter((r) => r.v3_plan_pass && (r.v3_truth_pass !== false)).length;
  const v2Records = records.filter((r) => r.v2_plan_pass !== null);
  const v2Passed = v2Records.filter((r) => r.v2_plan_pass).length;
  const falseSearches = records.filter((r) => r.family !== 'search' && r.v3_decision && JSON.stringify(r.v3_decision).includes('search_transactions')).length;
  const resultSetRecords = records.filter((r) => r.family === 'result_set');
  const resultSetPassed = resultSetRecords.filter((r) => r.v3_plan_pass && r.v3_truth_pass !== false).length;

  const summary = {
    model,
    cases: count,
    v3_plan_passed: v3PlanPassed,
    v3_plan_rate: v3PlanPassed / count,
    v3_truth_passed: v3TruthPassed,
    v3_truth_cases: truthRecords.length,
    v3_truth_rate: truthRecords.length ? v3TruthPassed / truthRecords.length : 1,
    critical_passed: criticalPassed,
    critical_cases: critical.length,
    result_set_passed: resultSetPassed,
    result_set_cases: resultSetRecords.length,
    false_searches: falseSearches,
    v2_plan_passed: v2Passed,
    v2_plan_cases: v2Records.length,
    v2_plan_rate: v2Records.length ? v2Passed / v2Records.length : null
  };

  console.log('\nBENCHMARK_SUMMARY');
  console.log(JSON.stringify(summary, null, 2));

  const outputPath = process.env.YUNSHU_BENCHMARK_OUTPUT;
  if (outputPath) fs.writeFileSync(outputPath, JSON.stringify({ summary, records }, null, 2), 'utf8');

  const gatePass = summary.v3_plan_rate >= 0.95
    && summary.v3_truth_rate === 1
    && summary.critical_passed === summary.critical_cases
    && summary.result_set_passed === summary.result_set_cases
    && summary.false_searches === 0;
  if (!gatePass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
