import type { D1Like, D1StatementLike } from '../types';
import {
  assertFinanceSuccessCommitStatus,
  assertRouteWitness,
  assertRuntimeControl,
  canonicalizeJson,
  validateResultSetSnapshot,
  type FinanceOperationRecord,
  type FinanceOperationStatus,
  type FinanceResult,
  type FinanceTurn,
  type FinancePlan,
  type ResultSetSnapshot,
  type RenderPayload,
  type RuntimeControl
} from './protocol';

interface D1RunMeta {
  changes?: number;
}

interface D1RunResult {
  meta?: D1RunMeta;
}

export interface FinanceSessionRow {
  ledger_scope_id: string;
  session_key: string;
  session_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_result_set_id: string | null;
  active_window_start_ordinal: number | null;
  active_window_end_ordinal: number | null;
  previous_window_start_ordinal: number | null;
  previous_window_end_ordinal: number | null;
  last_turn_id: string | null;
  compatibility_interrupted: number;
  updated_at: string;
  expires_at: string | null;
}

export interface ReserveTurnResult {
  created: boolean;
  turn_id: string;
  existing_turn_id?: string;
}

export interface ReserveOperationResult {
  created: boolean;
  operation: FinanceOperationRecord;
  replay: boolean;
  in_progress: boolean;
}

export interface CommitFinanceOperationInput {
  operation: FinanceOperationRecord;
  result: FinanceResult;
  render_payload: RenderPayload;
  render_hash: string;
  result_json_bytes: number;
  result_set_id?: string | null;
  side_effect_statements: D1StatementLike[];
  outbox_rows: Array<{
    outbox_id: string;
    delivery_request_id: string;
    part_index: number;
    destination_id: string;
    thread_id?: string | null;
  }>;
  terminal_status: Extract<FinanceOperationStatus, 'committed' | 'rejected' | 'failed_terminal'>;
  error_code?: string | null;
}

