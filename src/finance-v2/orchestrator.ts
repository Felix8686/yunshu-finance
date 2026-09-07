import { financeReferencePrompt, loadFinanceReferenceCatalog } from '../finance-reference';
import type { Env } from '../types';
import {
  ProtocolValidationError,
  type CreateItem,
  type FinanceChanges,
  type FinanceOperationType,
  type FinancePlan,
  type PlanPatch,
  type PlanPatchComponent,
  type FinanceTurn,
  type FinanceFilters,
  type FinancePresentation,
  type FinanceSelection,
  type ReferenceSpec,
  type TemporalScope
} from './protocol';

interface OrchestratorContext {
  sessionVersion: number;
  activePlan?: FinancePlan | null;
  recentTurnSummaries?: string[];
  receiptArtifact?: unknown;
  baselinePlan?: unknown;
  requiredOperation?: FinancePlan['operation'];
}

const OPERATIONS = new Set(['create', 'query', 'summarize', 'analyze', 'compare', 'update', 'delete', 'restore', 'receipt_create']);
const TRANSACTION_TYPES = new Set(['expense', 'income', 'transfer']);

function planResponseSchema(): Record<string, unknown> {
  const planSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'schema_version', 'plan_id', 'plan_version', 'base_session_version', 'source_turn_id',
      'ledger_scope_id', 'operation', 'confidence', 'presentation'
    ],
    properties: {
      schema_version: { const: 2 },
      plan_id: { type: 'string', minLength: 1, maxLength: 128 },
      plan_version: { type: 'integer', minimum: 1 },
      base_session_version: { type: 'integer', minimum: 0 },
      source_turn_id: { type: 'string', minLength: 1, maxLength: 128 },
      ledger_scope_id: { const: 'personal:primary' },
      operation: { enum: [...OPERATIONS] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      presentation: { type: 'object' },
      temporal_scope: { type: ['object', 'null'] },
      filters: { type: 'object' },
      entries: { type: 'array', maxItems: 100 },
      selection: { type: 'object' },
      changes: { type: 'object' },
      reference: { type: 'object' },
      receipt_job_id: { type: 'string', minLength: 1, maxLength: 256 },
      receipt_artifact_id: { type: 'string', minLength: 1, maxLength: 256 },
      receipt_merchant: { type: ['string', 'null'], maxLength: 160 },
      receipt_total_fen: { type: 'integer', minimum: 1 },
      receipt_item_count: { type: 'integer', minimum: 1, maximum: 200 },
      left_scope: { type: 'object' },
      right_scope: { type: 'object' },
      metric: { type: 'string' },
      dimension: { type: 'string' }
    }
  };
  const replaceOrClear = (value: Record<string, unknown>) => ({
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['op', 'value'], properties: { op: { const: 'replace' }, value } },
      { type: 'object', additionalProperties: false, required: ['op'], properties: { op: { const: 'clear' } } }
    ]
  });
  const patchSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'base_plan_id', 'base_plan_version', 'base_session_version'],
    properties: {
      schema_version: { const: 2 },
      base_plan_id: { type: 'string', minLength: 1, maxLength: 128 },
      base_plan_version: { type: 'integer', minimum: 1 },
      base_session_version: { type: 'integer', minimum: 0 },
      operation: { type: 'object', additionalProperties: false, required: ['op', 'value'], properties: { op: { const: 'replace' }, value: { enum: [...OPERATIONS] } } },
      temporal_scope: replaceOrClear({ type: 'object' }),
      filters: replaceOrClear({ type: 'object' }),
      selection: replaceOrClear({ type: 'object' }),
      changes: replaceOrClear({ type: 'object' }),
      presentation: replaceOrClear({ type: 'object' }),
      reference: replaceOrClear({ type: 'object' })
    }
  };
  return {
    oneOf: [
      planSchema,
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'schema_version', 'plan', 'field_confidence'],
        properties: {
          kind: { const: 'new_plan' },
          schema_version: { const: 2 },
          plan: planSchema,
          field_confidence: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 }, maxProperties: 64 }
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'schema_version', 'patch', 'field_confidence'],
        properties: {
          kind: { const: 'patch_plan' },
          schema_version: { const: 2 },
          patch: patchSchema,
          field_confidence: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 }, maxProperties: 64 }
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'schema_version', 'clarification'],
        properties: {
          kind: { const: 'clarification' },
          schema_version: { const: 2 },
          clarification: { type: 'object', additionalProperties: false, required: ['reason', 'message'], properties: { reason: { type: 'string' }, message: { type: 'string', minLength: 1, maxLength: 512 } } }
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'schema_version'],
        properties: { kind: { const: 'non_finance' }, schema_version: { const: 2 } }
      }
    ]
  };
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError(code, 'expected object');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProtocolValidationError(code, 'expected non-empty string');
  return value.trim();
}

function integerValue(value: unknown, code: string, minimum = 0): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new ProtocolValidationError(code, 'expected bounded integer');
  return number;
}

