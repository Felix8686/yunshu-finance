import assert from 'node:assert/strict';
import { assertPlanCapacity, assertRenderCapacity, MAX_CREATE_ENTRIES, MAX_RECEIPT_ITEMS, MAX_TOTAL_CREATE_ITEMS } from '../src/finance-v2/capacity';

const base = {
  schema_version: 2 as const,
  plan_id: 'capacity-plan',
  plan_version: 1,
  base_session_version: 0,
  source_turn_id: 'capacity-turn',
  ledger_scope_id: 'personal:primary' as const,
  confidence: 1,
  presentation: { page_size: 10 }
};

const entry = (items: unknown[] = []) => ({
  client_entry_key: 'entry',
  type: 'expense' as const,
  money: { amount_fen: 100, currency: 'CNY' as const },
  occurred_at: '2026-09-08T00:00:00+08:00',
  account: null,
  category: null,
  merchant: null,
  description: null,
  items
});

const item = (index: number) => ({
  client_item_key: `item-${index}`,
  name: `item-${index}`,
  quantity: 1,
  unit_price_fen: 1,
  line_total_fen: 1,
  category: '其他',
  confidence: 1
});

assert.throws(() => assertPlanCapacity({ ...base, operation: 'create', entries: Array.from({ length: MAX_CREATE_ENTRIES + 1 }, () => entry()) }), /OPERATION_TOO_LARGE/);
assert.throws(() => assertPlanCapacity({ ...base, operation: 'create', entries: [entry(Array.from({ length: MAX_TOTAL_CREATE_ITEMS + 1 }, (_, index) => item(index)))] }), /OPERATION_TOO_LARGE/);
assert.throws(() => assertPlanCapacity({ ...base, operation: 'receipt_create', receipt_job_id: 'job', receipt_artifact_id: 'artifact', receipt_item_count: MAX_RECEIPT_ITEMS + 1, entries: [entry()] }), /OPERATION_TOO_LARGE/);
assert.throws(() => assertRenderCapacity({ schema_version: 2, telegram_parts: Array.from({ length: 17 }, (_, part_index) => ({ part_index, text: 'x', part_hash: '0'.repeat(64) })) }), /RENDER_TOO_LARGE/);

console.log('finance-v2-capacity.test.ts: PASS');
