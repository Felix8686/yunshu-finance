import assert from 'node:assert/strict';
import { planRuntimeControlTransition } from '../src/finance-v2/runtime-control';
import { assertRuntimeControl, type RuntimeControl } from '../src/finance-v2/protocol';

const initial: RuntimeControl = {
  schema_version: 2,
  control_id: 'primary',
  config_epoch: 1,
  finance_route_mode: 'primary_v1',
  receipt_route_mode: 'v1',
  outbox_mode: 'paused',
  shadow_mode: 'off',
  analysis_prose_enabled: 0,
  updated_at: '2026-09-08T00:00:00.000Z'
};

const shadow = planRuntimeControlTransition(initial, {
  finance_route_mode: 'shadow_v2',
  shadow_mode: 'interpretation_only'
});
assert.equal(shadow.config_epoch, 2);
assert.equal(shadow.finance_route_mode, 'shadow_v2');
assert.equal(shadow.shadow_mode, 'interpretation_only');

const canary = planRuntimeControlTransition(shadow, { finance_route_mode: 'canary_v2' });
assert.equal(canary.config_epoch, 3);
assert.equal(canary.finance_route_mode, 'canary_v2');
assert.equal(canary.shadow_mode, 'off');

const primary = planRuntimeControlTransition(canary, { finance_route_mode: 'primary_v2' });
assert.equal(primary.config_epoch, 4);

const draining = planRuntimeControlTransition(primary, { finance_route_mode: 'draining_v2' });
assert.equal(draining.config_epoch, 5);
const rolledBack = planRuntimeControlTransition(draining, { finance_route_mode: 'primary_v1' });
assert.equal(rolledBack.config_epoch, 6);

const reShadow = planRuntimeControlTransition(rolledBack, { finance_route_mode: 'shadow_v2' });
assert.equal(reShadow.config_epoch, 7);
const reCanary = planRuntimeControlTransition(reShadow, { finance_route_mode: 'canary_v2' });
assert.equal(reCanary.config_epoch, 8);
const rePrimary = planRuntimeControlTransition(reCanary, { finance_route_mode: 'primary_v2' });
assert.equal(rePrimary.config_epoch, 9);

const receiptDraining = planRuntimeControlTransition(initial, { receipt_route_mode: 'draining_v1' });
assert.equal(receiptDraining.config_epoch, 2);
const receiptV2 = planRuntimeControlTransition(receiptDraining, { receipt_route_mode: 'v2' });
assert.equal(receiptV2.config_epoch, 3);
const receiptDrainingBack = planRuntimeControlTransition(receiptV2, { receipt_route_mode: 'draining_v2' });
assert.equal(receiptDrainingBack.config_epoch, 4);
const receiptV1 = planRuntimeControlTransition(receiptDrainingBack, { receipt_route_mode: 'v1' });
assert.equal(receiptV1.config_epoch, 5);

const outboxEnabled = planRuntimeControlTransition(initial, { outbox_mode: 'enabled' });
assert.equal(outboxEnabled.config_epoch, 2);
const outboxDraining = planRuntimeControlTransition(outboxEnabled, { outbox_mode: 'draining' });
assert.equal(outboxDraining.config_epoch, 3);
const outboxPaused = planRuntimeControlTransition(outboxDraining, { outbox_mode: 'paused' });
assert.equal(outboxPaused.config_epoch, 4);

assert.throws(
  () => planRuntimeControlTransition(initial, { finance_route_mode: 'primary_v2' }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'illegal_runtime_transition'
);
assert.throws(
  () => planRuntimeControlTransition(initial, { shadow_mode: 'interpretation_only' }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'invalid_shadow_route_pair'
);
assert.throws(
  () => planRuntimeControlTransition(initial, { unknown_field: 'ignored' } as never),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'invalid_runtime_control'
);
assert.throws(
  () => assertRuntimeControl({ ...initial, finance_route_mode: 'shadow_v2', shadow_mode: 'off' }),
  (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: string }).code === 'invalid_runtime_control'
);

console.log('finance-v2-runtime-control.test.ts: PASS');