function numberValue(value: unknown, code: string, minimum = 0, maximum = 1): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new ProtocolValidationError(code, 'expected bounded number');
  return number;
}

function validatePresentation(value: unknown): FinancePresentation {
  const presentation = objectValue(value, 'invalid_presentation');
  const result: FinancePresentation = {};
  if (presentation.mode !== undefined) {
    if (!['details', 'summary', 'analysis', 'comparison'].includes(String(presentation.mode))) throw new ProtocolValidationError('invalid_presentation', 'invalid presentation mode');
    result.mode = presentation.mode as FinancePresentation['mode'];
  }
  if (presentation.page_size !== undefined) result.page_size = integerValue(presentation.page_size, 'invalid_page_size', 1);
  if (result.page_size && result.page_size > 20) throw new ProtocolValidationError('invalid_page_size', 'page size exceeds 20');
  if (presentation.fields !== undefined) {
    if (!Array.isArray(presentation.fields) || presentation.fields.length > 20) throw new ProtocolValidationError('invalid_presentation', 'fields must be a bounded array');
    const allowedFields = new Set(['date', 'time', 'item', 'amount', 'category', 'account', 'merchant', 'type']);
    if (presentation.fields.some((field) => !allowedFields.has(String(field)))) throw new ProtocolValidationError('invalid_presentation', 'unsupported presentation field');
    result.fields = presentation.fields as FinancePresentation['fields'];
  }
  if (presentation.sort_field !== undefined) {
    if (!['occurred_at', 'amount', 'item', 'category', 'account'].includes(String(presentation.sort_field))) throw new ProtocolValidationError('invalid_presentation', 'unsupported sort field');
    result.sort_field = presentation.sort_field as FinancePresentation['sort_field'];
  }
  if (presentation.sort_direction !== undefined) {
    if (!['asc', 'desc'].includes(String(presentation.sort_direction))) throw new ProtocolValidationError('invalid_presentation', 'unsupported sort direction');
    result.sort_direction = presentation.sort_direction as FinancePresentation['sort_direction'];
  }
  if (presentation.group_by !== undefined) {
    if (!['none', 'date', 'category', 'account', 'merchant'].includes(String(presentation.group_by))) throw new ProtocolValidationError('invalid_presentation', 'unsupported group field');
    result.group_by = presentation.group_by as FinancePresentation['group_by'];
  }
  if (presentation.compact !== undefined) result.compact = Boolean(presentation.compact);
  if (presentation.page_token !== undefined) result.page_token = presentation.page_token === null ? null : stringValue(presentation.page_token, 'invalid_page_token');
  return result;
}

function validateFilters(value: unknown): FinanceFilters {
  const filters = objectValue(value, 'invalid_filters');
  const result: FinanceFilters = {};
  for (const key of ['categories', 'accounts'] as const) {
    if (filters[key] === undefined) continue;
    if (!Array.isArray(filters[key]) || filters[key].length > 20) throw new ProtocolValidationError('invalid_filters', `${key} must be a bounded array`);
    const expectedKind = key === 'categories' ? 'category' : 'account';
    result[key] = filters[key].map((item) => {
      const reference = objectValue(item, 'invalid_filters');
      if (reference.kind !== expectedKind) throw new ProtocolValidationError('invalid_filters', `${key} contains an invalid catalog kind`);
      return { kind: expectedKind, value: stringValue(reference.value, 'invalid_filters') };
    });
  }
  if (filters.types !== undefined) {
    if (!Array.isArray(filters.types) || filters.types.some((item) => !TRANSACTION_TYPES.has(String(item)))) throw new ProtocolValidationError('invalid_filters', 'invalid transaction type filter');
    result.types = filters.types as FinanceFilters['types'];
  }
  if (filters.merchant_text !== undefined) result.merchant_text = filters.merchant_text === null ? null : String(filters.merchant_text).slice(0, 128);
  if (filters.semantic_text !== undefined) result.semantic_text = filters.semantic_text === null ? null : String(filters.semantic_text).slice(0, 256);
  if (filters.amount_min_fen !== undefined && filters.amount_min_fen !== null) result.amount_min_fen = integerValue(filters.amount_min_fen, 'invalid_money', 0);
  if (filters.amount_max_fen !== undefined && filters.amount_max_fen !== null) result.amount_max_fen = integerValue(filters.amount_max_fen, 'invalid_money', 0);
  if (typeof result.amount_min_fen === 'number' && typeof result.amount_max_fen === 'number' && result.amount_min_fen > result.amount_max_fen) throw new ProtocolValidationError('invalid_money', 'minimum amount exceeds maximum amount');
  return result;
}

function validateCatalogReference(value: unknown, expectedKind: 'account' | 'category' | 'merchant', code: string): { kind: 'account' | 'category' | 'merchant'; value: string } {
  const reference = objectValue(value, code);
  if (reference.kind !== expectedKind) throw new ProtocolValidationError(code, `expected ${expectedKind} catalog reference`);
  return { kind: expectedKind, value: stringValue(reference.value, code) };
}

