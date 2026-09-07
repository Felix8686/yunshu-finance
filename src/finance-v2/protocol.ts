export const FINANCE_SCHEMA_VERSION = 2 as const;
export const LEDGER_SCOPE_ID = 'personal:primary' as const;

export type FinanceChannel = 'telegram' | 'api' | 'receipt';
export type FinanceOperationType =
  | 'create'
  | 'query'
  | 'summarize'
  | 'analyze'
  | 'compare'
  | 'update'
  | 'delete'
  | 'restore'
  | 'receipt_create';
export type FinanceMutationOperation = 'create' | 'update' | 'delete' | 'restore' | 'receipt_create';
export type FinanceReadOperation = 'query' | 'summarize' | 'analyze' | 'compare';
export type TransactionType = 'expense' | 'income' | 'transfer';
export type RouteMode = 'primary_v1' | 'shadow_v2' | 'canary_v2' | 'draining_v2' | 'primary_v2';
export type ReceiptRouteMode = 'v1' | 'draining_v1' | 'v2' | 'draining_v2';
export type OutboxMode = 'paused' | 'enabled' | 'draining';

export interface FinanceActor {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  subject_id: 'telegram:owner' | 'api:owner' | 'system:receipt';
  auth_source: 'telegram_owner' | 'api_owner' | 'system_receipt';
  permissions: Array<'finance:read' | 'finance:write' | 'finance:receipt'>;
}

export type OrderingCursor =
  | { kind: 'telegram'; epoch: number; update_id: number }
  | { kind: 'api'; base_session_version: number; request_id: string }
  | { kind: 'receipt_completion'; source_turn_id: string; job_id: string };

export type AttachmentReference =
  | { kind: 'telegram_photo'; attachment_ref: string }
  | { kind: 'receipt_artifact'; receipt_artifact_id: string; job_id: string };

export interface FinanceTurn {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  turn_id: string;
  channel: FinanceChannel;
  channel_event_id: string;
  idempotency_key: string;
  payload_hash: string;
  actor: FinanceActor;
  session_key: string;
  ordering: OrderingCursor;
  event_time: string;
  received_time: string;
  timezone: 'Asia/Shanghai';
  text?: string | null;
  attachments: AttachmentReference[];
  correlation_id: string;
  causation_turn_id?: string | null;
  base_session_version?: number | null;
}

export interface Money {
  amount_fen: number;
  currency: 'CNY';
}

export interface TemporalScope {
  from: string;
  to: string;
  timezone: 'Asia/Shanghai';
  end_exclusive: true;
  source_phrase?: string | null;
}

export interface CatalogReference {
  kind: 'category' | 'account' | 'merchant';
  value: string;
}

export type ReferenceSpec =
  | { kind: 'result_ordinal'; result_set_id: string; ordinal: number }
  | {
      kind: 'result_window';
      result_set_id: string;
      window_start_ordinal: number;
      window_end_ordinal: number;
      result_set_version: number;
    }
  | { kind: 'operation'; operation_id: string }
  | { kind: 'receipt'; receipt_artifact_id: string }
  | { kind: 'transaction'; transaction_id: string }
  | { kind: 'transaction_item'; item_id: string }
  | {
      kind: 'session_semantic';
      semantic_key:
        | 'last_created'
        | 'last_updated'
        | 'last_deleted'
        | 'last_restored'
        | 'last_receipt'
        | 'active_result_set'
        | 'previous_result_set'
        | 'active_window'
        | 'previous_window';
    };

export interface FinancePresentation {
  mode?: 'details' | 'summary' | 'analysis' | 'comparison';
  fields?: Array<'date' | 'time' | 'item' | 'amount' | 'category' | 'account' | 'merchant' | 'type'>;
  sort_field?: 'occurred_at' | 'amount' | 'item' | 'category' | 'account';
  sort_direction?: 'asc' | 'desc';
  group_by?: 'none' | 'date' | 'category' | 'account' | 'merchant';
  page_size?: number;
  page_token?: string | null;
  compact?: boolean;
}

