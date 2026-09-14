import assert from 'node:assert/strict';
import { buildApiFinanceTurn, buildReceiptFinanceTurn } from '../src/finance-v2/turn';
import { applyFinancePlanPatch, interpretFinanceTurn, validateFinancePlan } from '../src/finance-v2/orchestrator';
import type { Env } from '../src/types';
import type { FinancePlan, FinanceTurn, TemporalScope } from '../src/finance-v2/protocol';

const scope: TemporalScope = {
  from: '2026-09-01T00:00:00+08:00',
  to: '2026-10-01T00:00:00+08:00',
  timezone: 'Asia/Shanghai',
  end_exclusive: true,
  source_phrase: '本月'
};

const reference = { kind: 'transaction', transaction_id: 'tx_dialogue_1' } as const;

async function turnFor(operation: string, baseSessionVersion = 7): Promise<FinanceTurn> {
  if (operation === 'receipt_create') {
    return buildReceiptFinanceTurn({
      jobId: 'receipt_job_matrix',
      sourceEventId: 'receipt_source_matrix',
      attachmentRef: 'receipt_artifact_matrix',
      sessionKey: 'api:dialogue-matrix',
      eventTime: '2026-09-08T12:00:00+08:00',
      receivedTime: '2026-09-08T12:00:01+08:00',
      caption: '测试商户'
    });
  }
  return buildApiFinanceTurn({
    requestId: `dialogue-${operation}`,
    sessionKey: 'api:dialogue-matrix',
    baseSessionVersion,
    eventTime: '2026-09-08T12:00:00+08:00',
    receivedTime: '2026-09-08T12:00:01+08:00',
    text: operation
  });
}

function base(turn: FinanceTurn, operation: string): Record<string, unknown> {
  return {
    schema_version: 2,
    plan_id: `plan_${operation}`,
    plan_version: 1,
    base_session_version: turn.base_session_version,
    source_turn_id: turn.turn_id,
    ledger_scope_id: 'personal:primary',
    confidence: 0.95,
    presentation: { mode: operation === 'compare' ? 'comparison' : operation === 'analyze' ? 'analysis' : 'details' },
    operation
  };
}

const entry = {
  client_entry_key: 'entry_1',
  type: 'expense',
  money: { amount_fen: 1250, currency: 'CNY' },
  occurred_at: '2026-09-08T11:30:00+08:00',
  account: { kind: 'account', value: '微信' },
  category: { kind: 'category', value: '餐饮' },
  merchant: '测试商户',
  description: '对话矩阵',
  items: []
};

const cases: Array<{ operation: string; extra: Record<string, unknown> }> = [
  { operation: 'create', extra: { entries: [entry] } },
  { operation: 'query', extra: { filters: { types: ['expense'] }, temporal_scope: scope, reference: null } },
  { operation: 'summarize', extra: { filters: {}, temporal_scope: scope, reference: null } },
  { operation: 'analyze', extra: { filters: {}, temporal_scope: scope, metric: 'expense', dimension: 'category', reference: null } },
  { operation: 'compare', extra: { left_scope: scope, right_scope: { ...scope, from: '2026-08-01T00:00:00+08:00', to: '2026-09-01T00:00:00+08:00', source_phrase: '上月' }, filters: {}, metric: 'expense', dimension: 'none', reference: null } },
  { operation: 'update', extra: { filters: {}, selection: { mode: 'exactly_one' }, changes: { category: { kind: 'category', value: '餐饮' } } } },
  { operation: 'delete', extra: { filters: {}, selection: { mode: 'exact_count', count: 1 } } },
  { operation: 'restore', extra: { reference } },
  {
    operation: 'receipt_create',
    extra: {
      receipt_job_id: 'receipt_job_matrix',
      receipt_artifact_id: 'receipt_artifact_matrix',
      receipt_merchant: '测试商户',
      receipt_total_fen: 1250,
      receipt_item_count: 1,
      entries: [entry]
    }
  }
];

const plans: FinancePlan[] = [];
for (const testCase of cases) {
  const turn = await turnFor(testCase.operation);
  const plan = validateFinancePlan({ ...base(turn, testCase.operation), ...testCase.extra }, turn);
  assert.equal(plan.operation, testCase.operation);
  plans.push(plan);
}
assert.deepEqual(plans.map((plan) => plan.operation), cases.map((testCase) => testCase.operation));

const queryTurn = await turnFor('query-follow-up');
const queryPlan = validateFinancePlan({
  ...base(queryTurn, 'query'),
  filters: {},
  temporal_scope: scope,
  reference: null
}, queryTurn);
const patchTurn = await turnFor('patch-follow-up');
const patch = {
  schema_version: 2,
  base_plan_id: queryPlan.plan_id,
  base_plan_version: queryPlan.plan_version,
  base_session_version: 7,
  filters: { op: 'replace', value: { categories: [{ kind: 'category', value: '餐饮' }] } },
  presentation: { op: 'replace', value: { mode: 'details', sort_field: 'amount', sort_direction: 'desc' } }
};
const patched = applyFinancePlanPatch(queryPlan, patch, patchTurn);
assert.equal(patched.operation, 'query');
assert.equal(patched.plan_version, 2);
assert.equal(patched.source_turn_id, patchTurn.turn_id);
assert.deepEqual(patched.filters?.categories, [{ kind: 'category', value: '餐饮' }]);

const mockEnv = (value: unknown) => ({ __mockFinancePlan: value }) as unknown as Env;
const interpreted = await interpretFinanceTurn(mockEnv({ kind: 'new_plan', plan: { ...base(queryTurn, 'query'), filters: {}, temporal_scope: scope, reference: null } }), queryTurn, { sessionVersion: 7 });
assert.equal(interpreted.operation, 'query');
const interpretedPatch = await interpretFinanceTurn(mockEnv({ kind: 'patch_plan', patch }), patchTurn, { sessionVersion: 7, activePlan: queryPlan });
assert.equal(interpretedPatch.plan_version, 2);
await assert.rejects(
  interpretFinanceTurn(mockEnv({ kind: 'clarification', clarification: { reason: 'missing_target', message: '请指定要修改的账目。' } }), patchTurn, { sessionVersion: 7 }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'clarification_required'
);
await assert.rejects(
  interpretFinanceTurn(mockEnv({ kind: 'non_finance', schema_version: 2 }), patchTurn, { sessionVersion: 7 }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'non_finance'
);
await assert.rejects(
  interpretFinanceTurn(mockEnv({ kind: 'new_plan', plan: { ...base(queryTurn, 'create'), entries: [entry] } }), queryTurn, { sessionVersion: 7, requiredOperation: 'receipt_create' }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'invalid_receipt_plan'
);

console.log('finance-v2-dialogue-matrix.test.ts: PASS');
