import type { Env } from '../types';
import {
  canonicalizeJson,
  deriveDeliveryRequestId,
  ProtocolValidationError,
  type FinanceOperationType,
  type FinancePlan,
  type FinanceResult,
  type FinanceTurn,
  type RenderPayload
} from './protocol';
import {
  claimOperation,
  commitFinanceOperation,
  failFinanceOperation,
  ensureSession,
  loadFinanceResult,
  loadPlan,
  loadTurnResult,
  readRuntimeControl,
  reserveOperation,
  reserveTurn,
  saveTurnInterpretation,
  storePlan
} from './persistence';
import { prepareFinanceExecution } from './executor';
import { applyFinancePlanPatch, interpretFinanceTurn, validateFinancePlan } from './orchestrator';
import { renderFinanceResult } from './renderer';

export interface FinanceV2ServiceOptions {
  structuredPlan?: unknown;
  structuredPatch?: unknown;
  orchestratorContext?: {
    receiptArtifact?: unknown;
    baselinePlan?: unknown;
    requiredOperation?: FinanceOperationType;
  };
  telegramDestinationId?: string;
  telegramThreadId?: string | null;
  delivery?:
    | { kind: 'initial' }
    | { kind: 'replay'; replayIdempotencyKey: string };
}

export interface FinanceV2ServiceResponse {
  result: FinanceResult;
  render_payload?: RenderPayload;
  operation_id?: string;
  duplicate?: boolean;
  in_progress?: boolean;
}

function errorResult(turn: FinanceTurn, code: string, safeMessage: string, operation: FinanceOperationType = turn.channel === 'receipt' ? 'receipt_create' : 'query'): FinanceV2ServiceResponse {
  return {
    result: {
      schema_version: 2,
      kind: 'error',
      result_id: `error_${crypto.randomUUID()}`,
      turn_id: turn.turn_id,
      operation,
      ledger_scope_id: 'personal:primary',
      commit_status: 'not_committed',
      error: { code, safe_message: safeMessage },
      render_hash: '0'.repeat(64)
    }
  };
}

async function persistErrorResult(env: Env, turn: FinanceTurn, response: FinanceV2ServiceResponse): Promise<FinanceV2ServiceResponse> {
  const rendered = await renderFinanceResult(response.result, {});
  const result = { ...response.result, render_hash: rendered.render_hash } as FinanceResult;
  const resultJson = canonicalizeJson(result);
  const renderJson = canonicalizeJson(rendered.payload);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO finance_results (
         result_id, ledger_scope_id, turn_id, operation_id, schema_version,
         operation_type, result_json, render_payload_json, render_hash,
         result_set_id, result_json_bytes
       ) VALUES (?, ?, ?, NULL, 2, ?, ?, ?, ?, NULL, ?)`
    ).bind(
      result.result_id,
      turn.actor.ledger_scope_id,
      turn.turn_id,
      result.operation,
      resultJson,
      renderJson,
      rendered.render_hash,
      new TextEncoder().encode(resultJson).byteLength
    ),
    env.DB.prepare(
      `UPDATE finance_turns
          SET result_id = ?, completed_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND result_id IS NULL`
    ).bind(result.result_id, turn.turn_id)
  ]);
  return { ...response, result, render_payload: rendered.payload };
}

function operationFence(operation: { operation_id: string; operation_type: string; lease_owner?: string | null; lease_epoch: number; route_epoch: number }): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM finance_operations op
       JOIN finance_runtime_control ctl ON ctl.control_id = 'primary'
      WHERE op.operation_id = ? AND op.status = 'executing'
        AND op.lease_owner = ? AND op.lease_epoch = ? AND op.route_epoch = ?
        AND ctl.config_epoch = op.route_epoch
        AND ((op.operation_type = 'receipt_create' AND ctl.receipt_route_mode = 'v2')
             OR (op.operation_type <> 'receipt_create' AND ctl.finance_route_mode IN ('canary_v2', 'primary_v2')))
    )`,
    params: [operation.operation_id, operation.lease_owner, operation.lease_epoch, operation.route_epoch]
  };
}