function validateChanges(value: unknown): FinanceChanges {
  const changes = objectValue(value, 'invalid_changes');
  rejectUnknownKeys(changes, ['amount_fen', 'currency', 'occurred_at', 'account', 'category', 'merchant', 'description', 'item_patch'], 'invalid_changes');
  const result: FinanceChanges = {};
  if (changes.amount_fen !== undefined) result.amount_fen = changes.amount_fen === null ? null : integerValue(changes.amount_fen, 'invalid_money', 1);
  if (changes.currency !== undefined) {
    if (changes.currency !== 'CNY') throw new ProtocolValidationError('invalid_currency', 'only CNY is supported');
    result.currency = 'CNY';
  }
  if (changes.occurred_at !== undefined) result.occurred_at = changes.occurred_at === null ? null : validateDateTime(changes.occurred_at, 'invalid_occurred_at');
  if (changes.account !== undefined) result.account = changes.account === null ? null : validateCatalogReference(changes.account, 'account', 'invalid_account');
  if (changes.category !== undefined) result.category = changes.category === null ? null : validateCatalogReference(changes.category, 'category', 'invalid_category');
  if (changes.merchant !== undefined) result.merchant = changes.merchant === null ? null : String(changes.merchant).slice(0, 256);
  if (changes.description !== undefined) result.description = changes.description === null ? null : String(changes.description).slice(0, 512);
  if (changes.item_patch !== undefined) {
    const itemPatch = objectValue(changes.item_patch, 'invalid_item_patch');
    rejectUnknownKeys(itemPatch, ['target', 'name', 'quantity', 'unit_price_fen', 'line_total_fen', 'category'], 'invalid_item_patch');
    const itemResult: NonNullable<FinanceChanges['item_patch']> = {
      target: validateReference(itemPatch.target),
      ...(itemPatch.name !== undefined ? { name: itemPatch.name === null ? null : stringValue(itemPatch.name, 'invalid_item_patch') } : {}),
      ...(itemPatch.quantity !== undefined ? { quantity: itemPatch.quantity === null ? null : Number(itemPatch.quantity) } : {}),
      ...(itemPatch.unit_price_fen !== undefined ? { unit_price_fen: itemPatch.unit_price_fen === null ? null : integerValue(itemPatch.unit_price_fen, 'invalid_item_amount', 0) } : {}),
      ...(itemPatch.line_total_fen !== undefined ? { line_total_fen: itemPatch.line_total_fen === null ? null : integerValue(itemPatch.line_total_fen, 'invalid_item_amount', 0) } : {}),
      ...(itemPatch.category !== undefined ? { category: itemPatch.category === null ? null : stringValue(itemPatch.category, 'invalid_item_patch') } : {})
    };
    if (itemResult.target.kind !== 'transaction_item') throw new ProtocolValidationError('invalid_item_patch', 'item patch target must be a transaction item');
    if (itemResult.quantity !== undefined && itemResult.quantity !== null && (!Number.isFinite(itemResult.quantity) || itemResult.quantity <= 0 || itemResult.quantity > 10000)) throw new ProtocolValidationError('invalid_item_patch', 'invalid item quantity');
    result.item_patch = itemResult;
  }
  return result;
}

function validateReference(value: unknown): ReferenceSpec {
  const reference = objectValue(value, 'invalid_reference');
  const kind = stringValue(reference.kind, 'invalid_reference');
  if (kind === 'result_ordinal') {
    return {
      kind,
      result_set_id: stringValue(reference.result_set_id, 'invalid_reference'),
      ordinal: integerValue(reference.ordinal, 'invalid_reference', 1)
    };
  }
  if (kind === 'result_window') {
    return {
      kind,
      result_set_id: stringValue(reference.result_set_id, 'invalid_reference'),
      window_start_ordinal: integerValue(reference.window_start_ordinal, 'invalid_reference', 1),
      window_end_ordinal: integerValue(reference.window_end_ordinal, 'invalid_reference', 1),
      result_set_version: integerValue(reference.result_set_version, 'invalid_reference', 1)
    };
  }
  if (kind === 'operation') return { kind, operation_id: stringValue(reference.operation_id, 'invalid_reference') };
  if (kind === 'receipt') return { kind, receipt_artifact_id: stringValue(reference.receipt_artifact_id, 'invalid_reference') };
  if (kind === 'transaction') return { kind, transaction_id: stringValue(reference.transaction_id, 'invalid_reference') };
  if (kind === 'transaction_item') return { kind, item_id: stringValue(reference.item_id, 'invalid_reference') };
  if (kind === 'session_semantic') {
    const semanticKey = stringValue(reference.semantic_key, 'invalid_reference') as Extract<ReferenceSpec, { kind: 'session_semantic' }>['semantic_key'];
    if (!['last_created', 'last_updated', 'last_deleted', 'last_restored', 'last_receipt', 'active_result_set', 'previous_result_set', 'active_window', 'previous_window'].includes(semanticKey)) throw new ProtocolValidationError('invalid_reference', 'unsupported session semantic reference');
    return { kind, semantic_key: semanticKey };
  }
  throw new ProtocolValidationError('invalid_reference', 'unsupported reference kind');
}

