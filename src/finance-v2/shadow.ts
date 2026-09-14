import type { D1Like } from '../types';
import { sha256Hex, type FinancePlan } from './protocol';

export type ShadowOperationClass = FinancePlan['operation'] | 'clarification' | 'passthrough' | 'non_finance' | 'error';

export interface ShadowV1Artifact {
  route: 'command' | 'conversation' | 'query' | 'core' | 'passthrough' | 'error';
  operation_class: ShadowOperationClass;
  time_scope_class: 'bounded' | 'unbounded' | 'unknown';
  clarification: 0 | 1;
  passthrough: 0 | 1;
}

export interface ShadowV2Artifact {
  operation_class: ShadowOperationClass;
  schema_valid: 0 | 1;
  has_temporal_scope: 0 | 1;
  has_reference: 0 | 1;
  presentation_mode: 'details' | 'summary' | 'analysis' | 'comparison' | 'unknown';
  confidence_bucket: 'none' | 'low' | 'medium' | 'high';
}

export interface ShadowComparison {
  sample_id: string;
  turn_id_hash: string;
  v1_route: ShadowV1Artifact['route'];
  v1_operation_class: ShadowOperationClass;
  v1_time_scope_class: ShadowV1Artifact['time_scope_class'];
  v1_clarification: 0 | 1;
  v1_passthrough: 0 | 1;
  v2_operation_class: ShadowOperationClass;
  v2_schema_valid: 0 | 1;
  v2_has_temporal_scope: 0 | 1;
  v2_has_reference: 0 | 1;
  v2_presentation_mode: ShadowV2Artifact['presentation_mode'];
  v2_confidence_bucket: ShadowV2Artifact['confidence_bucket'];
  divergence_codes: string[];
  model_call_count: number;
  latency_ms: number;
  created_at: string;
}

function confidenceBucket(value: number | null): ShadowV2Artifact['confidence_bucket'] {
  if (value === null || !Number.isFinite(value)) return 'none';
  if (value < 0.5) return 'low';
  if (value < 0.8) return 'medium';
  return 'high';
}

export function shadowV2Artifact(plan: FinancePlan | null, schemaValid: boolean, confidence?: number): ShadowV2Artifact {
  if (!plan) {
    return {
      operation_class: 'error',
      schema_valid: schemaValid ? 1 : 0,
      has_temporal_scope: 0,
      has_reference: 0,
      presentation_mode: 'unknown',
      confidence_bucket: confidenceBucket(confidence ?? null)
    };
  }
  return {
    operation_class: plan.operation,
    schema_valid: schemaValid ? 1 : 0,
    has_temporal_scope: ('temporal_scope' in plan && plan.temporal_scope) || plan.operation === 'compare' ? 1 : 0,
    has_reference: ('reference' in plan && Boolean(plan.reference)) ? 1 : 0,
    presentation_mode: plan.presentation.mode || 'unknown',
    confidence_bucket: confidenceBucket(plan.confidence)
  };
}

export function compareShadowArtifacts(v1: ShadowV1Artifact, v2: ShadowV2Artifact): string[] {
  const divergences: string[] = [];
  if (v1.operation_class !== v2.operation_class && !(v1.passthrough === 1 && v2.operation_class === 'non_finance')) {
    divergences.push('operation_class_mismatch');
  }
  if (v1.time_scope_class === 'bounded' && v2.has_temporal_scope !== 1) divergences.push('time_scope_missing');
  if (v1.clarification !== 0 && v2.operation_class !== 'clarification') divergences.push('clarification_mismatch');
  if (v1.passthrough !== 0 && v2.operation_class !== 'non_finance') divergences.push('passthrough_mismatch');
  if (v2.schema_valid !== 1) divergences.push('v2_schema_invalid');
  return divergences;
}

export async function persistShadowComparison(
  shadowDb: D1Like | undefined,
  turnId: string,
  v1: ShadowV1Artifact,
  v2: ShadowV2Artifact,
  latencyMs: number,
  modelCallCount = 1,
  createdAt = new Date().toISOString()
): Promise<ShadowComparison | null> {
  if (!shadowDb) return null;
  const turnIdHash = await sha256Hex(turnId);
  const comparison: ShadowComparison = {
    sample_id: `shadow_${turnIdHash}`,
    turn_id_hash: turnIdHash,
    v1_route: v1.route,
    v1_operation_class: v1.operation_class,
    v1_time_scope_class: v1.time_scope_class,
    v1_clarification: v1.clarification,
    v1_passthrough: v1.passthrough,
    v2_operation_class: v2.operation_class,
    v2_schema_valid: v2.schema_valid,
    v2_has_temporal_scope: v2.has_temporal_scope,
    v2_has_reference: v2.has_reference,
    v2_presentation_mode: v2.presentation_mode,
    v2_confidence_bucket: v2.confidence_bucket,
    divergence_codes: compareShadowArtifacts(v1, v2),
    model_call_count: Math.max(0, Math.min(4, Math.floor(modelCallCount))),
    latency_ms: Math.max(0, Math.min(600_000, Math.floor(latencyMs))),
    created_at: createdAt
  };
  await shadowDb.prepare(
    `INSERT OR IGNORE INTO finance_shadow_comparisons (
       sample_id, turn_id_hash, v1_route, v1_operation_class, v1_time_scope_class,
       v1_clarification, v1_passthrough, v2_operation_class, v2_schema_valid,
       v2_has_temporal_scope, v2_has_reference, v2_presentation_mode,
       v2_confidence_bucket, divergence_codes_json, model_call_count, latency_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    comparison.sample_id,
    comparison.turn_id_hash,
    comparison.v1_route,
    comparison.v1_operation_class,
    comparison.v1_time_scope_class,
    comparison.v1_clarification,
    comparison.v1_passthrough,
    comparison.v2_operation_class,
    comparison.v2_schema_valid,
    comparison.v2_has_temporal_scope,
    comparison.v2_has_reference,
    comparison.v2_presentation_mode,
    comparison.v2_confidence_bucket,
    JSON.stringify(comparison.divergence_codes),
    comparison.model_call_count,
    comparison.latency_ms,
    comparison.created_at
  ).run();
  return comparison;
}