function sessionReferenceKind(operation: FinanceOperationType): string {
  if (operation === 'create') return 'last_created';
  if (operation === 'update') return 'last_updated';
  if (operation === 'delete') return 'last_deleted';
  if (operation === 'restore') return 'last_restored';
  if (operation === 'receipt_create') return 'last_receipt';
  return 'active_result_set';
}

function classifyFailure(message: string): { code: string; safeMessage: string } {
  if (message === 'STALE_REFERENCE') return { code: 'stale_reference', safeMessage: '这条引用对应的账目已经发生变化，没有继续修改。请重新查询后再操作。' };
  if (message === 'EXPIRED_REFERENCE') return { code: 'expired_reference', safeMessage: '这条引用已经过期，请重新查询后再操作。' };
  if (message === 'NO_MATCH') return { code: 'no_match', safeMessage: '没有找到符合条件的账目，没有执行修改。' };
  if (message === 'CARDINALITY_MISMATCH') return { code: 'cardinality_mismatch', safeMessage: '匹配到的账目数量与请求不一致，没有执行修改。' };
  if (message === 'INVALID_ACCOUNT' || message === 'ACCOUNT_NOT_CONFIGURED') return { code: 'invalid_account', safeMessage: '账户无法确认，没有执行修改。' };
  if (message === 'INVALID_CATEGORY' || message === 'CATEGORY_NOT_CONFIGURED') return { code: 'invalid_category', safeMessage: '分类无法确认，没有执行修改。' };
  if (message === 'ITEM_PATCH_NOT_IMPLEMENTED' || message === 'REFERENCE_NOT_SUPPORTED' || message === 'PAGE_TOKEN_UNSUPPORTED') return { code: 'unsupported_request', safeMessage: '这个请求形式暂时不支持，没有执行修改。' };
  if (message === 'PAGE_TOKEN_SECRET_NOT_CONFIGURED' || message === 'OUTBOX_NOT_ENABLED') return { code: 'route_not_ready', safeMessage: '当前 V2 依赖尚未配置完成，数据没有修改。' };
  if (message === 'STALE_FENCE_OR_SESSION_CAS' || message === 'SESSION_CAS_CONFLICT') return { code: 'ordering_conflict', safeMessage: '会话已经被另一条请求更新，请刷新后重试。' };
  if (message.startsWith('STALE_FENCE')) return { code: 'stale_fence', safeMessage: '这条请求已经过期，没有执行修改。' };
  return { code: message === 'V2_OPERATION_NOT_IMPLEMENTED' ? message : 'db_commit_failed', safeMessage: '本次请求没有完成写入，请稍后重试。' };
}

async function enqueueReplayDelivery(
  env: Env,
  resultId: string,
  destinationId: string,
  threadId: string | null | undefined,
  replayIdempotencyKey: string
): Promise<RenderPayload> {
  const stored = await env.DB.prepare(
    `SELECT render_payload_json, render_hash
       FROM finance_results WHERE result_id = ? AND ledger_scope_id = 'personal:primary'`
  ).bind(resultId).first<{ render_payload_json: string; render_hash: string }>();
  if (!stored) throw new Error('FINANCE_RESULT_NOT_FOUND');
  const payload = JSON.parse(stored.render_payload_json) as RenderPayload;
  const runtime = await readRuntimeControl(env.DB);
  if (!['enabled', 'draining'].includes(runtime.outbox_mode)) throw new Error('OUTBOX_NOT_ENABLED');
  const deliveryRequestId = await deriveDeliveryRequestId({
    result_id: resultId,
    destination_id: destinationId,
    kind: 'replay',
    replay_idempotency_key: replayIdempotencyKey
  });
  const statements = payload.telegram_parts.map((part) => env.DB.prepare(
    `INSERT OR IGNORE INTO finance_outbox (
       outbox_id, ledger_scope_id, result_id, delivery_request_id, part_index,
       render_hash, destination_type, destination_id, thread_id, status,
       lease_epoch, route_epoch
     ) SELECT ?, 'personal:primary', ?, ?, ?, ?, 'telegram_owner', ?, ?, 'pending', 0, c.config_epoch
       FROM finance_runtime_control c
      WHERE c.control_id = 'primary' AND c.outbox_mode IN ('enabled', 'draining')`
  ).bind(
    `${deliveryRequestId}_${part.part_index}`,
    resultId,
    deliveryRequestId,
    part.part_index,
    stored.render_hash,
    destinationId,
    threadId ?? null
  ));
  await env.DB.batch(statements);
  return payload;
}

