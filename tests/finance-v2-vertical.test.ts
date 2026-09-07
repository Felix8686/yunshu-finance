import assert from 'node:assert/strict';
import { buildApiFinanceTurn, buildReceiptFinanceTurn } from '../src/finance-v2/turn';
import { applyFinancePlanPatch, validateFinancePlan, validateFinancePlanPatch } from '../src/finance-v2/orchestrator';
import { createPageToken, resultSetWindow, verifyPageToken } from '../src/finance-v2/result-set';

const turn = await buildReceiptFinanceTurn({
  jobId: 'receipt_job_test',
  sourceEventId: 'receipt_source_test',
  attachmentRef: 'artifact_test',
  sessionKey: 'telegram:777:topic:0',
  eventTime: '2026-09-07T12:00:00',
  caption: '超市'
});

const plan = validateFinancePlan({
  schema_version: 2,
  plan_id: 'plan_receipt_test',
  plan_version: 1,
  base_session_version: 0,
  source_turn_id: turn.turn_id,
  ledger_scope_id: 'personal:primary',
  confidence: 0.95,
  presentation: { mode: 'summary' },
  operation: 'receipt_create',
  receipt_job_id: 'receipt_job_test',
  receipt_artifact_id: 'artifact_test',
  receipt_merchant: '测试商店',
  receipt_total_fen: 1234,
  receipt_item_count: 1,
  entries: [{
    client_entry_key: 'receipt_entry',
    type: 'expense',
    money: { amount_fen: 1234, currency: 'CNY' },
    occurred_at: '2026-09-07T12:00:00',
    account: { kind: 'account', value: '未指定' },
    category: { kind: 'category', value: '餐饮' },
    merchant: '测试商店',
    description: '购物小票',
    items: [{
      client_item_key: 'item_1',
      name: '矿泉水',
      quantity: 1,
      unit_price_fen: 1234,
      line_total_fen: 1234,
      category: '饮料',
      confidence: 0.99
    }]
  }]
}, turn);
assert.equal(plan.operation, 'receipt_create');

const pageToken = await createPageToken('test-secret', {
  schema_version: 2,
  ledger_scope_id: 'personal:primary',
  session_key: 'telegram:777:topic:0',
  result_set_id: 'result_set_test',
  result_set_version: 1,
  next_start_ordinal: 3,
  page_size: 2,
  expires_at: '2026-09-08T12:00:00.000Z'
});
const decoded = await verifyPageToken('test-secret', pageToken, {
  ledger_scope_id: 'personal:primary',
  session_key: 'telegram:777:topic:0'
});
assert.equal(decoded.next_start_ordinal, 3);
await assert.rejects(
  verifyPageToken('test-secret', `${pageToken.slice(0, -1)}x`, {
    ledger_scope_id: 'personal:primary',
    session_key: 'telegram:777:topic:0'
  }),
  /EXPIRED_REFERENCE/
);

const window = resultSetWindow({
  schema_version: 2,
  result_set_id: 'result_set_test',
  ledger_scope_id: 'personal:primary',
  session_key: 'telegram:777:topic:0',
  result_set_version: 1,
  row_count: 3,
  page_size: 2,
  sort_filter_fingerprint: 'a'.repeat(64),
  snapshot_bytes: 2,
  items: [1, 2, 3].map((ordinal) => ({
    ordinal,
    entity_type: 'transaction',
    entity_id: `tx_${ordinal}`,
    entity_fingerprint: 'b'.repeat(64),
    row_snapshot_json: '{}',
    row_snapshot_bytes: 2
  })),
  created_at: '2026-09-07T12:00:00.000Z',
  expires_at: '2026-09-08T12:00:00.000Z'
}, 3, 2);
assert.deepEqual(window.items.map((item) => item.ordinal), [3]);
assert.equal(window.has_previous, true);
assert.equal(window.has_next, false);

const patchBaseTurn = await buildApiFinanceTurn({
  requestId: 'patch-base-turn',
  sessionKey: 'api:patch',
  baseSessionVersion: 3,
  text: '本月支出'
});
const activePlan = validateFinancePlan({
  schema_version: 2,
  plan_id: 'plan_patch_base',
  plan_version: 1,
  base_session_version: 3,
  source_turn_id: patchBaseTurn.turn_id,
  ledger_scope_id: 'personal:primary',
  confidence: 0.9,
  presentation: { mode: 'details', page_size: 10 },
  operation: 'query',
  filters: {},
  temporal_scope: null,
  reference: null
}, patchBaseTurn);
const patchTurn = await buildApiFinanceTurn({
  requestId: 'patch-follow-up-turn',
  sessionKey: 'api:patch',
  baseSessionVersion: 3,
  text: '只看餐饮并按金额降序'
});
const patchedPlan = applyFinancePlanPatch(activePlan, {
  schema_version: 2,
  base_plan_id: 'plan_patch_base',
  base_plan_version: 1,
  base_session_version: 3,
  filters: { op: 'replace', value: { categories: [{ kind: 'category', value: '餐饮' }] } },
  presentation: { op: 'replace', value: { mode: 'details', sort_field: 'amount', sort_direction: 'desc', page_size: 10 } }
}, patchTurn);
assert.equal(patchedPlan.plan_id, 'plan_patch_base');
assert.equal(patchedPlan.plan_version, 2);
assert.equal(patchedPlan.source_turn_id, patchTurn.turn_id);
assert.deepEqual(patchedPlan.filters.categories, [{ kind: 'category', value: '餐饮' }]);
assert.equal(patchedPlan.presentation.sort_direction, 'desc');

const clearedPlan = applyFinancePlanPatch(patchedPlan, {
  schema_version: 2,
  base_plan_id: 'plan_patch_base',
  base_plan_version: 2,
  base_session_version: 3,
  filters: { op: 'clear' }
}, patchTurn);
assert.deepEqual(clearedPlan.filters, {});

assert.throws(
  () => validateFinancePlanPatch({
    schema_version: 2,
    base_plan_id: 'plan_patch_base',
    base_plan_version: 2,
    base_session_version: 3,
    filters: { op: 'replace', value: {}, unknown: true }
  }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'invalid_filters_patch'
);
assert.throws(
  () => applyFinancePlanPatch(activePlan, {
    schema_version: 2,
    base_plan_id: 'plan_patch_base',
    base_plan_version: 99,
    base_session_version: 3,
    filters: { op: 'clear' }
  }, patchTurn),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'stale_plan'
);

console.log('finance-v2-vertical.test.ts: PASS');