function validateSelection(value: unknown): FinanceSelection {
  const selection = objectValue(value, 'invalid_selection');
  const mode = stringValue(selection.mode, 'invalid_selection');
  if (mode === 'exactly_one' || mode === 'all_matching') return { mode };
  if (mode === 'exact_count') return { mode, count: integerValue(selection.count, 'invalid_selection_count', 1) };
  if (mode === 'reference') return { mode, reference: validateReference(selection.reference) };
  throw new ProtocolValidationError('invalid_selection', 'unsupported selection mode');
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], code: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ProtocolValidationError(code, `unknown field: ${key}`);
  }
}

function validatePatchComponent<T>(value: unknown, code: string, validator: (value: unknown) => T): PlanPatchComponent<T> {
  const component = objectValue(value, code);
  rejectUnknownKeys(component, ['op', 'value'], code);
  if (component.op === 'clear') return { op: 'clear' };
  if (component.op !== 'replace') throw new ProtocolValidationError(code, 'patch component must use replace or clear');
  if (!Object.prototype.hasOwnProperty.call(component, 'value')) throw new ProtocolValidationError(code, 'replace patch requires value');
  return { op: 'replace', value: validator(component.value) };
}

export function validateFinancePlanPatch(value: unknown): PlanPatch {
  const source = objectValue(value, 'invalid_plan_patch');
  rejectUnknownKeys(source, [
    'schema_version', 'base_plan_id', 'base_plan_version', 'base_session_version',
    'operation', 'temporal_scope', 'filters', 'selection', 'changes', 'presentation', 'reference'
  ], 'invalid_plan_patch');
  if (source.schema_version !== 2) throw new ProtocolValidationError('invalid_plan_patch', 'unsupported patch schema');
  const basePlanId = stringValue(source.base_plan_id, 'invalid_plan_patch');
  const basePlanVersion = integerValue(source.base_plan_version, 'invalid_plan_patch', 1);
  const baseSessionVersion = integerValue(source.base_session_version, 'invalid_plan_patch', 0);
  let operation: PlanPatch['operation'];
  if (source.operation !== undefined) {
    const operationPatch = objectValue(source.operation, 'invalid_operation_patch');
    rejectUnknownKeys(operationPatch, ['op', 'value'], 'invalid_operation_patch');
    if (operationPatch.op !== 'replace' || typeof operationPatch.value !== 'string' || !OPERATIONS.has(operationPatch.value)) {
      throw new ProtocolValidationError('invalid_operation_patch', 'operation patch must replace with a supported operation');
    }
    operation = { op: 'replace', value: operationPatch.value as FinanceOperationType };
  }
  return {
    schema_version: 2,
    base_plan_id: basePlanId,
    base_plan_version: basePlanVersion,
    base_session_version: baseSessionVersion,
    ...(operation ? { operation } : {}),
    ...(source.temporal_scope !== undefined ? {
      temporal_scope: validatePatchComponent(source.temporal_scope, 'invalid_temporal_patch', (item) => validateTemporalScope(item))
    } : {}),
    ...(source.filters !== undefined ? {
      filters: validatePatchComponent(source.filters, 'invalid_filters_patch', (item) => validateFilters(item))
    } : {}),
    ...(source.selection !== undefined ? {
      selection: validatePatchComponent(source.selection, 'invalid_selection_patch', (item) => validateSelection(item))
    } : {}),
    ...(source.changes !== undefined ? {
      changes: validatePatchComponent(source.changes, 'invalid_changes_patch', (item) => objectValue(item, 'invalid_changes') as FinanceChanges)
    } : {}),
    ...(source.presentation !== undefined ? {
      presentation: validatePatchComponent(source.presentation, 'invalid_presentation_patch', (item) => validatePresentation(item))
    } : {}),
    ...(source.reference !== undefined ? {
      reference: validatePatchComponent(source.reference, 'invalid_reference_patch', (item) => validateReference(item))
    } : {})
  };
}

function clonePlan(value: FinancePlan): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function removeOperationFields(candidate: Record<string, unknown>): void {
  for (const key of [
    'entries', 'filters', 'temporal_scope', 'reference', 'selection', 'changes',
    'metric', 'dimension', 'left_scope', 'right_scope',
    'receipt_job_id', 'receipt_artifact_id', 'receipt_merchant', 'receipt_total_fen', 'receipt_item_count'
  ]) delete candidate[key];
}

function applyPatchComponent(candidate: Record<string, unknown>, key: string, patch: PlanPatchComponent<unknown>, clearValue: unknown = undefined): void {
  if (patch.op === 'clear') {
    if (clearValue === undefined) delete candidate[key];
    else candidate[key] = clearValue;
    return;
  }
  candidate[key] = patch.value;
}