export async function handleFinanceV2Turn(
  env: Env,
  turn: FinanceTurn,
  options: FinanceV2ServiceOptions = {}
): Promise<FinanceV2ServiceResponse> {
  if (options.telegramDestinationId) {
    const configuredOwnerChatId = env.TELEGRAM_OWNER_CHAT_ID?.trim();
    if (!configuredOwnerChatId || configuredOwnerChatId !== options.telegramDestinationId) {
      return errorResult(turn, 'unauthorized', '消息投递目标未配置或不属于当前账本。');
    }
  }
  let reservation: Awaited<ReturnType<typeof reserveTurn>>;
  try {
    reservation = await reserveTurn(env.DB, turn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'STALE_TELEGRAM_ORDER' || message === 'TELEGRAM_ORDERING_CURSOR_NOT_FOUND') {
      return errorResult(turn, 'ordering_conflict', '这条 Telegram 消息顺序已经过期，请重新发送最新消息。');
    }
    if (message === 'IDEMPOTENCY_CONFLICT') return errorResult(turn, 'idempotency_conflict', '同一请求标识对应了不同内容，没有执行修改。');
    return errorResult(turn, 'db_read_failed', '请求没有成功登记，请稍后重试。');
  }
  if (!reservation.created) {
    const storedTurn = await loadTurnResult(env.DB, reservation.turn_id);
    if (storedTurn?.result_id) {
      const storedResult = await loadFinanceResult(env.DB, storedTurn.result_id);
      if (storedResult) {
        const renderPayload = options.delivery?.kind === 'replay' && options.telegramDestinationId
          ? await enqueueReplayDelivery(env, storedResult.result_id, options.telegramDestinationId, options.telegramThreadId, options.delivery.replayIdempotencyKey)
          : undefined;
        return { result: storedResult, render_payload: renderPayload, duplicate: true };
      }
    }
    if (storedTurn?.completed_at) {
      const failed = errorResult({ ...turn, turn_id: reservation.turn_id }, 'previous_failure', '上一次处理没有完成写入，请重新发送。');
      return { ...(await persistErrorResult(env, { ...turn, turn_id: reservation.turn_id }, failed)), duplicate: true };
    }
    return { ...errorResult(turn, 'in_progress', '这条请求正在处理中，请稍后重试。'), in_progress: true };
  }

  const session = await ensureSession(env.DB, turn.actor.ledger_scope_id, turn.session_key);
  const baseSessionVersion = turn.base_session_version ?? session.session_version;
  const activePlan = await loadPlan(env.DB, session.active_plan_id, session.active_plan_version);
  let plan: FinancePlan;
  try {
    const structuredPlan = options.structuredPlan && typeof options.structuredPlan === 'object'
      ? {
          ...(options.structuredPlan as Record<string, unknown>),
          source_turn_id: (options.structuredPlan as Record<string, unknown>).source_turn_id || turn.turn_id,
          base_session_version: (options.structuredPlan as Record<string, unknown>).base_session_version ?? baseSessionVersion
        }
      : options.structuredPlan;
    const effectiveTurn = { ...turn, base_session_version: baseSessionVersion };
    plan = options.structuredPatch !== undefined
      ? activePlan
        ? applyFinancePlanPatch(activePlan, options.structuredPatch, effectiveTurn)
        : (() => { throw new ProtocolValidationError('stale_plan', 'no active plan is available for this patch'); })()
      : structuredPlan
      ? validateFinancePlan(structuredPlan, effectiveTurn)
      : await interpretFinanceTurn(env, effectiveTurn, {
          sessionVersion: session.session_version,
          activePlan,
          recentTurnSummaries: [],
          ...options.orchestratorContext
        });
  } catch (error) {
    const rawCode = error instanceof ProtocolValidationError ? error.code : 'interpretation_failed';
    const code = rawCode === 'stale_plan' ? 'ordering_conflict' : rawCode;
    await saveTurnInterpretation(env.DB, turn.turn_id, 'failed', JSON.stringify({ code }));
    const safeMessage = code === 'stale_turn' || code === 'ordering_conflict'
      ? '上一轮会话已经发生变化，请刷新后重试。'
      : '我没有足够把握理解这条财务请求，没有执行修改。';
    return persistErrorResult(env, turn, errorResult(turn, code, safeMessage));
  }

  const planJson = canonicalizeJson(plan);
  const planHash = await (async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(planJson));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  })();
  await saveTurnInterpretation(env.DB, turn.turn_id, 'interpreted', planJson, plan.plan_id);
  await storePlan(env.DB, {
    plan_id: plan.plan_id,
    plan_version: plan.plan_version,
    ledger_scope_id: plan.ledger_scope_id,
    session_key: turn.session_key,
    source_turn_id: plan.source_turn_id,
    operation: plan.operation
  }, planJson, planHash);

  let reserved;
  try {
    reserved = await reserveOperation(env.DB, {
      operation_id: `op_${crypto.randomUUID()}`,
      ledger_scope_id: turn.actor.ledger_scope_id,
      idempotency_key: turn.idempotency_key,
      payload_hash: turn.payload_hash,
      turn_id: turn.turn_id,
      session_key: turn.session_key,
      operation_type: plan.operation,
      plan_id: plan.plan_id,
      plan_version: plan.plan_version
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveTurnInterpretation(env.DB, turn.turn_id, 'failed', JSON.stringify({ code: message }));
    return persistErrorResult(env, turn, errorResult(turn, message === 'IDEMPOTENCY_CONFLICT' ? message : 'route_not_ready', '当前 V2 路由尚未开放，数据没有修改。'));
  }
  if (reserved.replay) {
    if (reserved.operation.result_id) {
      const stored = await loadFinanceResult(env.DB, reserved.operation.result_id);
      if (stored) return { result: stored, duplicate: true, operation_id: reserved.operation.operation_id };
    }
    const failed = errorResult(turn, reserved.operation.error_code || 'previous_failure', '上一次处理没有完成写入，请重新发送。', reserved.operation.operation_type);
    return { ...(await persistErrorResult(env, turn, failed)), duplicate: true, operation_id: reserved.operation.operation_id };
  }
  if (reserved.in_progress) return { ...errorResult(turn, 'in_progress', '这条请求正在处理中，请稍后重试。'), in_progress: true, operation_id: reserved.operation.operation_id };

  let operation: import('./protocol').FinanceOperationRecord | undefined;
  try {
    operation = await claimOperation(env.DB, reserved.operation, `worker_${crypto.randomUUID()}`);
    const draft = await prepareFinanceExecution(env, plan, operation);
    const rendered = await renderFinanceResult(draft.result, draft.presentation);
    const committedResult = { ...draft.result, render_hash: rendered.render_hash } as FinanceResult;
    const resultPage = committedResult.kind === 'success' ? committedResult.page : null;
    const activeResultSetId = draft.result_set_id !== undefined ? draft.result_set_id : session.active_result_set_id;
    const activeWindowStart = resultPage?.start_ordinal ?? session.active_window_start_ordinal;
    const activeWindowEnd = resultPage?.end_ordinal ?? session.active_window_end_ordinal;
    const previousWindowStart = resultPage ? session.active_window_start_ordinal : session.previous_window_start_ordinal;
    const previousWindowEnd = resultPage ? session.active_window_end_ordinal : session.previous_window_end_ordinal;
    const deliveryRows = [];
    if (options.telegramDestinationId) {
      const deliveryIdentity = options.delivery?.kind === 'replay'
        ? await deriveDeliveryRequestId({
            result_id: committedResult.result_id,
            destination_id: options.telegramDestinationId,
            kind: 'replay',
            replay_idempotency_key: options.delivery.replayIdempotencyKey
          })
        : await deriveDeliveryRequestId({
            result_id: committedResult.result_id,
            destination_id: options.telegramDestinationId,
            kind: 'initial',
            initial_turn_id: turn.turn_id
          });
      for (const part of rendered.payload.telegram_parts) {
        deliveryRows.push({
          outbox_id: `${deliveryIdentity}_${part.part_index}`,
          delivery_request_id: deliveryIdentity,
          part_index: part.part_index,
          destination_id: options.telegramDestinationId,
          thread_id: options.telegramThreadId ?? null
        });
      }
    }
    const transactionIds = committedResult.kind === 'success' ? committedResult.transaction_ids || [] : [];
    const referenceEntityId = transactionIds[0] || draft.result_set_id || committedResult.result_id;
    const referenceFence = operationFence(operation);
    const referenceStatement = env.DB.prepare(
      `INSERT OR IGNORE INTO finance_session_references (
         reference_id, ledger_scope_id, session_key, reference_kind,
         entity_id, source_turn_id, source_result_id, expires_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 day')
          WHERE ${referenceFence.sql}`
    ).bind(
      `ref_${operation.operation_id}`,
      operation.ledger_scope_id,
      turn.session_key,
      sessionReferenceKind(operation.operation_type),
      referenceEntityId,
      turn.turn_id,
      committedResult.result_id,
      ...referenceFence.params
    );
    const sessionStatement = env.DB.prepare(
      `UPDATE finance_sessions
          SET session_version = session_version + 1,
              active_plan_id = ?, active_plan_version = ?,
              active_result_set_id = ?,
              active_window_start_ordinal = ?, active_window_end_ordinal = ?,
              previous_window_start_ordinal = ?, previous_window_end_ordinal = ?,
              last_turn_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE ledger_scope_id = ? AND session_key = ? AND session_version = ?
          AND ${operationFence(operation).sql}`
    ).bind(
      plan.plan_id,
      plan.plan_version,
      activeResultSetId,
      activeWindowStart,
      activeWindowEnd,
      previousWindowStart,
      previousWindowEnd,
      turn.turn_id,
      turn.actor.ledger_scope_id,
      turn.session_key,
      baseSessionVersion,
      ...operationFence(operation).params
    );
    const turnStatement = env.DB.prepare(
      `UPDATE finance_turns SET result_id = ?, completed_at = CURRENT_TIMESTAMP
        WHERE turn_id = ? AND result_id IS NULL
          AND ${operationFence(operation).sql}`
    ).bind(committedResult.result_id, turn.turn_id, ...operationFence(operation).params);
    const sessionSideEffects = operation.operation_type === 'receipt_create'
      ? []
      : [sessionStatement];
    await commitFinanceOperation(env.DB, {
      operation,
      result: committedResult,
      render_payload: rendered.payload,
      render_hash: rendered.render_hash,
      result_json_bytes: new TextEncoder().encode(canonicalizeJson(committedResult)).byteLength,
      result_set_id: draft.result_set_id,
      side_effect_statements: [...draft.side_effect_statements, referenceStatement, ...sessionSideEffects, turnStatement],
      outbox_rows: deliveryRows,
      terminal_status: 'committed'
    });
    return {
      result: committedResult,
      render_payload: rendered.payload,
      operation_id: operation.operation_id
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const operationType = operation?.operation_type || plan.operation;
    const failure = classifyFailure(message);
    const persisted = await persistErrorResult(
      env,
      turn,
      errorResult(turn, failure.code, failure.safeMessage, operationType)
    );
    if (operation) await failFinanceOperation(env.DB, operation, message, persisted.result.result_id);
    return {
      ...persisted,
      ...(operation ? { operation_id: operation.operation_id } : {})
    };
  }
}
