import assert from 'node:assert/strict';
import { compareShadowArtifacts, persistShadowComparison, shadowV2Artifact, type ShadowV1Artifact } from '../src/finance-v2/shadow';

const v1: ShadowV1Artifact = {
  route: 'conversation',
  operation_class: 'query',
  time_scope_class: 'bounded',
  clarification: 0,
  passthrough: 0
};
const v2 = shadowV2Artifact({
  schema_version: 2,
  plan_id: 'p',
  plan_version: 1,
  base_session_version: 0,
  source_turn_id: 't',
  ledger_scope_id: 'personal:primary',
  confidence: 0.9,
  presentation: { mode: 'details' },
  operation: 'query',
  filters: {},
  temporal_scope: { from: '2026-09-01', to: '2026-09-02', timezone: 'Asia/Shanghai', end_exclusive: true },
  reference: null
}, true, 0.9);
assert.deepEqual(compareShadowArtifacts(v1, v2), []);
assert.deepEqual(compareShadowArtifacts(v1, shadowV2Artifact(null, false)), ['operation_class_mismatch', 'time_scope_missing', 'v2_schema_invalid']);

const writes: unknown[] = [];
const db = {
  prepare(sql: string) {
    return {
      bind(...values: unknown[]) {
        writes.push({ sql, values });
        return { run: async () => ({ meta: { changes: 1 } }) };
      }
    };
  },
  batch: async () => []
};
const stored = await persistShadowComparison(db, 'turn-sensitive-value', v1, v2, 42, 1, '2026-09-08T00:00:00.000Z');
assert.equal(stored?.turn_id_hash.length, 64);
assert.equal(writes.length, 1);
assert.match(String((writes[0] as { sql: string }).sql), /finance_shadow_comparisons/);
assert.doesNotMatch(JSON.stringify(writes[0]), /turn-sensitive-value/);

console.log('finance-v2-shadow.test.ts: PASS');