export function applyFinancePlanPatch(activePlan: FinancePlan, value: unknown, turn: FinanceTurn): FinancePlan {
  const patch = validateFinancePlanPatch(value);
  if (patch.base_plan_id !== activePlan.plan_id || patch.base_plan_version !== activePlan.plan_version) {
    throw new ProtocolValidationError('stale_plan', 'patch base plan does not match active plan');
  }
  const currentSessionVersion = turn.base_session_version ?? patch.base_session_version;
  if (patch.base_session_version !== currentSessionVersion) {
    throw new ProtocolValidationError('stale_turn', 'patch base session version does not match current turn');
  }
  const candidate = clonePlan(activePlan);
  candidate.plan_id = activePlan.plan_id;
  candidate.plan_version = activePlan.plan_version + 1;
  candidate.base_session_version = currentSessionVersion;
  candidate.source_turn_id = turn.turn_id;
  if (patch.operation) {
    removeOperationFields(candidate);
    candidate.operation = patch.operation.value;
  }
  if (patch.temporal_scope) applyPatchComponent(candidate, 'temporal_scope', patch.temporal_scope as PlanPatchComponent<unknown>, null);
  if (patch.filters) applyPatchComponent(candidate, 'filters', patch.filters as PlanPatchComponent<unknown>, {});
  if (patch.selection) applyPatchComponent(candidate, 'selection', patch.selection as PlanPatchComponent<unknown>);
  if (patch.changes) applyPatchComponent(candidate, 'changes', patch.changes as PlanPatchComponent<unknown>);
  if (patch.presentation) applyPatchComponent(candidate, 'presentation', patch.presentation as PlanPatchComponent<unknown>, {});
  if (patch.reference) applyPatchComponent(candidate, 'reference', patch.reference as PlanPatchComponent<unknown>, null);
  if (!patch.reference && (patch.filters || patch.temporal_scope || patch.presentation) && Object.prototype.hasOwnProperty.call(candidate, 'reference')) {
    candidate.reference = null;
  }
  return validateFinancePlan(candidate, turn);
}

function validateBase(value: Record<string, unknown>, turn: FinanceTurn): {
  schema_version: 2;
  plan_id: string;
  plan_version: number;
  base_session_version: number;
  source_turn_id: string;
  ledger_scope_id: 'personal:primary';
  confidence: number;
  presentation: FinancePresentation;
} {
  if (value.schema_version !== 2) throw new ProtocolValidationError('invalid_plan_schema', 'unsupported plan schema');
  const planId = stringValue(value.plan_id, 'invalid_plan_id');
  const sourceTurnId = stringValue(value.source_turn_id, 'invalid_source_turn_id');
  if (sourceTurnId !== turn.turn_id) throw new ProtocolValidationError('stale_turn', 'plan source turn does not match current turn');
  if (value.ledger_scope_id !== 'personal:primary') throw new ProtocolValidationError('forbidden_scope', 'plan ledger scope is not authorized');
  const baseSessionVersion = integerValue(value.base_session_version, 'invalid_session_version');
  if (baseSessionVersion !== (turn.base_session_version ?? baseSessionVersion)) throw new ProtocolValidationError('stale_turn', 'plan session version does not match turn');
  return {
    schema_version: 2,
    plan_id: planId,
    plan_version: integerValue(value.plan_version, 'invalid_plan_version', 1),
    base_session_version: baseSessionVersion,
    source_turn_id: sourceTurnId,
    ledger_scope_id: 'personal:primary',
    confidence: numberValue(value.confidence, 'invalid_confidence'),
    presentation: validatePresentation(value.presentation)
  };
}

function validateDateTime(value: unknown, code: string): string {
  const text = stringValue(value, code);
  if (!Number.isFinite(Date.parse(text))) throw new ProtocolValidationError(code, 'invalid date-time');
  return text;
}

function validateTemporalScope(value: unknown): TemporalScope {
  const scope = objectValue(value, 'invalid_temporal_scope');
  if (scope.timezone !== 'Asia/Shanghai' || scope.end_exclusive !== true) throw new ProtocolValidationError('invalid_temporal_scope', 'temporal scope must use Asia/Shanghai end-exclusive bounds');
  const from = validateDateTime(scope.from, 'invalid_temporal_scope');
  const to = validateDateTime(scope.to, 'invalid_temporal_scope');
  if (Date.parse(from) >= Date.parse(to)) throw new ProtocolValidationError('invalid_temporal_scope', 'temporal scope must have from < to');
  return {
    from,
    to,
    timezone: 'Asia/Shanghai',
    end_exclusive: true,
    source_phrase: scope.source_phrase === undefined || scope.source_phrase === null ? null : String(scope.source_phrase).slice(0, 256)
  };
}