export interface FinanceFilters {
  types?: TransactionType[];
  categories?: CatalogReference[];
  accounts?: CatalogReference[];
  merchant_text?: string | null;
  semantic_text?: string | null;
  amount_min_fen?: number | null;
  amount_max_fen?: number | null;
}

export type FinanceSelection =
  | { mode: 'exactly_one' }
  | { mode: 'exact_count'; count: number }
  | { mode: 'all_matching' }
  | { mode: 'reference'; reference: ReferenceSpec };

export interface CreateItem {
  client_item_key: string;
  name: string;
  quantity: number;
  unit_price_fen?: number | null;
  line_total_fen: number;
  category: string;
  confidence: number;
}

export interface CreateEntry {
  client_entry_key: string;
  type: TransactionType;
  money: Money;
  occurred_at: string;
  account?: CatalogReference | null;
  category?: CatalogReference | null;
  merchant?: string | null;
  description?: string | null;
  items?: CreateItem[];
}

export interface ItemPatch {
  target: ReferenceSpec;
  name?: string | null;
  quantity?: number | null;
  unit_price_fen?: number | null;
  line_total_fen?: number | null;
  category?: string | null;
}

export interface FinanceChanges {
  amount_fen?: number | null;
  currency?: 'CNY';
  occurred_at?: string | null;
  account?: CatalogReference | null;
  category?: CatalogReference | null;
  merchant?: string | null;
  description?: string | null;
  item_patch?: ItemPatch | null;
}

export interface PlanBase {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  plan_id: string;
  plan_version: number;
  base_session_version: number;
  source_turn_id: string;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  confidence: number;
  presentation: FinancePresentation;
}

export interface CreatePlan extends PlanBase {
  operation: 'create';
  entries: CreateEntry[];
}

export interface QueryPlan extends PlanBase {
  operation: 'query';
  filters: FinanceFilters;
  temporal_scope?: TemporalScope | null;
}

export interface SummarizePlan extends PlanBase {
  operation: 'summarize';
  filters: FinanceFilters;
  temporal_scope?: TemporalScope | null;
}

export interface AnalyzePlan extends PlanBase {
  operation: 'analyze';
  filters: FinanceFilters;
  temporal_scope?: TemporalScope | null;
  metric: 'expense' | 'income' | 'net' | 'count' | 'category_share' | 'account_share' | 'trend';
  dimension: 'none' | 'date' | 'category' | 'account' | 'merchant';
}

export interface ComparePlan extends PlanBase {
  operation: 'compare';
  left_scope: TemporalScope;
  right_scope: TemporalScope;
  filters: FinanceFilters;
  metric: 'expense' | 'income' | 'net' | 'count' | 'category_share' | 'account_share';
  dimension: 'none' | 'date' | 'category' | 'account' | 'merchant';
}

export interface UpdatePlan extends PlanBase {
  operation: 'update';
  filters: FinanceFilters;
  selection: FinanceSelection;
  changes: FinanceChanges;
}

export interface DeletePlan extends PlanBase {
  operation: 'delete';
  filters: FinanceFilters;
  selection: FinanceSelection;
}

export interface RestorePlan extends PlanBase {
  operation: 'restore';
  reference: ReferenceSpec;
}

export type FinancePlan =
  | CreatePlan
  | QueryPlan
  | SummarizePlan
  | AnalyzePlan
  | ComparePlan
  | UpdatePlan
  | DeletePlan
  | RestorePlan;

export type PlanPatch = {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  base_plan_id: string;
  base_plan_version: number;
  base_session_version: number;
  operation?: 'replace' | 'clear' | 'inherit';
  value?: unknown;
};

export interface TransactionItemSnapshot {
  id: string;
  name: string;
  quantity: number;
  unit_price_fen: number | null;
  line_total_fen: number;
  category: string;
}

export interface TransactionSnapshot {
  id: string;
  type: TransactionType;
  amount_fen: number;
  currency: 'CNY';
  occurred_at: string;
  account_id: string | null;
  category_id: string | null;
  merchant: string | null;
  description: string | null;
  items: TransactionItemSnapshot[];
}

