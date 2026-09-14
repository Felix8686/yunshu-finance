import assert from 'node:assert/strict';
import { buildTurnContextSnapshot } from '../src/finance-v2/context';
import { canonicalizeJson, sha256Hex } from '../src/finance-v2/protocol';

const activePlan = {
  schema_version: 2 as const,
  plan_id: 'plan-1',
  plan_version: 2,
  base_session_version: 4,
  source_turn_id: 'turn-1',
  ledger_scope_id: 'personal:primary' as const,
  confidence: 0.9,
  presentation: { mode: 'details' as const, page_size: 10 },
  operation: 'query' as const,
  filters: {},
  temporal_scope: null,
  reference: null
};

const snapshot = await buildTurnContextSnapshot({
  turnId: 'turn-2',
  sessionKey: 'telegram:owner:topic:0',
  baseSessionVersion: 5,
  activePlan,
  activeResultSetId: 'result-set-1',
  activeWindow: { result_set_id: 'result-set-1', result_set_version: 1, start_ordinal: 1, end_ordinal: 10, page_size: 10 },
  previousWindow: { result_set_id: 'result-set-1', result_set_version: 1, start_ordinal: 11, end_ordinal: 20, page_size: 10 },
  recentTurnSummaries: Array.from({ length: 20 }, (_, index) => `summary-${index}`),
  catalogHash: 'a'.repeat(64)
});

assert.equal(snapshot.schema_version, 2);
assert.match(snapshot.snapshot_id, /^snapshot_[a-f0-9]{64}$/);
assert.equal(snapshot.active_plan?.plan_id, 'plan-1');
assert.deepEqual(snapshot.active_window, { result_set_id: 'result-set-1', result_set_version: 1, start_ordinal: 1, end_ordinal: 10, page_size: 10 });
assert.deepEqual(snapshot.previous_window, { result_set_id: 'result-set-1', result_set_version: 1, start_ordinal: 11, end_ordinal: 20, page_size: 10 });
assert.equal(snapshot.recent_turn_summaries.length, 12);
assert.deepEqual(snapshot.recent_turn_summaries, Array.from({ length: 12 }, (_, index) => `summary-${index + 8}`));
assert.match(snapshot.catalog_hash, /^[a-f0-9]{64}$/);
assert.match(snapshot.snapshot_hash, /^[a-f0-9]{64}$/);
const { snapshot_hash: snapshotHash, ...snapshotBody } = snapshot;
assert.equal(snapshotHash, await sha256Hex(canonicalizeJson({ ...snapshotBody, snapshot_hash: '' })));
await assert.rejects(() => buildTurnContextSnapshot({
  turnId: 'turn-invalid',
  sessionKey: 'api:owner:default',
  baseSessionVersion: -1,
  activePlan: null,
  activeResultSetId: null,
  activeWindow: null,
  previousWindow: null,
  recentTurnSummaries: [],
  catalogHash: 'b'.repeat(64),
  capturedAt: 'invalid'
}), /INVALID_CONTEXT_BASE_SESSION_VERSION/);

console.log('finance-v2-context.test.ts: PASS');
