import assert from 'node:assert/strict';
import { interpretFinanceTurn } from '../src/finance-v2/orchestrator';
import { buildApiFinanceTurn } from '../src/finance-v2/turn';
import type { Env } from '../src/types';

const referenceCatalog = {
  categories: [{ id: 'cat-food', name: '餐饮', type: 'expense' as const, parent_name: null }],
  accounts: [{ id: 'account-unspecified', name: '未指定', type: 'other' as const }]
};

const scope = {
  from: '2026-09-01T00:00:00+08:00',
  to: '2026-10-01T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
  end_exclusive: true,
  source_phrase: '本月'
} as const;

function plan(turn: Awaited<ReturnType<typeof buildApiFinanceTurn>>, operation: 'create' | 'query'): Record<string, unknown> {
  return {
    schema_version: 2,
    plan_id: `plan_${operation}`,
    plan_version: 1,
    base_session_version: 0,
    source_turn_id: turn.turn_id,
    ledger_scope_id: 'personal:primary',
    confidence: 1,
    presentation: { mode: operation === 'create' ? 'details' : 'summary' },
    operation,
    ...(operation === 'create'
      ? { entries: [{ client_entry_key: 'entry_1', type: 'expense', money: { amount_fen: 100, currency: 'CNY' }, occurred_at: '2026-09-08T12:00:00+08:00', account: null, category: { kind: 'category', value: '餐饮' }, merchant: null, description: '测试', items: [] }] }
      : { filters: {}, temporal_scope: scope, reference: null })
  };
}

async function run(operation: 'create' | 'query', text: string) {
  const calls: unknown[] = [];
  const turn = await buildApiFinanceTurn({ requestId: `semantic-${operation}`, sessionKey: 'api:test', baseSessionVersion: 0, eventTime: '2026-09-08T12:00:00+08:00', receivedTime: '2026-09-08T12:00:01+08:00', text });
  const response = { kind: 'new_plan', plan: plan(turn, operation), field_confidence: {} };
  const env = {
    AI_MODEL: 'test-model',
    AI: { run: async (...args: unknown[]) => { calls.push(args); return { response }; } }
  } as unknown as Env;
  const interpreted = await interpretFinanceTurn(env, turn, { sessionVersion: 0, referenceCatalog });
  assert.equal(interpreted.operation, operation);
  assert.equal(calls.length, 1);
  return calls[0] as [{ messages: unknown[]; response_format: { type: string; json_schema: unknown } }];
}

const createCall = await run('create', '记一笔 1 元');
const queryCall = await run('query', '随便一句不含金额的查询表达');
assert.deepEqual(createCall[0].response_format, queryCall[0].response_format);

const queryTurn = await buildApiFinanceTurn({ requestId: 'semantic-invalid-query', sessionKey: 'api:test', baseSessionVersion: 0, eventTime: '2026-09-08T12:00:00+08:00', receivedTime: '2026-09-08T12:00:01+08:00', text: '无效模型输出测试' });
const invalidCalls: unknown[] = [];
const invalidEnv = {
  AI_MODEL: 'test-model',
  AI: { run: async (...args: unknown[]) => { invalidCalls.push(args); return { response: '{invalid-json' }; } }
} as unknown as Env;
await assert.rejects(
  interpretFinanceTurn(invalidEnv, queryTurn, { sessionVersion: 0, referenceCatalog }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'interpretation_failed'
);
assert.equal(invalidCalls.length, 1);
console.log('finance-v2-semantic-authority.test.ts: PASS');