export interface FinanceResultRow {
  entity_type: 'transaction' | 'transaction_item' | 'receipt';
  entity_id: string;
  entity_fingerprint: string;
  snapshot: TransactionSnapshot | TransactionItemSnapshot | Record<string, unknown>;
}

export interface FinanceSummary {
  transaction_count: number;
  expense_fen: number;
  income_fen: number;
  transfer_fen: number;
  net_fen: number;
}

export interface FinanceError {
  code: string;
  safe_message: string;
}

export interface FinanceSuccessBase {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  kind: 'success';
  result_id: string;
  turn_id: string;
  operation: FinanceOperationType;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  render_hash: string;
  transaction_ids?: string[];
  item_ids?: string[];
  result_set_id?: string | null;
  rows?: FinanceResultRow[];
  summary?: FinanceSummary | null;
  analysis_data?: Record<string, unknown> | null;
  comparison_data?: Record<string, unknown> | null;
}

export type FinanceMutationSuccessResult = FinanceSuccessBase & {
  operation: FinanceMutationOperation;
  commit_status: 'committed';
};

export type FinanceReadSuccessResult = FinanceSuccessBase & {
  operation: FinanceReadOperation;
  commit_status: 'not_required';
};

export type FinanceSuccessResult = FinanceMutationSuccessResult | FinanceReadSuccessResult;

export interface FinanceClarificationResult {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  kind: 'clarification';
  result_id: string;
  turn_id: string;
  operation: FinanceOperationType;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  commit_status: 'not_required';
  clarification: { reason: string; message: string };
  render_hash: string;
}

export interface FinanceRejectedResult {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  kind: 'rejected';
  result_id: string;
  turn_id: string;
  operation: FinanceOperationType;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  commit_status: 'not_committed';
  error: FinanceError;
  render_hash: string;
}

export interface FinanceErrorResult {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  kind: 'error';
  result_id: string;
  turn_id: string;
  operation: FinanceOperationType;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  commit_status: 'not_committed';
  error: FinanceError;
  render_hash: string;
}

export type FinanceResult =
  | FinanceSuccessResult
  | FinanceClarificationResult
  | FinanceRejectedResult
  | FinanceErrorResult;

export interface TelegramRenderPart {
  part_index: number;
  text: string;
  part_hash: string;
}

export interface RenderPayload {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  telegram_parts: TelegramRenderPart[];
}

export interface ResultSetItemSnapshot {
  ordinal: number;
  entity_type: string;
  entity_id: string;
  entity_fingerprint: string;
  row_snapshot_json: string;
  row_snapshot_bytes: number;
}

export interface ResultSetSnapshot {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  result_set_id: string;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  session_key: string;
  result_set_version: number;
  row_count: number;
  page_size: number;
  sort_filter_fingerprint: string;
  snapshot_bytes: number;
  items: ResultSetItemSnapshot[];
  created_at: string;
  expires_at: string;
}

export type FinanceOperationStatus = 'reserved' | 'executing' | 'committed' | 'rejected' | 'failed_terminal';

export interface FinanceOperationRecord {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  operation_id: string;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  idempotency_key: string;
  payload_hash: string;
  turn_id: string;
  session_key: string;
  operation_type: FinanceOperationType;
  status: FinanceOperationStatus;
  plan_id?: string | null;
  plan_version?: number | null;
  lease_owner?: string | null;
  lease_epoch: number;
  lease_expires_at?: string | null;
  attempt_count: number;
  route_epoch: number;
  result_id?: string | null;
  error_code?: string | null;
}

export type FinanceOutboxStatus = 'pending' | 'sending' | 'accepted' | 'failed_retryable' | 'failed_terminal' | 'unknown';