function changes(result: unknown): number {
  return Number((result as D1RunResult | undefined)?.meta?.changes || 0);
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new Error(`INVALID_D1_${key}`);
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function numberValue(row: Record<string, unknown>, key: string, fallback = 0): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

function operationFromRow(row: Record<string, unknown>): FinanceOperationRecord {
  return {
    schema_version: 2,
    operation_id: requiredString(row, 'operation_id'),
    ledger_scope_id: requiredString(row, 'ledger_scope_id') as 'personal:primary',
    idempotency_key: requiredString(row, 'idempotency_key'),
    payload_hash: requiredString(row, 'payload_hash'),
    turn_id: requiredString(row, 'turn_id'),
    session_key: requiredString(row, 'session_key'),
    operation_type: requiredString(row, 'operation_type') as FinanceOperationRecord['operation_type'],
    status: requiredString(row, 'status') as FinanceOperationStatus,
    plan_id: optionalString(row, 'plan_id'),
    plan_version: row.plan_version === null || row.plan_version === undefined ? null : numberValue(row, 'plan_version'),
    lease_owner: optionalString(row, 'lease_owner'),
    lease_epoch: numberValue(row, 'lease_epoch'),
    lease_expires_at: optionalString(row, 'lease_expires_at'),
    attempt_count: numberValue(row, 'attempt_count'),
    route_epoch: numberValue(row, 'route_epoch'),
    result_id: optionalString(row, 'result_id'),
    error_code: optionalString(row, 'error_code')
  };
}

function sessionFromRow(row: Record<string, unknown>): FinanceSessionRow {
  return {
    ledger_scope_id: requiredString(row, 'ledger_scope_id'),
    session_key: requiredString(row, 'session_key'),
    session_version: numberValue(row, 'session_version'),
    active_plan_id: optionalString(row, 'active_plan_id'),
    active_plan_version: row.active_plan_version === null ? null : numberValue(row, 'active_plan_version'),
    active_result_set_id: optionalString(row, 'active_result_set_id'),
    active_window_start_ordinal: row.active_window_start_ordinal === null ? null : numberValue(row, 'active_window_start_ordinal'),
    active_window_end_ordinal: row.active_window_end_ordinal === null ? null : numberValue(row, 'active_window_end_ordinal'),
    previous_window_start_ordinal: row.previous_window_start_ordinal === null ? null : numberValue(row, 'previous_window_start_ordinal'),
    previous_window_end_ordinal: row.previous_window_end_ordinal === null ? null : numberValue(row, 'previous_window_end_ordinal'),
    last_turn_id: optionalString(row, 'last_turn_id'),
    compatibility_interrupted: numberValue(row, 'compatibility_interrupted'),
    updated_at: requiredString(row, 'updated_at'),
    expires_at: optionalString(row, 'expires_at')
  };
}

function runtimeControlFromRow(row: Record<string, unknown>): RuntimeControl {
  const control: RuntimeControl = {
    schema_version: 2,
    control_id: requiredString(row, 'control_id') as 'primary',
    config_epoch: numberValue(row, 'config_epoch'),
    finance_route_mode: requiredString(row, 'finance_route_mode') as RuntimeControl['finance_route_mode'],
    receipt_route_mode: requiredString(row, 'receipt_route_mode') as RuntimeControl['receipt_route_mode'],
    outbox_mode: requiredString(row, 'outbox_mode') as RuntimeControl['outbox_mode'],
    shadow_mode: requiredString(row, 'shadow_mode') as RuntimeControl['shadow_mode'],
    analysis_prose_enabled: numberValue(row, 'analysis_prose_enabled') as 0 | 1,
    updated_at: requiredString(row, 'updated_at')
  };
  assertRuntimeControl(control);
  return control;
}

export async function readRuntimeControl(db: D1Like): Promise<RuntimeControl> {
  const row = await db.prepare(
    `SELECT control_id, config_epoch, finance_route_mode, receipt_route_mode,
            outbox_mode, shadow_mode, analysis_prose_enabled, updated_at
       FROM finance_runtime_control
      WHERE control_id = 'primary'`
  ).first<Record<string, unknown>>();
  if (!row) throw new Error('RUNTIME_CONTROL_NOT_FOUND');
  return runtimeControlFromRow(row);
}

export async function loadSession(db: D1Like, ledgerScopeId: string, sessionKey: string): Promise<FinanceSessionRow | null> {
  const row = await db.prepare(
    `SELECT * FROM finance_sessions WHERE ledger_scope_id = ? AND session_key = ?`
  ).bind(ledgerScopeId, sessionKey).first<Record<string, unknown>>();
  return row ? sessionFromRow(row) : null;
}

export async function ensureSession(db: D1Like, ledgerScopeId: string, sessionKey: string): Promise<FinanceSessionRow> {
  await db.prepare(
    `INSERT OR IGNORE INTO finance_sessions (ledger_scope_id, session_key)
     VALUES (?, ?)`
  ).bind(ledgerScopeId, sessionKey).run();
  const session = await loadSession(db, ledgerScopeId, sessionKey);
  if (!session) throw new Error('FINANCE_SESSION_CREATE_FAILED');
  return session;
}

export async function reserveTurn(db: D1Like, turn: FinanceTurn): Promise<ReserveTurnResult> {
  const orderingEpoch = turn.ordering.kind === 'telegram' ? turn.ordering.epoch : null;
  const orderingKey = turn.ordering.kind === 'telegram' ? turn.ordering.update_id : null;
  const existing = await db.prepare(
    `SELECT turn_id, payload_hash
       FROM finance_turns
      WHERE ledger_scope_id = ? AND channel = ? AND channel_event_id = ?`
  ).bind(turn.actor.ledger_scope_id, turn.channel, turn.channel_event_id).first<{ turn_id: string; payload_hash: string }>();
  if (existing) {
    if (existing.payload_hash !== turn.payload_hash) throw new Error('IDEMPOTENCY_CONFLICT');
    return { created: false, turn_id: existing.turn_id, existing_turn_id: existing.turn_id === turn.turn_id ? undefined : existing.turn_id };
  }

  if (turn.ordering.kind === 'telegram' && orderingKey !== null) {
    const resetCutoff = new Date(Date.now() - 168 * 60 * 60 * 1000).toISOString();
    await db.prepare(
      `INSERT OR IGNORE INTO finance_channel_cursors (
         ledger_scope_id, channel, cursor_epoch, last_order_key, last_received_at
       ) VALUES (?, 'telegram', 0, NULL, NULL)`
    ).bind(turn.actor.ledger_scope_id).run();
    const cursor = await db.prepare(
      `SELECT cursor_epoch, last_order_key, last_received_at
         FROM finance_channel_cursors
        WHERE ledger_scope_id = ? AND channel = 'telegram'`
    ).bind(turn.actor.ledger_scope_id).first<{ cursor_epoch: number; last_order_key: number | null; last_received_at: string | null }>();
    if (!cursor) throw new Error('TELEGRAM_ORDERING_CURSOR_NOT_FOUND');
    const idleReset = cursor.last_order_key !== null
      && cursor.last_received_at !== null
      && Number.isFinite(Date.parse(cursor.last_received_at))
      && Date.parse(cursor.last_received_at) <= Date.parse(resetCutoff);
    const nextEpoch = idleReset ? cursor.cursor_epoch + 1 : cursor.cursor_epoch;
    const cursorCondition = `c.ledger_scope_id = ? AND c.channel = 'telegram'
      AND c.cursor_epoch = ?
      AND (
        c.last_order_key IS NULL
        OR ? > c.last_order_key
        OR (? = 1 AND c.last_order_key IS NOT NULL)
      )`;
    const turnInsert = db.prepare(
      `INSERT OR IGNORE INTO finance_turns (
         turn_id, ledger_scope_id, channel, channel_event_id, idempotency_key, payload_hash,
         subject_id, session_key, ordering_epoch, ordering_key, event_time, received_time,
         base_session_version, correlation_id
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM finance_channel_cursors c
         WHERE ${cursorCondition}`
    ).bind(
      turn.turn_id,
      turn.actor.ledger_scope_id,
      turn.channel,
      turn.channel_event_id,
      turn.idempotency_key,
      turn.payload_hash,
      turn.actor.subject_id,
      turn.session_key,
      nextEpoch,
      orderingKey,
      turn.event_time,
      turn.received_time,
      turn.base_session_version ?? null,
      turn.correlation_id,
      turn.actor.ledger_scope_id,
      cursor.cursor_epoch,
      orderingKey,
      idleReset ? 1 : 0
    );
    const cursorUpdate = db.prepare(
      `UPDATE finance_channel_cursors
          SET cursor_epoch = ?, last_order_key = ?, last_received_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE ${cursorCondition.replaceAll('c.', '')}`
    ).bind(
      nextEpoch,
      orderingKey,
      turn.received_time,
      turn.actor.ledger_scope_id,
      cursor.cursor_epoch,
      orderingKey,
      idleReset ? 1 : 0
    );
    const batch = await db.batch([turnInsert, cursorUpdate]);
    if (changes(batch[0]) === 1 && changes(batch[1]) === 1) {
      return { created: true, turn_id: turn.turn_id };
    }
    const raced = await db.prepare(
      `SELECT turn_id, payload_hash
         FROM finance_turns
        WHERE ledger_scope_id = ? AND channel = ? AND channel_event_id = ?`
    ).bind(turn.actor.ledger_scope_id, turn.channel, turn.channel_event_id).first<{ turn_id: string; payload_hash: string }>();
    if (raced) {
      if (raced.payload_hash !== turn.payload_hash) throw new Error('IDEMPOTENCY_CONFLICT');
      return { created: false, turn_id: raced.turn_id, existing_turn_id: raced.turn_id === turn.turn_id ? undefined : raced.turn_id };
    }
    throw new Error('STALE_TELEGRAM_ORDER');
  }

  const result = await db.prepare(
    `INSERT OR IGNORE INTO finance_turns (
       turn_id, ledger_scope_id, channel, channel_event_id, idempotency_key, payload_hash,
       subject_id, session_key, ordering_epoch, ordering_key, event_time, received_time,
       base_session_version, correlation_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    turn.turn_id,
    turn.actor.ledger_scope_id,
    turn.channel,
    turn.channel_event_id,
    turn.idempotency_key,
    turn.payload_hash,
    turn.actor.subject_id,
    turn.session_key,
    orderingEpoch,
    orderingKey,
    turn.event_time,
    turn.received_time,
    turn.base_session_version ?? null,
    turn.correlation_id
  ).run();
  const stored = await db.prepare(
    `SELECT turn_id, payload_hash FROM finance_turns
      WHERE ledger_scope_id = ? AND channel = ? AND channel_event_id = ?`
  ).bind(turn.actor.ledger_scope_id, turn.channel, turn.channel_event_id).first<{ turn_id: string; payload_hash: string }>();
  if (!stored) throw new Error('FINANCE_TURN_RESERVATION_FAILED');
  if (stored.payload_hash !== turn.payload_hash) throw new Error('IDEMPOTENCY_CONFLICT');
  return { created: changes(result) === 1, turn_id: stored.turn_id, existing_turn_id: stored.turn_id === turn.turn_id ? undefined : stored.turn_id };
}

export async function saveTurnInterpretation(
  db: D1Like,
  turnId: string,
  interpretationStatus: string,
  interpretationJson: string,
  planId?: string | null
): Promise<void> {
  await db.prepare(
    `UPDATE finance_turns
        SET interpretation_status = ?, interpretation_json = ?, plan_id = ?
      WHERE turn_id = ?`
  ).bind(interpretationStatus, interpretationJson, planId ?? null, turnId).run();
}

export async function completeTurn(
  db: D1Like,
  turnId: string,
  resultId: string | null,
  completedAt = new Date().toISOString()
): Promise<void> {
  await db.prepare(
    `UPDATE finance_turns SET result_id = ?, completed_at = ? WHERE turn_id = ?`
  ).bind(resultId, completedAt, turnId).run();
}

export async function loadTurnResult(db: D1Like, turnId: string): Promise<{ turn_id: string; result_id: string | null; completed_at: string | null } | null> {
  return db.prepare(
    `SELECT turn_id, result_id, completed_at FROM finance_turns WHERE turn_id = ?`
  ).bind(turnId).first<{ turn_id: string; result_id: string | null; completed_at: string | null }>();
}

export async function loadFinanceResult(db: D1Like, resultId: string): Promise<FinanceResult | null> {
  const row = await db.prepare(
    `SELECT result_json FROM finance_results WHERE result_id = ?`
  ).bind(resultId).first<{ result_json: string }>();
  if (!row?.result_json) return null;
  return JSON.parse(row.result_json) as FinanceResult;
}

export async function loadPlan(
  db: D1Like,
  planId: string | null,
  planVersion: number | null
): Promise<FinancePlan | null> {
  if (!planId || planVersion === null) return null;
  const row = await db.prepare(
    `SELECT plan_json FROM finance_plans
      WHERE plan_id = ? AND plan_version = ? AND ledger_scope_id = 'personal:primary'`
  ).bind(planId, planVersion).first<{ plan_json: string }>();
  if (!row?.plan_json) return null;
  return JSON.parse(row.plan_json) as FinancePlan;
}

export async function storePlan(
  db: D1Like,
  plan: { plan_id: string; plan_version: number; ledger_scope_id: string; session_key: string; source_turn_id: string; operation: string },
  planJson: string,
  planHash: string
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO finance_plans (
       plan_id, plan_version, ledger_scope_id, session_key, source_turn_id,
       operation_type, plan_json, plan_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    plan.plan_id,
    plan.plan_version,
    plan.ledger_scope_id,
    plan.session_key,
    plan.source_turn_id,
    plan.operation,
    planJson,
    planHash
  ).run();
}

export async function loadResultSetSnapshot(
  db: D1Like,
  resultSetId: string,
  ledgerScopeId: string,
  sessionKey: string
): Promise<ResultSetSnapshot | null> {
  const header = await db.prepare(
    `SELECT result_set_id, ledger_scope_id, plan_id, plan_version, session_key,
            result_set_version, row_count, page_size, sort_filter_fingerprint,
            snapshot_bytes, created_at, expires_at
       FROM finance_result_sets
      WHERE result_set_id = ? AND ledger_scope_id = ? AND session_key = ?`
  ).bind(resultSetId, ledgerScopeId, sessionKey).first<Record<string, unknown>>();
  if (!header) return null;
  if (Date.parse(String(header.expires_at)) <= Date.now()) throw new Error('EXPIRED_REFERENCE');
  const rows = await db.prepare(
    `SELECT ordinal, entity_type, entity_id, entity_fingerprint,
            row_snapshot_json, row_snapshot_bytes
       FROM finance_result_set_items
      WHERE result_set_id = ? ORDER BY ordinal`
  ).bind(resultSetId).all<ResultSetSnapshot['items'][number]>();
  const snapshot: ResultSetSnapshot = {
    schema_version: 2,
    result_set_id: String(header.result_set_id),
    ledger_scope_id: String(header.ledger_scope_id) as 'personal:primary',
    session_key: String(header.session_key),
    result_set_version: Number(header.result_set_version),
    row_count: Number(header.row_count),
    page_size: Number(header.page_size),
    sort_filter_fingerprint: String(header.sort_filter_fingerprint),
    snapshot_bytes: Number(header.snapshot_bytes),
    items: rows.results || [],
    created_at: String(header.created_at),
    expires_at: String(header.expires_at)
  };
  validateResultSetSnapshot(snapshot);
  return snapshot;
}

export async function storeResultSet(
  db: D1Like,
  snapshot: ResultSetSnapshot,
  planId = 'unknown',
  planVersion = 1
): Promise<void> {
  await db.batch(buildResultSetStatements(db, snapshot, planId, planVersion));
}

export function buildResultSetStatements(
  db: D1Like,
  snapshot: ResultSetSnapshot,
  planId = 'unknown',
  planVersion = 1,
  routeEpoch?: number
): D1StatementLike[] {
  const statements: D1StatementLike[] = [
    db.prepare(
      `INSERT INTO finance_result_sets (
         result_set_id, ledger_scope_id, plan_id, plan_version, session_key,
         result_set_version, row_count, page_size, sort_filter_fingerprint,
         snapshot_bytes, created_at, expires_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM finance_runtime_control c
        WHERE c.control_id = 'primary' AND (? IS NULL OR c.config_epoch = ?)`
    ).bind(
      snapshot.result_set_id,
      snapshot.ledger_scope_id,
      planId,
      planVersion,
      snapshot.session_key,
      snapshot.result_set_version,
      snapshot.row_count,
      snapshot.page_size,
      snapshot.sort_filter_fingerprint,
      snapshot.snapshot_bytes,
      snapshot.created_at,
      snapshot.expires_at,
      routeEpoch ?? null,
      routeEpoch ?? null
    )
  ];
  for (const item of snapshot.items) {
    statements.push(db.prepare(
      `INSERT INTO finance_result_set_items (
         result_set_id, ordinal, entity_type, entity_id, entity_fingerprint,
         row_snapshot_json, row_snapshot_bytes
       )
       SELECT ?, ?, ?, ?, ?, ?, ?
         FROM finance_runtime_control c
        WHERE c.control_id = 'primary' AND (? IS NULL OR c.config_epoch = ?)`
    ).bind(
      snapshot.result_set_id,
      item.ordinal,
      item.entity_type,
      item.entity_id,
      item.entity_fingerprint,
      item.row_snapshot_json,
      item.row_snapshot_bytes,
      routeEpoch ?? null,
      routeEpoch ?? null
    ));
  }
  return statements;
}

export async function updateSessionProjection(
  db: D1Like,
  input: {
    ledger_scope_id: string;
    session_key: string;
    expected_session_version: number;
    active_plan_id?: string | null;
    active_plan_version?: number | null;
    active_result_set_id?: string | null;
    active_window_start_ordinal?: number | null;
    active_window_end_ordinal?: number | null;
    previous_window_start_ordinal?: number | null;
    previous_window_end_ordinal?: number | null;
    last_turn_id?: string | null;
  }
): Promise<FinanceSessionRow> {
  const result = await db.prepare(
    `UPDATE finance_sessions
        SET session_version = session_version + 1,
            active_plan_id = COALESCE(?, active_plan_id),
            active_plan_version = COALESCE(?, active_plan_version),
            active_result_set_id = COALESCE(?, active_result_set_id),
            active_window_start_ordinal = COALESCE(?, active_window_start_ordinal),
            active_window_end_ordinal = COALESCE(?, active_window_end_ordinal),
            previous_window_start_ordinal = COALESCE(?, previous_window_start_ordinal),
            previous_window_end_ordinal = COALESCE(?, previous_window_end_ordinal),
            last_turn_id = COALESCE(?, last_turn_id),
            updated_at = CURRENT_TIMESTAMP
      WHERE ledger_scope_id = ? AND session_key = ? AND session_version = ?`
  ).bind(
    input.active_plan_id ?? null,
    input.active_plan_version ?? null,
    input.active_result_set_id ?? null,
    input.active_window_start_ordinal ?? null,
    input.active_window_end_ordinal ?? null,
    input.previous_window_start_ordinal ?? null,
    input.previous_window_end_ordinal ?? null,
    input.last_turn_id ?? null,
    input.ledger_scope_id,
    input.session_key,
    input.expected_session_version
  ).run();
  if (changes(result) !== 1) throw new Error('SESSION_CAS_CONFLICT');
  const session = await loadSession(db, input.ledger_scope_id, input.session_key);
  if (!session) throw new Error('FINANCE_SESSION_NOT_FOUND');
  return session;
}

function assertOperationRoute(operationType: FinanceOperationRecord['operation_type'], control: RuntimeControl, routeEpoch: number): void {
  assertRouteWitness({
    operation_type: operationType,
    route_epoch: routeEpoch,
    config_epoch: control.config_epoch,
    finance_route_mode: control.finance_route_mode,
    receipt_route_mode: control.receipt_route_mode
  });
}

export async function loadOperation(db: D1Like, operationId: string): Promise<FinanceOperationRecord | null> {
  const row = await db.prepare(
    `SELECT * FROM finance_operations WHERE operation_id = ?`
  ).bind(operationId).first<Record<string, unknown>>();
  return row ? operationFromRow(row) : null;
}

export async function reserveOperation(
  db: D1Like,
  input: {
    operation_id: string;
    ledger_scope_id: string;
    idempotency_key: string;
    payload_hash: string;
    turn_id: string;
    session_key: string;
    operation_type: FinanceOperationRecord['operation_type'];
    plan_id?: string | null;
    plan_version?: number | null;
  }
): Promise<ReserveOperationResult> {
  const existingRow = await db.prepare(
    `SELECT * FROM finance_operations WHERE ledger_scope_id = ? AND idempotency_key = ?`
  ).bind(input.ledger_scope_id, input.idempotency_key).first<Record<string, unknown>>();
  if (existingRow) {
    const existing = operationFromRow(existingRow);
    if (existing.payload_hash !== input.payload_hash) throw new Error('IDEMPOTENCY_CONFLICT');
    return {
      created: false,
      operation: existing,
      replay: existing.status === 'committed' || existing.status === 'rejected' || existing.status === 'failed_terminal',
      in_progress: existing.status === 'reserved' || existing.status === 'executing'
    };
  }

  const control = await readRuntimeControl(db);
  const routeEpoch = control.config_epoch;
  assertOperationRoute(input.operation_type, control, routeEpoch);
  const insertResult = await db.prepare(
    `INSERT OR IGNORE INTO finance_operations (
       operation_id, ledger_scope_id, idempotency_key, payload_hash, turn_id, session_key,
       operation_type, status, plan_id, plan_version, route_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`
  ).bind(
    input.operation_id,
    input.ledger_scope_id,
    input.idempotency_key,
    input.payload_hash,
    input.turn_id,
    input.session_key,
    input.operation_type,
    input.plan_id ?? null,
    input.plan_version ?? null,
    routeEpoch
  ).run();
  const stored = await db.prepare(
    `SELECT * FROM finance_operations WHERE ledger_scope_id = ? AND idempotency_key = ?`
  ).bind(input.ledger_scope_id, input.idempotency_key).first<Record<string, unknown>>();
  if (!stored) throw new Error('FINANCE_OPERATION_RESERVATION_FAILED');
  const operation = operationFromRow(stored);
  if (operation.payload_hash !== input.payload_hash) throw new Error('IDEMPOTENCY_CONFLICT');
  return { created: changes(insertResult) === 1, operation, replay: false, in_progress: false };
}

export async function claimOperation(
  db: D1Like,
  operation: FinanceOperationRecord,
  leaseOwner: string,
  leaseSeconds = 120,
  now = new Date()
): Promise<FinanceOperationRecord> {
  const control = await readRuntimeControl(db);
  assertOperationRoute(operation.operation_type, control, operation.route_epoch);
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const result = await db.prepare(
    `UPDATE finance_operations
        SET status = 'executing', lease_owner = ?, lease_epoch = lease_epoch + 1,
            lease_expires_at = ?, attempt_count = attempt_count + 1,
            updated_at = CURRENT_TIMESTAMP
      WHERE operation_id = ?
        AND route_epoch = ?
        AND (status = 'reserved' OR (status = 'executing' AND lease_expires_at < ?))
        AND EXISTS (
          SELECT 1 FROM finance_runtime_control c
           WHERE c.control_id = 'primary'
             AND c.config_epoch = finance_operations.route_epoch
             AND (
               (finance_operations.operation_type = 'receipt_create' AND c.receipt_route_mode = 'v2')
               OR
               (finance_operations.operation_type <> 'receipt_create' AND c.finance_route_mode IN ('canary_v2', 'primary_v2'))
             )
        )`
  ).bind(leaseOwner, expiresAt, operation.operation_id, operation.route_epoch, now.toISOString()).run();
  if (changes(result) !== 1) throw new Error('STALE_FENCE_OR_OPERATION_IN_PROGRESS');
  const claimed = await loadOperation(db, operation.operation_id);
  if (!claimed) throw new Error('FINANCE_OPERATION_CLAIM_FAILED');
  return claimed;
}

export async function failFinanceOperation(
  db: D1Like,
  operation: FinanceOperationRecord,
  errorCode: string,
  resultId?: string | null
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE finance_operations
        SET status = 'failed_terminal', result_id = COALESCE(?, result_id), error_code = ?, lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE operation_id = ? AND status = 'executing'
        AND lease_owner = ? AND lease_epoch = ?`
  ).bind(
    resultId ?? null,
    errorCode.slice(0, 128),
    operation.operation_id,
    operation.lease_owner,
    operation.lease_epoch
  ).run();
  return changes(result) === 1;
}

export async function commitFinanceOperation(db: D1Like, input: CommitFinanceOperationInput): Promise<void> {
  if (input.result.kind === 'success') assertFinanceSuccessCommitStatus(input.result);
  const resultJson = canonicalizeJson(input.result);
  const renderJson = canonicalizeJson(input.render_payload);
  const computedResultBytes = new TextEncoder().encode(resultJson).byteLength;
  if (computedResultBytes !== input.result_json_bytes || computedResultBytes > 131072) throw new Error('RESULT_SIZE_MISMATCH');
  if (input.result.render_hash !== input.render_hash) throw new Error('RENDER_HASH_MISMATCH');
  const outboxStatements = input.outbox_rows.map((row) => db.prepare(
    `INSERT OR IGNORE INTO finance_outbox (
       outbox_id, ledger_scope_id, result_id, delivery_request_id, part_index,
       render_hash, destination_type, destination_id, thread_id, status,
       lease_epoch, route_epoch
     )
     SELECT ?, ?, ?, ?, ?, ?, 'telegram_owner', ?, ?, 'pending', 0, c.config_epoch
       FROM finance_runtime_control c
     WHERE c.control_id = 'primary'
       AND c.config_epoch = ?
        AND c.outbox_mode IN ('enabled', 'draining')
        AND ((? = 'receipt_create' AND c.receipt_route_mode = 'v2')
             OR (? <> 'receipt_create' AND c.finance_route_mode IN ('canary_v2', 'primary_v2')))`
  ).bind(
    row.outbox_id,
    input.operation.ledger_scope_id,
    input.result.result_id,
    row.delivery_request_id,
    row.part_index,
    input.render_hash,
    row.destination_id,
    row.thread_id ?? null,
    input.operation.route_epoch,
    input.operation.operation_type,
    input.operation.operation_type
  ));
  const resultStatement = db.prepare(
    `INSERT OR IGNORE INTO finance_results (
       result_id, ledger_scope_id, turn_id, operation_id, schema_version,
       operation_type, result_json, render_payload_json, render_hash,
       result_set_id, result_json_bytes
     )
     SELECT ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?
       FROM finance_runtime_control c
      WHERE c.control_id = 'primary' AND c.config_epoch = ?
        AND ((? = 'receipt_create' AND c.receipt_route_mode = 'v2')
             OR (? <> 'receipt_create' AND c.finance_route_mode IN ('canary_v2', 'primary_v2')))`
  ).bind(
    input.result.result_id,
    input.operation.ledger_scope_id,
    input.operation.turn_id,
    input.operation.operation_id,
    input.operation.operation_type,
    resultJson,
    renderJson,
    input.render_hash,
    input.result_set_id ?? null,
    input.result_json_bytes,
    input.operation.route_epoch,
    input.operation.operation_type,
    input.operation.operation_type
  );
  const terminalStatement = db.prepare(
    `UPDATE finance_operations
        SET status = ?, result_id = ?, error_code = ?,
            committed_at = CASE WHEN ? = 'committed' THEN CURRENT_TIMESTAMP ELSE committed_at END,
            updated_at = CURRENT_TIMESTAMP
      WHERE operation_id = ? AND status = 'executing'
        AND lease_owner = ? AND lease_epoch = ? AND route_epoch = ?
        AND EXISTS (
          SELECT 1 FROM finance_runtime_control c
           WHERE c.control_id = 'primary'
             AND c.config_epoch = finance_operations.route_epoch
             AND (
               (finance_operations.operation_type = 'receipt_create' AND c.receipt_route_mode = 'v2')
               OR
               (finance_operations.operation_type <> 'receipt_create' AND c.finance_route_mode IN ('canary_v2', 'primary_v2'))
             )
        )`
  ).bind(
    input.terminal_status,
    input.result.result_id,
    input.error_code ?? null,
    input.terminal_status,
    input.operation.operation_id,
    input.operation.lease_owner,
    input.operation.lease_epoch,
    input.operation.route_epoch
  );
  const batchResults = await db.batch([
    ...input.side_effect_statements,
    resultStatement,
    ...outboxStatements,
    terminalStatement
  ]);
  const sideEffectChanges = batchResults
    .slice(0, input.side_effect_statements.length)
    .map(changes);
  if (sideEffectChanges.some((count) => count !== 1)) {
    throw new Error('STALE_FENCE_OR_SESSION_CAS');
  }
  const resultIndex = input.side_effect_statements.length;
  if (changes(batchResults[resultIndex]) !== 1) throw new Error('STALE_FENCE_OR_RESULT');
  const outboxStart = resultIndex + 1;
  const outboxChanges = batchResults
    .slice(outboxStart, outboxStart + outboxStatements.length)
    .map(changes);
  if (outboxChanges.some((count) => count !== 1)) throw new Error('STALE_FENCE_OR_OUTBOX_ROUTE');
  const terminalChanges = changes(batchResults[batchResults.length - 1]);
  if (terminalChanges !== 1) throw new Error('STALE_FENCE_OR_OPERATION_CLAIM');
}
