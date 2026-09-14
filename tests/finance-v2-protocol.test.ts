import assert from 'node:assert/strict';
import {
  assertFinanceSuccessCommitStatus,
  assertRouteWitness,
  canonicalizeJson,
  canonicalizeResultSetRow,
  deriveDeliveryRequestId,
  validateResultSetSnapshot,
  type FinanceSuccessResult,
  type ResultSetItemSnapshot,
  type ResultSetSnapshot
} from '../src/finance-v2/protocol';

const renderHash = 'a'.repeat(64);

function success(operation: FinanceSuccessResult['operation'], commitStatus: 'committed' | 'not_required'): FinanceSuccessResult {
  return {
    schema_version: 2,
    kind: 'success',
    result_id: 'result-1',
    turn_id: 'turn-1',
    operation,
    ledger_scope_id: 'personal:primary',
    commit_status: commitStatus,
    render_hash: renderHash
  } as FinanceSuccessResult;
}

function resultSet(item: ResultSetItemSnapshot): ResultSetSnapshot {
  const snapshotItems = [item].map((value) => ({ ...value }));
  return {
    schema_version: 2,
    result_set_id: 'set-1',
    ledger_scope_id: 'personal:primary',
    session_key: 'telegram:owner:chat-1:topic-0',
    result_set_version: 1,
    row_count: snapshotItems.length,
    page_size: 10,
    sort_filter_fingerprint: renderHash,
    snapshot_bytes: new TextEncoder().encode(canonicalizeJson(snapshotItems)).byteLength,
    items: snapshotItems,
    created_at: '2026-09-07T00:00:00.000Z',
    expires_at: '2026-09-08T00:00:00.000Z'
  };
}

assert.doesNotThrow(() => assertFinanceSuccessCommitStatus(success('create', 'committed')));
assert.doesNotThrow(() => assertFinanceSuccessCommitStatus(success('query', 'not_required')));
assert.throws(() => assertFinanceSuccessCommitStatus(success('create', 'not_required')), /mutation success must be committed/);
assert.throws(() => assertFinanceSuccessCommitStatus(success('query', 'committed')), /read success must be not_required/);

const row = canonicalizeResultSetRow({ merchant: '豆浆', amount_fen: 1250, tags: ['早餐'] });
const item: ResultSetItemSnapshot = {
  ordinal: 1,
  entity_type: 'transaction',
  entity_id: 'tx-1',
  entity_fingerprint: renderHash,
  row_snapshot_json: row.json,
  row_snapshot_bytes: row.bytes
};
assert.doesNotThrow(() => validateResultSetSnapshot(resultSet(item)));

const forgedBytes = resultSet({ ...item, row_snapshot_bytes: item.row_snapshot_bytes + 1 });
assert.throws(() => validateResultSetSnapshot(forgedBytes), /row snapshot JSON\/bytes/);

const wrongOrdinal = resultSet({ ...item, ordinal: 2 });
assert.throws(() => validateResultSetSnapshot(wrongOrdinal), /ordinals/);

const wrongCardinality = resultSet(item);
wrongCardinality.row_count = 2;
assert.throws(() => validateResultSetSnapshot(wrongCardinality), /row_count must equal items.length/);

assert.doesNotThrow(() => assertRouteWitness({
  operation_type: 'update',
  route_epoch: 3,
  config_epoch: 3,
  finance_route_mode: 'primary_v2',
  receipt_route_mode: 'v2'
}));
assert.throws(() => assertRouteWitness({
  operation_type: 'update',
  route_epoch: 2,
  config_epoch: 3,
  finance_route_mode: 'primary_v2',
  receipt_route_mode: 'v2'
}), /route epoch does not match/);
assert.throws(() => assertRouteWitness({
  operation_type: 'receipt_create',
  route_epoch: 3,
  config_epoch: 3,
  finance_route_mode: 'primary_v2',
  receipt_route_mode: 'draining_v2'
}), /receipt V2 route is not enabled/);

const initialId = await deriveDeliveryRequestId({
  result_id: 'result-1',
  destination_id: 'telegram-owner',
  kind: 'initial',
  initial_turn_id: 'turn-1'
});
const replayId = await deriveDeliveryRequestId({
  result_id: 'result-1',
  destination_id: 'telegram-owner',
  kind: 'replay',
  replay_idempotency_key: 'replay-1'
});
const replayIdAgain = await deriveDeliveryRequestId({
  result_id: 'result-1',
  destination_id: 'telegram-owner',
  kind: 'replay',
  replay_idempotency_key: 'replay-1'
});
assert.notEqual(initialId, replayId);
assert.equal(replayId, replayIdAgain);
assert.match(replayId, /^delivery_[a-f0-9]{64}$/);

console.log('finance-v2-protocol.test.ts: PASS');