function validateCreateItems(value: unknown): CreateItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) throw new ProtocolValidationError('invalid_item_count', 'item count exceeds 200');
  return value.map((raw) => {
    const item = objectValue(raw, 'invalid_item');
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) throw new ProtocolValidationError('invalid_item', 'invalid item quantity');
    const unitPrice = item.unit_price_fen === undefined || item.unit_price_fen === null
      ? null
      : integerValue(item.unit_price_fen, 'invalid_item_amount', 0);
    return {
      client_item_key: stringValue(item.client_item_key, 'invalid_item'),
      name: stringValue(item.name, 'invalid_item').slice(0, 160),
      quantity,
      unit_price_fen: unitPrice,
      line_total_fen: integerValue(item.line_total_fen, 'invalid_item_amount', 0),
      category: stringValue(item.category, 'invalid_item').slice(0, 64),
      confidence: numberValue(item.confidence, 'invalid_item_confidence')
    };
  });
}

export function validateFinancePlan(value: unknown, turn: FinanceTurn): FinancePlan {
  const source = objectValue(value, 'invalid_plan');
  const base = validateBase(source, turn);
  const operation = stringValue(source.operation, 'invalid_operation');
  if (!OPERATIONS.has(operation)) throw new ProtocolValidationError('invalid_operation', 'unsupported finance operation');
  const commonKeys = ['schema_version', 'plan_id', 'plan_version', 'base_session_version', 'source_turn_id', 'ledger_scope_id', 'confidence', 'presentation', 'operation'];
  const operationKeys: Record<string, string[]> = {
    create: ['entries'],
    receipt_create: ['entries', 'receipt_job_id', 'receipt_artifact_id', 'receipt_merchant', 'receipt_total_fen', 'receipt_item_count'],
    query: ['filters', 'temporal_scope', 'reference'],
    summarize: ['filters', 'temporal_scope', 'reference'],
    analyze: ['filters', 'temporal_scope', 'metric', 'dimension', 'reference'],
    compare: ['left_scope', 'right_scope', 'filters', 'metric', 'dimension', 'reference'],
    update: ['filters', 'selection', 'changes'],
    delete: ['filters', 'selection'],
    restore: ['reference']
  };
  rejectUnknownKeys(source, [...commonKeys, ...(operationKeys[operation] || [])], 'invalid_plan');

  if (operation === 'create' || operation === 'receipt_create') {
    if (operation === 'receipt_create' && turn.channel !== 'receipt') {
      throw new ProtocolValidationError('invalid_receipt_plan', 'receipt_create is reserved for receipt turns');
    }
    if (!Array.isArray(source.entries) || source.entries.length < 1 || source.entries.length > 100) throw new ProtocolValidationError('invalid_create_entries', 'create requires 1..100 entries');
    const entries = source.entries.map((raw) => {
      const entry = objectValue(raw, 'invalid_create_entry');
      const type = stringValue(entry.type, 'invalid_transaction_type');
      if (!TRANSACTION_TYPES.has(type)) throw new ProtocolValidationError('invalid_transaction_type', 'unsupported transaction type');
      const money = objectValue(entry.money, 'invalid_money');
      const amount = integerValue(money.amount_fen, 'invalid_money', 1);
      if (money.currency !== 'CNY') throw new ProtocolValidationError('invalid_currency', 'only CNY is supported');
      return {
        client_entry_key: stringValue(entry.client_entry_key, 'invalid_create_entry'),
        type: type as 'expense' | 'income' | 'transfer',
        money: { amount_fen: amount, currency: 'CNY' as const },
        occurred_at: validateDateTime(entry.occurred_at, 'invalid_occurred_at'),
        account: entry.account === undefined || entry.account === null ? null : validateCatalogReference(entry.account, 'account', 'invalid_account'),
        category: entry.category === undefined || entry.category === null ? null : validateCatalogReference(entry.category, 'category', 'invalid_category'),
        merchant: entry.merchant === undefined || entry.merchant === null ? null : String(entry.merchant).slice(0, 256),
        description: entry.description === undefined || entry.description === null ? null : String(entry.description).slice(0, 512),
        items: validateCreateItems(entry.items)
      };
    });
    if (operation === 'receipt_create') {
      const receiptItemCount = source.receipt_item_count === undefined ? undefined : integerValue(source.receipt_item_count, 'invalid_item_count', 1);
      if (receiptItemCount !== undefined && receiptItemCount > 200) throw new ProtocolValidationError('invalid_item_count', 'receipt item count exceeds 200');
      const receiptPlan: Record<string, unknown> = {
        ...base,
        operation: 'receipt_create',
        receipt_job_id: stringValue(source.receipt_job_id, 'invalid_receipt_job_id'),
        receipt_artifact_id: stringValue(source.receipt_artifact_id, 'invalid_receipt_artifact_id'),
        receipt_merchant: source.receipt_merchant === undefined || source.receipt_merchant === null ? null : String(source.receipt_merchant).slice(0, 160),
        entries
      };
      if (source.receipt_total_fen !== undefined) receiptPlan.receipt_total_fen = integerValue(source.receipt_total_fen, 'invalid_money', 1);
      if (receiptItemCount !== undefined) receiptPlan.receipt_item_count = receiptItemCount;
      return {
        ...receiptPlan
      } as unknown as FinancePlan;
    }
    return { ...base, operation: 'create', entries } as FinancePlan;
  }

  if (operation === 'query' || operation === 'summarize') {
    return {
      ...base,
      operation,
      filters: validateFilters(source.filters || {}),
      temporal_scope: source.temporal_scope === undefined || source.temporal_scope === null ? null : validateTemporalScope(source.temporal_scope),
      reference: source.reference === undefined || source.reference === null ? null : validateReference(source.reference)
    } as FinancePlan;
  }

  if (operation === 'analyze') {
    const metric = stringValue(source.metric, 'invalid_analysis_metric');
    const dimension = stringValue(source.dimension, 'invalid_analysis_dimension');
    if (!['expense', 'income', 'net', 'count', 'category_share', 'account_share', 'trend'].includes(metric)) throw new ProtocolValidationError('invalid_analysis_metric', 'unsupported analysis metric');
    if (!['none', 'date', 'category', 'account', 'merchant'].includes(dimension)) throw new ProtocolValidationError('invalid_analysis_dimension', 'unsupported analysis dimension');
    return { ...base, operation: 'analyze', filters: validateFilters(source.filters || {}), temporal_scope: source.temporal_scope ? validateTemporalScope(source.temporal_scope) : null, metric: metric as never, dimension: dimension as never, reference: source.reference ? validateReference(source.reference) : null } as FinancePlan;
  }

  if (operation === 'compare') {
    const metric = stringValue(source.metric, 'invalid_comparison_metric');
    const dimension = stringValue(source.dimension, 'invalid_comparison_dimension');
    if (!['expense', 'income', 'net', 'count', 'category_share', 'account_share'].includes(metric)) throw new ProtocolValidationError('invalid_comparison_metric', 'unsupported comparison metric');
    if (!['none', 'date', 'category', 'account', 'merchant'].includes(dimension)) throw new ProtocolValidationError('invalid_comparison_dimension', 'unsupported comparison dimension');
    return {
      ...base,
      operation: 'compare',
      left_scope: validateTemporalScope(source.left_scope),
      right_scope: validateTemporalScope(source.right_scope),
      filters: validateFilters(source.filters || {}),
      metric: metric as never,
      dimension: dimension as never,
      reference: source.reference ? validateReference(source.reference) : null
    } as FinancePlan;
  }

  if (operation === 'update' || operation === 'delete') {
    return {
      ...base,
      operation,
      filters: validateFilters(source.filters || {}),
      selection: validateSelection(source.selection),
      ...(operation === 'update' ? { changes: validateChanges(source.changes) } : {})
    } as FinancePlan;
  }

  return { ...base, operation: 'restore', reference: validateReference(source.reference) } as FinancePlan;
}

