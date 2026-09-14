import { canonicalizeJson, type FinancePlan, type RenderPayload } from './protocol';

export const MAX_CREATE_ENTRIES = 20;
export const MAX_RECEIPT_ITEMS = 64;
export const MAX_TOTAL_CREATE_ITEMS = 100;
export const MAX_MUTATION_TARGETS = 50;
export const MAX_D1_BATCH_STATEMENTS = 256;
export const MAX_RESULT_SET_ROWS = 200;
export const MAX_ANALYSIS_DIMENSIONS = 50;
export const MAX_RESULTSET_ROW_SNAPSHOT_BYTES = 8192;
export const MAX_RESULTSET_SNAPSHOT_BYTES = 262144;
export const MAX_FINANCE_RESULT_JSON_BYTES = 131072;
export const MAX_RENDER_PAYLOAD_BYTES = 131072;
export const MAX_TELEGRAM_RENDER_PARTS = 16;
export const MAX_OPERATION_ATTEMPTS = 3;
export const MAX_OUTBOX_ATTEMPTS = 5;

export interface PlanCapacityEstimate {
  entries: number;
  total_items: number;
  mutation_targets: number | null;
}

function operationTooLarge(): never {
  throw new Error('OPERATION_TOO_LARGE');
}

export function estimatePlanCapacity(plan: FinancePlan): PlanCapacityEstimate {
  const entries = plan.operation === 'create' || plan.operation === 'receipt_create' ? plan.entries.length : 0;
  const totalItems = plan.operation === 'create' || plan.operation === 'receipt_create'
    ? plan.entries.reduce((sum, entry) => sum + (entry.items?.length || 0), 0)
    : 0;
  const mutationTargets = plan.operation === 'update' || plan.operation === 'delete'
    ? plan.selection.mode === 'exact_count'
      ? plan.selection.count
      : plan.selection.mode === 'all_matching'
        ? MAX_MUTATION_TARGETS
        : plan.selection.mode === 'exactly_one' || plan.selection.mode === 'reference'
          ? 1
          : null
    : null;
  return { entries, total_items: totalItems, mutation_targets: mutationTargets };
}

export function assertPlanCapacity(plan: FinancePlan): PlanCapacityEstimate {
  const estimate = estimatePlanCapacity(plan);
  if (estimate.entries > MAX_CREATE_ENTRIES) operationTooLarge();
  if (estimate.total_items > MAX_TOTAL_CREATE_ITEMS) operationTooLarge();
  if (plan.operation === 'receipt_create' && (plan.receipt_item_count || estimate.total_items) > MAX_RECEIPT_ITEMS) operationTooLarge();
  if (estimate.mutation_targets !== null && estimate.mutation_targets > MAX_MUTATION_TARGETS) operationTooLarge();
  if ((plan.presentation.page_size || 0) > MAX_RESULT_SET_ROWS) operationTooLarge();
  return estimate;
}

export function assertRenderCapacity(payload: RenderPayload): void {
  if (payload.schema_version !== 2) throw new Error('RENDER_PAYLOAD_INVALID');
  if (payload.telegram_parts.length > MAX_TELEGRAM_RENDER_PARTS) throw new Error('RENDER_TOO_LARGE');
  payload.telegram_parts.forEach((part, index) => {
    if (part.part_index !== index || !part.text || part.text.length > 4096 || !/^[a-f0-9]{64}$/.test(part.part_hash)) {
      throw new Error(part.text && part.text.length > 4096 ? 'RENDER_TOO_LARGE' : 'RENDER_PAYLOAD_INVALID');
    }
  });
  const bytes = new TextEncoder().encode(canonicalizeJson(payload)).byteLength;
  if (bytes > MAX_RENDER_PAYLOAD_BYTES) throw new Error('RENDER_TOO_LARGE');
}