export interface FinanceOutboxRecord {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  outbox_id: string;
  ledger_scope_id: typeof LEDGER_SCOPE_ID;
  result_id: string;
  delivery_request_id: string;
  part_index: number;
  render_hash: string;
  destination_type: 'telegram_owner';
  destination_id: string;
  thread_id?: string | null;
  status: FinanceOutboxStatus;
  lease_owner?: string | null;
  lease_epoch: number;
  lease_expires_at?: string | null;
  route_epoch: number;
  attempt_count: number;
  next_attempt_at?: string | null;
  telegram_message_id?: number | null;
}

export interface RuntimeControl {
  schema_version: typeof FINANCE_SCHEMA_VERSION;
  control_id: 'primary';
  config_epoch: number;
  finance_route_mode: RouteMode;
  receipt_route_mode: ReceiptRouteMode;
  outbox_mode: OutboxMode;
  shadow_mode: 'off' | 'interpretation_only';
  analysis_prose_enabled: 0 | 1;
  updated_at: string;
}

export interface RouteWitness {
  operation_type: FinanceOperationType | 'outbox';
  route_epoch: number;
  config_epoch: number;
  finance_route_mode: RouteMode;
  receipt_route_mode: ReceiptRouteMode;
  outbox_mode?: OutboxMode;
}

export class ProtocolValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.code = code;
  }
}

const MUTATION_OPERATIONS = new Set<FinanceMutationOperation>(['create', 'update', 'delete', 'restore', 'receipt_create']);
const READ_OPERATIONS = new Set<FinanceReadOperation>(['query', 'summarize', 'analyze', 'compare']);