function parseAiResponse(result: unknown): unknown {
  const response = (result as { response?: unknown } | null)?.response;
  if (typeof response === 'string') {
    try {
      return JSON.parse(response);
    } catch {
      throw new ProtocolValidationError('interpretation_failed', 'orchestrator returned invalid JSON');
    }
  }
  return response;
}

function assertReceiptPlanFidelity(plan: FinancePlan, baselinePlan: unknown, turn: FinanceTurn): void {
  if (plan.operation !== 'receipt_create') throw new ProtocolValidationError('invalid_receipt_plan', 'receipt caption changed the required operation');
  const baseline = validateFinancePlan(baselinePlan, turn);
  if (baseline.operation !== 'receipt_create') throw new ProtocolValidationError('invalid_receipt_plan', 'receipt baseline is not a receipt plan');
  if (plan.receipt_job_id !== baseline.receipt_job_id || plan.receipt_artifact_id !== baseline.receipt_artifact_id) {
    throw new ProtocolValidationError('invalid_receipt_plan', 'receipt identity cannot be changed by caption interpretation');
  }
  if (plan.receipt_total_fen !== baseline.receipt_total_fen || plan.receipt_item_count !== baseline.receipt_item_count) {
    throw new ProtocolValidationError('invalid_receipt_plan', 'receipt totals cannot be changed by caption interpretation');
  }
  if (plan.entries.length !== baseline.entries.length) throw new ProtocolValidationError('invalid_receipt_plan', 'receipt entry cardinality cannot be changed');
  for (let index = 0; index < baseline.entries.length; index += 1) {
    const expected = baseline.entries[index];
    const actual = plan.entries[index];
    if (actual.type !== expected.type || actual.money.amount_fen !== expected.money.amount_fen || actual.money.currency !== expected.money.currency || actual.occurred_at !== expected.occurred_at) {
      throw new ProtocolValidationError('invalid_receipt_plan', 'receipt financial facts cannot be changed by caption interpretation');
    }
    if ((actual.items || []).length !== (expected.items || []).length) throw new ProtocolValidationError('invalid_receipt_plan', 'receipt item cardinality cannot be changed');
    for (let itemIndex = 0; itemIndex < (expected.items || []).length; itemIndex += 1) {
      const expectedItem = expected.items?.[itemIndex];
      const actualItem = actual.items?.[itemIndex];
      if (!expectedItem || !actualItem || actualItem.client_item_key !== expectedItem.client_item_key || actualItem.name !== expectedItem.name || actualItem.quantity !== expectedItem.quantity || actualItem.unit_price_fen !== expectedItem.unit_price_fen || actualItem.line_total_fen !== expectedItem.line_total_fen) {
        throw new ProtocolValidationError('invalid_receipt_plan', 'receipt item facts cannot be changed by caption interpretation');
      }
    }
  }
}

