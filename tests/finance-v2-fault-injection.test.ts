import assert from 'node:assert/strict';
import { assertRenderCapacity, MAX_D1_BATCH_STATEMENTS } from '../src/finance-v2/capacity';
import { assertRouteWitness, type ResultSetSnapshot, type RuntimeControl } from '../src/finance-v2/protocol';
import { routeAllowsOperation } from '../src/finance-v2/runtime-control';
import { buildResultSetStatements, transitionRuntimeControl } from '../src/finance-v2/persistence';
import type { D1Like } from '../src/types';

const control: RuntimeControl = {
  schema_version: 2,
  control_id: 'primary',
  config_epoch: 4,
  finance_route_mode: 'primary_v2',
  receipt_route_mode: 'v2',
  outbox_mode: 'enabled',
  shadow_mode: 'off',
  analysis_prose_enabled: 0,
  updated_at: '2026-09-08T00:00:00.000Z'
};

assert.equal(routeAllowsOperation(control, 'query'), true);
assert.equal(routeAllowsOperation({ ...control, finance_route_mode: 'draining_v2' }, 'query'), false);
assert.equal(routeAllowsOperation({ ...control, receipt_route_mode: 'draining_v2' }, 'receipt_create'), false);
assert.equal(routeAllowsOperation({ ...control, outbox_mode: 'paused' }, 'outbox'), false);

assert.doesNotThrow(() => assertRouteWitness({
  operation_type: 'update',
  route_epoch: 4,
  config_epoch: 4,
  finance_route_mode: 'primary_v2',
  receipt_route_mode: 'v2'
}));
assert.throws(() => assertRouteWitness({
  operation_type: 'update',
  route_epoch: 3,
  config_epoch: 4,
  finance_route_mode: 'primary_v2',
  receipt_route_mode: 'v2'
}), /route epoch does not match/);
assert.throws(() => assertRouteWitness({
  operation_type: 'receipt_create',
  route_epoch: 4,
  config_epoch: 4,
  finance_route_mode: 'primary_v2',
  receipt_route_mode: 'draining_v2'
}), /receipt V2 route is not enabled/);

const validRender = {
  schema_version: 2 as const,
  telegram_parts: [{ part_index: 0, text: 'ok', part_hash: 'a'.repeat(64) }]
};
assert.doesNotThrow(() => assertRenderCapacity(validRender));
assert.throws(() => assertRenderCapacity({
  ...validRender,
  telegram_parts: [{ part_index: 1, text: 'ok', part_hash: 'a'.repeat(64) }]
}), /RENDER_PAYLOAD_INVALID/);

const resultSet: ResultSetSnapshot = {
  schema_version: 2,
  result_set_id: 'fault-result-set',
  ledger_scope_id: 'personal:primary',
  session_key: 'api:faults',
  result_set_version: 1,
  row_count: MAX_D1_BATCH_STATEMENTS,
  page_size: 20,
  sort_filter_fingerprint: 'b'.repeat(64),
  snapshot_bytes: 1,
  items: Array.from({ length: MAX_D1_BATCH_STATEMENTS }, (_, index) => ({
    ordinal: index + 1,
    entity_type: 'transaction' as const,
    entity_id: `tx-${index + 1}`,
    entity_fingerprint: 'c'.repeat(64),
    row_snapshot_json: '{}',
    row_snapshot_bytes: 2
  })),
  created_at: '2026-09-08T00:00:00.000Z',
  expires_at: '2026-09-09T00:00:00.000Z'
};
let prepareCount = 0;
const statementDb = {
  prepare() {
    prepareCount += 1;
    return { bind: (..._values: unknown[]) => ({}) };
  }
} as unknown as D1Like;
assert.throws(() => buildResultSetStatements(statementDb, resultSet), /OPERATION_TOO_LARGE/);
assert.equal(prepareCount, MAX_D1_BATCH_STATEMENTS + 1);

const epochRaceDb = {
  prepare(sql: string) {
    return {
      first: async <T>() => sql.includes('FROM finance_runtime_control') ? control as unknown as T : null,
      bind: (..._values: unknown[]) => ({
        run: async () => ({ meta: { changes: 0 } }),
        first: async <T>() => control as unknown as T
      })
    };
  }
} as unknown as D1Like;
await assert.rejects(
  transitionRuntimeControl(epochRaceDb, control.config_epoch, { finance_route_mode: 'draining_v2' }),
  /RUNTIME_CONTROL_EPOCH_CONFLICT/
);

console.log('finance-v2-fault-injection.test.ts: PASS');
