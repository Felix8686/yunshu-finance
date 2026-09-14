import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApiFinanceTurn, buildTelegramFinanceTurn } from '../src/finance-v2/turn';
import { handleFinanceV2Turn } from '../src/finance-v2/service';
import { interpretFinanceTurn, relativeTemporalScopesForTurn } from '../src/finance-v2/orchestrator';
import { renderFinanceResult } from '../src/finance-v2/renderer';
import { transitionRuntimeControl } from '../src/finance-v2/persistence';
import worker from '../src/app';
import type { D1Like, D1StatementLike, Env, TelegramUpdate } from '../src/types';

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
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1StatementLike {
    return new SqliteStatement(this.sqlite, query);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
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
const db = new DatabaseSync(':memory:');
for (const file of fs.readdirSync(path.join(root, 'migrations')).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
  db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
}
const d1 = new SqliteD1(db);
const env = {
  DB: d1,
  AI: { run: async () => { throw new Error('AI should not be called by structured aggregate tests'); } },
  FILES: {},
  APP_TIMEZONE: 'Asia/Shanghai',
  AI_MODEL: 'test-model',
  FINANCE_PAGE_TOKEN_SECRET: 'zero-query-test-secret',
  TELEGRAM_OWNER_CHAT_ID: 'owner-chat',
  TELEGRAM_OWNER_USER_ID: 'owner-user',
  API_BEARER_TOKEN: 'api-test-token',
  TELEGRAM_WEBHOOK_SECRET: 'telegram-test-secret'
} as unknown as Env;

await transitionRuntimeControl(d1, 1, { finance_route_mode: 'shadow_v2', outbox_mode: 'enabled' });
await transitionRuntimeControl(d1, 2, { finance_route_mode: 'canary_v2' });
await transitionRuntimeControl(d1, 3, { finance_route_mode: 'primary_v2' });

function scalar<T>(sql: string, ...values: unknown[]): T {
  const row = db.prepare(sql).get(...values as never[]) as Record<string, T>;
  return Object.values(row)[0];
}

function scope(from: string, to: string, sourcePhrase: string): Record<string, unknown> {
  return { from, to, timezone: 'Asia/Shanghai', end_exclusive: true, source_phrase: sourcePhrase };
}

const augustScope = scope('2026-08-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00', '2026年8月');

db.prepare(
  `INSERT INTO categories (id, name, type, parent_id, is_active, created_at) VALUES
    ('cat-clothes', '服饰美容', 'expense', NULL, 1, CURRENT_TIMESTAMP),
    ('cat-income-salary-test', '工资测试', 'income', NULL, 1, CURRENT_TIMESTAMP),
    ('cat-transport-test', '交通测试', 'expense', NULL, 1, CURRENT_TIMESTAMP)`
).run();

const insertTransaction = db.prepare(
  `INSERT INTO transactions (
     id, type, amount_fen, currency, account_id, category_id, merchant, description,
     occurred_at, source, source_id, raw_text, created_at, updated_at
   ) VALUES (?, ?, ?, 'CNY', 'account-unspecified', ?, ?, ?, ?, 'fixture', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
);
insertTransaction.run('tx-aug-top', 'expense', 249900, 'cat-clothes', '服饰美容商户', '服饰美容', '2026-08-15T12:00:00', 'tx-aug-top');
for (let index = 0; index < 228; index += 1) {
  const day = String((index % 28) + 1).padStart(2, '0');
  const time = index === 0 ? '00:00:00' : `12:${String(index % 60).padStart(2, '0')}:00`;
  const categoryId = index < 114 ? 'cat-expense-food' : 'cat-expense-daily';
  const amountFen = index < 114 ? 2000 : 1000;
  insertTransaction.run(`tx-aug-food-${index}`, 'expense', amountFen, categoryId, '餐饮商户', `餐饮 ${index}`, `2026-08-${day}T${time}`, `tx-aug-food-${index}`);
}
insertTransaction.run('tx-aug-transport', 'expense', 167858, 'cat-transport-test', '交通商户', '交通测试', '2026-08-31T23:59:59', 'tx-aug-transport');
for (let index = 0; index < 4; index += 1) {
  insertTransaction.run(`tx-aug-income-${index}`, 'income', 275000, 'cat-income-salary-test', '工资来源', `工资 ${index}`, `2026-08-${String(index + 5).padStart(2, '0')}T00:00:00`, `tx-aug-income-${index}`);
}

assert.equal(scalar<number>('SELECT COUNT(*) FROM transactions WHERE substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?', '2026-08-01', '2026-09-01'), 234);
assert.equal(scalar<number>("SELECT COALESCE(SUM(amount_fen), 0) FROM transactions WHERE type = 'expense' AND substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?", '2026-08-01', '2026-09-01'), 759758);

function planBase(turnId: string, sessionVersion: number, planId: string, operation: string, presentation: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    plan_id: planId,
    plan_version: 1,
    base_session_version: sessionVersion,
    source_turn_id: turnId,
    ledger_scope_id: 'personal:primary',
    confidence: 0.99,
    presentation: { mode: operation === 'query' ? 'details' : operation === 'analyze' ? 'analysis' : operation === 'compare' ? 'comparison' : 'summary', page_size: 10, ...presentation },
    operation
  };
}

async function structuredCall(
  requestId: string,
  sessionKey: string,
  operation: string,
  extra: Record<string, unknown>
) {
  const turn = await buildApiFinanceTurn({ requestId, sessionKey, baseSessionVersion: 0, eventTime: '2026-09-14T12:00:00+08:00', receivedTime: '2026-09-14T12:00:01+08:00', text: requestId });
  const response = await handleFinanceV2Turn(env, turn, {
    structuredPlan: { ...planBase(turn.turn_id, 0, `plan-${requestId}`, operation), ...extra }
  });
  assert.equal(response.result.kind, 'success', `${requestId} must succeed: ${JSON.stringify(response.result)}`);
  return response.result;
}

const allSummary = await structuredCall('august-all-summary', 'api:august-all-summary', 'summarize', {
  filters: {},
  temporal_scope: augustScope,
  reference: null
});
assert.equal(allSummary.kind, 'success');
assert.deepEqual(allSummary.summary, {
  transaction_count: 234,
  expense_fen: 759758,
  income_fen: 1100000,
  transfer_fen: 0,
  net_fen: 340242
});

const allDetails = await structuredCall('august-all-details', 'api:august-all-details', 'query', {
  filters: {},
  temporal_scope: augustScope,
  reference: null
});
assert.equal(allDetails.kind, 'success');
assert.equal(allDetails.rows?.length, 10, 'details return the requested page size');
assert.ok(allDetails.result_set_id);
assert.equal(scalar<number>('SELECT COUNT(*) FROM finance_result_set_items WHERE result_set_id = ?', allDetails.result_set_id), 200, 'details remain bounded to the result-set limit');
assert.equal(allDetails.page?.has_next, true);
assert.equal(allDetails.summary?.transaction_count, 234, 'query summary must not inherit the details limit');

const safeSemanticQuery = await structuredCall('august-accidental-semantic-text', 'api:august-accidental-semantic-text', 'summarize', {
  filters: { types: ['expense'], semantic_text: '消费支出' },
  temporal_scope: augustScope,
  reference: null
});
assert.equal(safeSemanticQuery.kind, 'success');
assert.deepEqual(safeSemanticQuery.summary, {
  transaction_count: 230,
  expense_fen: 759758,
  income_fen: 0,
  transfer_fen: 0,
  net_fen: -759758
});

const explicitSemanticQuery = await structuredCall('august-explicit-semantic-search', 'api:august-explicit-semantic-search', 'summarize', {
  filters: { types: ['expense'], semantic_search: true, semantic_text: '服饰美容' },
  temporal_scope: augustScope,
  reference: null
});
assert.deepEqual(explicitSemanticQuery.summary, {
  transaction_count: 1,
  expense_fen: 249900,
  income_fen: 0,
  transfer_fen: 0,
  net_fen: -249900
});

const categoryAnalysis = await structuredCall('august-category-analysis', 'api:august-category-analysis', 'analyze', {
  filters: { types: ['expense'], semantic_text: '消费支出' },
  temporal_scope: augustScope,
  metric: 'expense',
  dimension: 'category',
  reference: null
});
assert.equal(categoryAnalysis.kind, 'success');
const dimensions = (categoryAnalysis.analysis_data as { dimensions: Array<{ key: string; value_fen: number; count: number }> }).dimensions;
assert.deepEqual(dimensions[0], { key: '服饰美容', value_fen: 249900, count: 1 });
assert.equal(categoryAnalysis.summary?.transaction_count, 230);
const renderedAnalysis = await renderFinanceResult(categoryAnalysis, { mode: 'analysis' });
assert.match(renderedAnalysis.payload.telegram_parts.map((part) => part.text).join('\n'), /服饰美容/);
assert.match(renderedAnalysis.payload.telegram_parts.map((part) => part.text).join('\n'), /2499\.00/);
assert.match(renderedAnalysis.payload.telegram_parts.map((part) => part.text).join('\n'), /32\.89%/);

const currentMonth = await structuredCall('current-month-expense', 'api:current-month-expense', 'summarize', {
  filters: { types: ['expense'] },
  temporal_scope: scope('2026-09-01T00:00:00+08:00', '2026-10-01T00:00:00+08:00', '本月'),
  reference: null
});
assert.equal(currentMonth.kind, 'success');
assert.equal(currentMonth.summary?.transaction_count, 0);

async function interpretedPlan(input: {
  requestId: string;
  eventTime: string;
  text: string;
  operation: 'query' | 'summarize' | 'analyze';
  sourcePhrase: string;
  metric?: string;
  dimension?: string;
  accidentalSemanticText?: string;
}) {
  const turn = await buildApiFinanceTurn({ requestId: input.requestId, sessionKey: `api:${input.requestId}`, baseSessionVersion: 0, eventTime: input.eventTime, receivedTime: '2026-09-14T12:00:01+08:00', text: input.text });
  const wrongScope = input.sourcePhrase === '2026年8月'
    ? augustScope
    : scope('2026-09-01T00:00:00+08:00', '2026-10-01T00:00:00+08:00', input.sourcePhrase);
  const rawPlan = {
    ...planBase(turn.turn_id, 0, `plan-${input.requestId}`, input.operation),
    filters: { types: ['expense'], ...(input.accidentalSemanticText ? { semantic_text: input.accidentalSemanticText } : {}) },
    temporal_scope: wrongScope,
    reference: null,
    ...(input.operation === 'analyze' ? { metric: input.metric || 'expense', dimension: input.dimension || 'category' } : {})
  };
  const calls: unknown[] = [];
  const aiEnv = {
    AI_MODEL: 'test-model',
    AI: { run: async (...args: unknown[]) => { calls.push(args); return { response: { kind: 'new_plan', plan: rawPlan, field_confidence: {} } }; } }
  } as unknown as Env;
  const plan = await interpretFinanceTurn(aiEnv, turn, {
    sessionVersion: 0,
    referenceCatalog: {
      categories: [
        { id: 'cat-clothes', name: '服饰美容', type: 'expense', parent_name: null },
        { id: 'cat-expense-food', name: '餐饮', type: 'expense', parent_name: null },
        { id: 'cat-income-salary-test', name: '工资测试', type: 'income', parent_name: null }
      ],
      accounts: [{ id: 'account-unspecified', name: '未指定', type: 'other' }]
    }
  });
  assert.equal(calls.length, 1);
  return { plan, prompt: (calls[0] as [string, { messages: Array<{ role: string; content: string }> }])[1].messages[0].content, turn };
}

const telegramUpdate: TelegramUpdate = {
  update_id: 1,
  message: { message_id: 1, date: Math.floor(Date.parse('2026-09-14T12:00:00+08:00') / 1000), chat: { id: 1, type: 'private' }, from: { id: 2 }, text: '上个月支出多少' }
};
const telegramTurn = await buildTelegramFinanceTurn(telegramUpdate, 'Asia/Shanghai', new Date('2026-09-14T12:00:01+08:00'), '2');
assert.ok(telegramTurn);
const telegramFacts = relativeTemporalScopesForTurn(telegramTurn);
assert.deepEqual([telegramFacts.today.from, telegramFacts.today.to], ['2026-09-14T00:00:00+08:00', '2026-09-15T00:00:00+08:00']);
assert.deepEqual([telegramFacts.yesterday.from, telegramFacts.yesterday.to], ['2026-09-13T00:00:00+08:00', '2026-09-14T00:00:00+08:00']);
assert.deepEqual([telegramFacts.this_month.from, telegramFacts.this_month.to], ['2026-09-01T00:00:00+08:00', '2026-10-01T00:00:00+08:00']);
assert.deepEqual([telegramFacts.last_month.from, telegramFacts.last_month.to], ['2026-08-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00']);

const telegramAppEnv = {
  ...env,
  TELEGRAM_OWNER_CHAT_ID: '1',
  TELEGRAM_OWNER_USER_ID: '2',
  RECEIPT_QUEUE: { send: async () => undefined },
  AI: {
    run: async (...args: unknown[]) => {
      const request = args[1] as { messages?: Array<{ role: string; content: string }> };
      const systemPrompt = request.messages?.find((message) => message.role === 'system')?.content || '';
      const turnId = /当前 turn_id=([^。\n]+)/.exec(systemPrompt)?.[1]?.trim();
      return {
        response: {
          kind: 'new_plan',
          plan: {
            ...planBase(turnId || 'missing-turn-id', 0, 'telegram-fault-plan', 'analyze'),
            filters: { types: ['expense'] },
            temporal_scope: augustScope,
            metric: 'expense',
            dimension: 'category',
            reference: null
          },
          field_confidence: {}
        }
      };
    }
  }
} as unknown as Env;
const telegramWebhookResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 2,
    message: {
      message_id: 2,
      date: Math.floor(Date.parse('2026-09-14T12:00:00+08:00') / 1000),
      chat: { id: 1, type: 'private' },
      from: { id: 2 },
      text: '我上个月的消费支出一共是多少，哪一类占比较大'
    }
  })
}), telegramAppEnv);
assert.equal(telegramWebhookResponse.status, 200);
const telegramWebhookBody = await telegramWebhookResponse.json() as {
  ok?: boolean;
  finance_v2?: boolean;
  result?: { kind?: string; result_id?: string; summary?: Record<string, unknown> };
};
assert.equal(telegramWebhookBody.ok, true);
assert.equal(telegramWebhookBody.finance_v2, true);
assert.equal(telegramWebhookBody.result?.kind, 'success');
assert.deepEqual(telegramWebhookBody.result?.summary, {
  transaction_count: 230,
  expense_fen: 759758,
  income_fen: 0,
  transfer_fen: 0,
  net_fen: -759758
});
assert.ok(telegramWebhookBody.result?.result_id);
assert.equal(scalar<number>('SELECT COUNT(*) FROM finance_outbox WHERE result_id = ?', telegramWebhookBody.result?.result_id), 1);
const telegramRenderPayload = JSON.parse(scalar<string>('SELECT render_payload_json FROM finance_results WHERE result_id = ?', telegramWebhookBody.result?.result_id));
const telegramReply = (telegramRenderPayload.telegram_parts as Array<{ text: string }>).map((part) => part.text).join('\n');
assert.match(telegramReply, /服饰美容/);
assert.match(telegramReply, /32\.89%/);

const septemberLastMonth = await interpretedPlan({ requestId: 'interpret-last-month-september', eventTime: '2026-09-14T12:00:00+08:00', text: '上个月支出多少', operation: 'summarize', sourcePhrase: '上个月' });
assert.deepEqual([septemberLastMonth.plan.temporal_scope?.from, septemberLastMonth.plan.temporal_scope?.to], ['2026-08-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00']);

const januaryLastMonth = await interpretedPlan({ requestId: 'interpret-last-month-january', eventTime: '2026-01-15T12:00:00+08:00', text: '上个月支出多少', operation: 'summarize', sourcePhrase: '上个月' });
assert.deepEqual([januaryLastMonth.plan.temporal_scope?.from, januaryLastMonth.plan.temporal_scope?.to], ['2025-12-01T00:00:00+08:00', '2026-01-01T00:00:00+08:00']);

const originalFault = await interpretedPlan({
  requestId: 'interpret-original-fault',
  eventTime: '2026-09-14T12:00:00+08:00',
  text: '我上个月的消费支出一共是多少，哪一类占比较大',
  operation: 'analyze',
  sourcePhrase: '上个月',
  metric: 'expense',
  dimension: 'category',
  accidentalSemanticText: '消费支出'
});
assert.deepEqual(originalFault.plan.filters, { types: ['expense'] });
assert.equal(originalFault.plan.metric, 'expense');
assert.equal(originalFault.plan.dimension, 'category');
assert.deepEqual([originalFault.plan.temporal_scope?.from, originalFault.plan.temporal_scope?.to], ['2026-08-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00']);
assert.match(originalFault.prompt, /semantic_search=true/);
assert.match(originalFault.prompt, /代码已根据 event_time 计算相对时间事实/);

const currentMonthPlan = await interpretedPlan({ requestId: 'interpret-this-month', eventTime: '2026-09-14T12:00:00+08:00', text: '本月消费多少', operation: 'summarize', sourcePhrase: '本月' });
assert.deepEqual([currentMonthPlan.plan.temporal_scope?.from, currentMonthPlan.plan.temporal_scope?.to], ['2026-09-01T00:00:00+08:00', '2026-10-01T00:00:00+08:00']);

const yesterdayPlan = await interpretedPlan({ requestId: 'interpret-yesterday', eventTime: '2026-09-14T12:00:00+08:00', text: '昨天花了多少', operation: 'summarize', sourcePhrase: '昨天' });
assert.deepEqual([yesterdayPlan.plan.temporal_scope?.from, yesterdayPlan.plan.temporal_scope?.to], ['2026-09-13T00:00:00+08:00', '2026-09-14T00:00:00+08:00']);

const specificMonthPlan = await interpretedPlan({ requestId: 'interpret-specific-august', eventTime: '2026-09-14T12:00:00+08:00', text: '2026年8月支出多少', operation: 'summarize', sourcePhrase: '2026年8月' });
assert.deepEqual([specificMonthPlan.plan.temporal_scope?.from, specificMonthPlan.plan.temporal_scope?.to], ['2026-08-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00']);

console.log('finance-v2-zero-query.test.ts: PASS');