export async function interpretFinanceTurn(
  env: Env,
  turn: FinanceTurn,
  context: OrchestratorContext
): Promise<FinancePlan> {
  const mockPlan = (env as unknown as { __mockFinancePlan?: unknown }).__mockFinancePlan;
  if (mockPlan !== undefined) {
    const mockEnvelope = mockPlan && typeof mockPlan === 'object' ? mockPlan as Record<string, unknown> : null;
    const plan = mockEnvelope?.kind === 'patch_plan'
      ? context.activePlan
        ? applyFinancePlanPatch(context.activePlan, mockEnvelope.patch, turn)
        : (() => { throw new ProtocolValidationError('ordering_conflict', 'patch plan requires an active plan'); })()
      : mockEnvelope?.kind === 'new_plan'
        ? validateFinancePlan(mockEnvelope.plan, turn)
        : validateFinancePlan(mockPlan, turn);
    if (context.requiredOperation && plan.operation !== context.requiredOperation) throw new ProtocolValidationError('invalid_receipt_plan', 'mock plan changed the required receipt operation');
    if (context.requiredOperation === 'receipt_create' && context.baselinePlan) assertReceiptPlanFidelity(plan, context.baselinePlan, turn);
    return plan;
  }
  if (!turn.text?.trim()) throw new ProtocolValidationError('interpretation_failed', 'natural-language turn has no text');
  const catalog = await loadFinanceReferenceCatalog(env);
  const result = await env.AI.run(env.AI_MODEL, {
    messages: [
      {
        role: 'system',
        content: [
          '你是万象 Finance Dialogue Orchestrator，也是本次自然语言财务请求唯一的语义解释器。',
          '只输出符合 JSON Schema 的 FinancePlan 或 OrchestratorOutput，不执行数据库操作，不声称任何事实，不猜测缺失金额或目标。',
          '支持 create/query/summarize/analyze/compare/update/delete/restore；有歧义时不要替用户选择不存在的目标，返回可被上层识别的低置信度计划。',
          '所有金额使用整数分、货币只能 CNY；时间使用 Asia/Shanghai 的 ISO date-time；账户和分类只能从当前目录中选择。',
          `当前 session_version=${context.sessionVersion}，当前 turn_id=${turn.turn_id}。`,
          financeReferencePrompt(catalog),
          context.activePlan ? `上一个结构化计划：${JSON.stringify(context.activePlan)}` : '没有可继承的上一计划。',
          context.requiredOperation ? `本次操作类型必须保持为：${context.requiredOperation}。` : '',
          context.baselinePlan ? `机器已生成的基准计划（若用户没有提出修改，逐字段保留）：${JSON.stringify(context.baselinePlan)}` : '',
          context.receiptArtifact ? `已通过安全校验的回执 artifact（不要重新识别图片，也不要凭空改写金额/商品）：${JSON.stringify(context.receiptArtifact)}` : '',
          context.recentTurnSummaries?.length ? `最近摘要：${context.recentTurnSummaries.join(' | ')}` : ''
        ].filter(Boolean).join('\n')
      },
      { role: 'user', content: turn.text }
    ],
    response_format: { type: 'json_schema', json_schema: planResponseSchema() }
  });
  const parsed = parseAiResponse(result) as Record<string, unknown> | null;
  let plan: FinancePlan;
  if (parsed && parsed.kind === 'new_plan') {
    plan = validateFinancePlan(parsed.plan, turn);
  } else if (parsed && parsed.kind === 'patch_plan') {
    if (!context.activePlan) throw new ProtocolValidationError('ordering_conflict', 'patch plan requires an active plan');
    plan = applyFinancePlanPatch(context.activePlan, parsed.patch, turn);
  } else if (parsed && parsed.kind === 'clarification') {
    const clarification = objectValue(parsed.clarification, 'clarification_required');
    throw new ProtocolValidationError('clarification_required', stringValue(clarification.message, 'clarification_required'));
  } else if (parsed && parsed.kind === 'non_finance') {
    throw new ProtocolValidationError('non_finance', 'not a finance request');
  } else {
    plan = validateFinancePlan(parsed, turn);
  }
  if (context.requiredOperation && plan.operation !== context.requiredOperation) {
    throw new ProtocolValidationError('invalid_receipt_plan', 'orchestrator changed the required receipt operation');
  }
  if (context.requiredOperation === 'receipt_create' && context.baselinePlan) assertReceiptPlanFidelity(plan, context.baselinePlan, turn);
  return plan;
}