export function assertFinanceSuccessCommitStatus(result: FinanceSuccessResult): void {
  if (result.kind !== 'success' || result.schema_version !== FINANCE_SCHEMA_VERSION) {
    throw new ProtocolValidationError('invalid_success_result', 'not a Finance V2 success result');
  }
  if (MUTATION_OPERATIONS.has(result.operation as FinanceMutationOperation)) {
    if (result.commit_status !== 'committed') {
      throw new ProtocolValidationError('invalid_commit_status', 'mutation success must be committed');
    }
    return;
  }
  if (READ_OPERATIONS.has(result.operation as FinanceReadOperation)) {
    if (result.commit_status !== 'not_required') {
      throw new ProtocolValidationError('invalid_commit_status', 'read success must be not_required');
    }
    return;
  }
  throw new ProtocolValidationError('invalid_operation', 'unknown Finance V2 operation');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolValidationError('non_finite_json', 'JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  throw new ProtocolValidationError('invalid_json_value', 'unsupported JSON value');
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

export function canonicalizeResultSetRow(value: unknown): { json: string; bytes: number } {
  const json = canonicalize(value);
  return { json, bytes: utf8ByteLength(json) };
}

export function validateResultSetSnapshot(snapshot: ResultSetSnapshot): void {
  if (snapshot.schema_version !== FINANCE_SCHEMA_VERSION) {
    throw new ProtocolValidationError('invalid_schema_version', 'unsupported result-set schema version');
  }
  if (!Number.isInteger(snapshot.row_count) || snapshot.row_count < 0 || snapshot.row_count > 200) {
    throw new ProtocolValidationError('invalid_row_count', 'row_count is outside the bounded result-set limit');
  }
  if (!Number.isInteger(snapshot.page_size) || snapshot.page_size < 1 || snapshot.page_size > 20) {
    throw new ProtocolValidationError('invalid_page_size', 'page_size is outside the bounded result-set limit');
  }
  if (snapshot.items.length !== snapshot.row_count) {
    throw new ProtocolValidationError('invalid_row_cardinality', 'row_count must equal items.length');
  }

  const canonicalItems = snapshot.items.map((item, index) => {
    if (item.ordinal !== index + 1) {
      throw new ProtocolValidationError('invalid_ordinals', 'result-set ordinals must be exactly 1..row_count');
    }
    if (!Number.isInteger(item.row_snapshot_bytes) || item.row_snapshot_bytes < 2 || item.row_snapshot_bytes > 8192) {
      throw new ProtocolValidationError('invalid_row_snapshot_bytes', 'row snapshot bytes are outside the bounded limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.row_snapshot_json);
    } catch {
      throw new ProtocolValidationError('invalid_row_snapshot_json', 'row snapshot is not valid JSON');
    }
    const computed = canonicalizeResultSetRow(parsed);
    if (computed.json !== item.row_snapshot_json || computed.bytes !== item.row_snapshot_bytes) {
      throw new ProtocolValidationError('row_snapshot_mismatch', 'row snapshot JSON/bytes do not match canonical UTF-8 values');
    }
    return {
      ordinal: item.ordinal,
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      entity_fingerprint: item.entity_fingerprint,
      row_snapshot_json: computed.json,
      row_snapshot_bytes: computed.bytes
    };
  });

  const snapshotJson = canonicalize(canonicalItems);
  const computedSnapshotBytes = utf8ByteLength(snapshotJson);
  if (!Number.isInteger(snapshot.snapshot_bytes) || snapshot.snapshot_bytes < 0 || snapshot.snapshot_bytes > 262144) {
    throw new ProtocolValidationError('invalid_snapshot_bytes', 'snapshot bytes are outside the bounded limit');
  }
  if (snapshot.snapshot_bytes !== computedSnapshotBytes) {
    throw new ProtocolValidationError('snapshot_mismatch', 'snapshot bytes do not match canonical ordered items');
  }
}

export function assertRouteWitness(witness: RouteWitness): void {
  if (!Number.isInteger(witness.route_epoch) || witness.route_epoch < 1) {
    throw new ProtocolValidationError('invalid_route_epoch', 'route epoch must be a positive integer');
  }
  if (witness.route_epoch !== witness.config_epoch) {
    throw new ProtocolValidationError('stale_fence', 'route epoch does not match current runtime config epoch');
  }
  if (witness.operation_type === 'outbox') {
    if (witness.outbox_mode !== 'enabled' && witness.outbox_mode !== 'draining') {
      throw new ProtocolValidationError('route_not_allowed', 'outbox route is not enabled');
    }
    return;
  }
  if (witness.operation_type === 'receipt_create') {
    if (witness.receipt_route_mode !== 'v2') {
      throw new ProtocolValidationError('route_not_allowed', 'receipt V2 route is not enabled');
    }
    return;
  }
  if (MUTATION_OPERATIONS.has(witness.operation_type as FinanceMutationOperation) &&
      witness.finance_route_mode !== 'canary_v2' && witness.finance_route_mode !== 'primary_v2') {
    throw new ProtocolValidationError('route_not_allowed', 'finance V2 mutation route is not enabled');
  }
}

export function assertRuntimeControl(control: RuntimeControl): void {
  if (control.schema_version !== FINANCE_SCHEMA_VERSION || control.control_id !== 'primary') {
    throw new ProtocolValidationError('invalid_runtime_control', 'invalid runtime control identity');
  }
  if (!Number.isInteger(control.config_epoch) || control.config_epoch < 1) {
    throw new ProtocolValidationError('invalid_config_epoch', 'config epoch must be a positive integer');
  }
  if (control.analysis_prose_enabled !== 0 && control.analysis_prose_enabled !== 1) {
    throw new ProtocolValidationError('invalid_runtime_control', 'analysis prose flag must be 0 or 1');
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type DeliveryRequestIdentity =
  | { result_id: string; destination_id: string; kind: 'initial'; initial_turn_id: string }
  | { result_id: string; destination_id: string; kind: 'replay'; replay_idempotency_key: string };

export async function deriveDeliveryRequestId(identity: DeliveryRequestIdentity): Promise<string> {
  const discriminator = identity.kind === 'initial' ? identity.initial_turn_id : identity.replay_idempotency_key;
  if (!discriminator) throw new ProtocolValidationError('invalid_delivery_identity', 'delivery identity discriminator is required');
  const material = [identity.kind, identity.result_id, identity.destination_id, discriminator].join('\n');
  return `delivery_${await sha256Hex(material)}`;
}
