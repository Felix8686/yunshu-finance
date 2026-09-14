import coreHandler from './index';
import { selectLargestPhoto } from './receipt';
import { enqueueReceiptJob } from './receipt-job';
import { processReceiptQueueJobV2 } from './receipt-job-v2';
import { isVeryfiConfigured } from './receipt-provider';
import {
  formatFinanceTelegramReply,
  handleFinanceApiRequest,
  handleFinanceIntakeQuery,
  parseFinanceTextQuery
} from './finance';
import {
  handleFinanceConversationTelegram,
  rememberFinanceContext
} from './finance-conversation';
import { handleFinanceCommandTelegram } from './finance-command';
import { handleFinanceV2ApiRequest } from './finance-v2/http';
import { dispatchFinanceOutbox, enqueueFinanceOutboxDispatch, isFinanceOutboxDispatchJob, type FinanceOutboxDispatchJob } from './finance-v2/outbox';
import { loadPlan, loadRecentTurnSummaries, loadResultWindow, loadSession, markSessionCompatibilityInterrupted, readRuntimeControl, settleRolloutInterruptedOperations } from './finance-v2/persistence';
import { loadFinanceReferenceCatalog } from './finance-reference';
import { handleFinanceV2Turn } from './finance-v2/service';
import { buildTelegramFinanceTurn } from './finance-v2/turn';
import { persistShadowComparison, shadowV2Artifact, type ShadowV1Artifact, type ShadowV2Artifact } from './finance-v2/shadow';
import { interpretFinanceTurn } from './finance-v2/orchestrator';
import { buildTurnContextSnapshot } from './finance-v2/context';
import { canonicalizeJson, sha256Hex, type FinanceTurn } from './finance-v2/protocol';
import { processReceiptQueueJobV3 } from './receipt-job-v3';
import { resolveTelegramReferenceTime, telegramMessageDateToDate } from './telegram-time';
import type { Env, TelegramUpdate } from './types';
import type { ReceiptQueueJob } from './receipt-job';

interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

interface QueueBatchLike<T> {
  messages: QueueMessageLike<T>[];
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function sendTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) throw new Error(`TELEGRAM_SEND_HTTP_${response.status}`);
}

async function sendTelegramMessageSafely(env: Env, chatId: number, text: string): Promise<void> {
  try {
    await sendTelegramMessage(env, chatId, text);
  } catch (error) {
    console.error('telegram reply failed', error instanceof Error ? error.message : 'unknown error');
  }
}

async function legacyCoreShadowArtifact(response: Response): Promise<ShadowV1Artifact> {
  try {
    const body = await response.clone().json() as {
      ok?: boolean;
      error?: string;
      legacy_operation_class?: ShadowV1Artifact['operation_class'];
      data?: { transaction_id?: string; transactions?: unknown[]; total?: number };
    };
    const data = body.data;
    const operationClass = body.legacy_operation_class || (body.ok && (data?.transaction_id || (Array.isArray(data?.transactions) && data.transactions.length))
      ? 'create'
      : body.ok && typeof data?.total === 'number'
        ? 'summarize'
        : body.ok
          ? 'query'
          : 'error');
    return {
      route: 'core',
      operation_class: operationClass,
      time_scope_class: 'unknown',
      clarification: 0,
      passthrough: 0
    };
  } catch {
    return {
      route: 'core',
      operation_class: 'error',
      time_scope_class: 'unknown',
      clarification: 0,
      passthrough: 0
    };
  }
}

function telegramOwnerAuthorized(env: Env, update: TelegramUpdate): boolean {
  const expectedUserId = env.TELEGRAM_OWNER_USER_ID?.trim();
  const expectedChatId = env.TELEGRAM_OWNER_CHAT_ID?.trim();
  if (!expectedUserId || !expectedChatId) return false;
  const message = update.message;
  if (!message?.from?.id || !message.chat?.id) return false;
  if (String(message.from.id) !== expectedUserId || String(message.chat.id) !== expectedChatId) return false;
  const expectedChatType = env.TELEGRAM_OWNER_CHAT_TYPE?.trim();
  return !expectedChatType || message.chat.type === expectedChatType;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === '/health' && method === 'GET') {
      return jsonResponse({
        ok: true,
        service: 'wanxiang-cloud',
        version: '0.7.0',
        receipt_vision: true,
        receipt_provider: 'veryfi',
        receipt_provider_configured: isVeryfiConfigured(env),
        receipt_queue_bound: !!env.RECEIPT_QUEUE,
        finance_history_query: true,
        finance_conversation: true,
        finance_command_layer: true,
        dynamic_finance_taxonomy: true,
        telegram_event_time: true,
        r2_bound: !!env.FILES,
        d1_bound: !!env.DB
      });
    }

    const financeV2Response = await handleFinanceV2ApiRequest(request, env);
    if (financeV2Response) return financeV2Response;

    const financeApiResponse = await handleFinanceApiRequest(request, env);
    if (financeApiResponse) return financeApiResponse;

    const financeIntakeResponse = await handleFinanceIntakeQuery(request, env);
    if (financeIntakeResponse) return financeIntakeResponse;

    if (url.pathname !== '/telegram/webhook' || method !== 'POST') {
      return coreHandler.fetch(request, env);
    }

    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      return jsonResponse({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET_NOT_CONFIGURED' }, 503);
    }
    if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);
    }

    const legacyRequest = request.clone();
    let update: TelegramUpdate;
    try {
      update = await request.json() as TelegramUpdate;
    } catch {
      return jsonResponse({ ok: false, error: 'INVALID_TELEGRAM_UPDATE' }, 400);
    }

    const timeZone = env.APP_TIMEZONE || 'Asia/Shanghai';
    const eventDate = telegramMessageDateToDate(update.message?.date) || new Date();
    const referenceLocalNow = resolveTelegramReferenceTime(update.message?.date, timeZone);
    const chatId = update.message?.chat?.id;
    const text = update.message?.text?.trim();
    const telegramSourceId = `tg_${update.message?.message_id || update.update_id}`;

    let financeRouteMode = 'primary_v1';
    let receiptRouteMode = 'v1';
    let runtimeControlReady = true;
    let financeV2TelegramActive = false;
    let financeV2TelegramShadow = false;
    let receiptV2TelegramActive = false;
    let shadowState: { turnId: string; startedAt: number; artifact: ShadowV2Artifact } | null = null;
    let shadowTurn: FinanceTurn | null = null;
    let shadowStartedAt = 0;
    const finishShadow = async (v1: ShadowV1Artifact): Promise<void> => {
      if (!shadowState) return;
      try {
        await persistShadowComparison(env.SHADOW_DB, shadowState.turnId, v1, shadowState.artifact, performance.now() - shadowState.startedAt, 1);
      } catch (error) {
        console.warn('finance v2 shadow telemetry failed', error instanceof Error ? error.message : 'unknown error');
      }
    };
    const markCompatibilitySession = async (): Promise<boolean> => {
      if (!chatId || (financeRouteMode !== 'primary_v1' && !financeV2TelegramShadow && receiptRouteMode !== 'v1')) return true;
      try {
        await markSessionCompatibilityInterrupted(env.DB, 'personal:primary', `telegram:${chatId}:topic:${update.message?.message_thread_id || 0}`);
        return true;
      } catch (error) {
        console.error('finance compatibility session mark failed', error instanceof Error ? error.message : 'unknown error');
        return false;
      }
    };
    try {
      const runtime = await readRuntimeControl(env.DB);
      financeRouteMode = runtime.finance_route_mode;
      receiptRouteMode = runtime.receipt_route_mode;
      financeV2TelegramActive = ['canary_v2', 'primary_v2'].includes(runtime.finance_route_mode);
      financeV2TelegramShadow = runtime.finance_route_mode === 'shadow_v2';
      receiptV2TelegramActive = ['v2', 'draining_v2'].includes(runtime.receipt_route_mode);
    } catch {
      runtimeControlReady = false;
      financeRouteMode = 'primary_v1';
      receiptRouteMode = 'v1';
      financeV2TelegramActive = false;
      receiptV2TelegramActive = false;
    }

    if (!runtimeControlReady) {
      if (chatId) await sendTelegramMessageSafely(env, chatId, '财务系统运行控制暂时不可用，当前请求没有执行，请稍后重试。');
      return jsonResponse({ ok: false, error: 'FINANCE_RUNTIME_CONTROL_UNAVAILABLE' }, 503);
    }

    if (financeV2TelegramShadow && !env.SHADOW_DB) {
      if (chatId) await sendTelegramMessageSafely(env, chatId, '财务影子比对存储尚未配置，当前请求没有执行，请稍后重试。');
      return jsonResponse({ ok: false, error: 'SHADOW_DB_NOT_CONFIGURED' }, 503);
    }

    if ((financeV2TelegramActive || financeV2TelegramShadow || receiptV2TelegramActive) && !telegramOwnerAuthorized(env, update)) {
      if (!env.TELEGRAM_OWNER_USER_ID || !env.TELEGRAM_OWNER_CHAT_ID) {
        return jsonResponse({ ok: false, error: 'TELEGRAM_OWNER_NOT_CONFIGURED' }, 503);
      }
      return jsonResponse({ ok: false, error: 'FORBIDDEN' }, 403);
    }

    if (chatId && text && !update.message?.photo?.length && financeV2TelegramShadow) {
      try {
        const turn = await buildTelegramFinanceTurn(update, 'Asia/Shanghai', new Date(), env.TELEGRAM_OWNER_USER_ID);
        if (turn) {
          const startedAt = performance.now();
          shadowStartedAt = startedAt;
          shadowTurn = turn;
          const session = await loadSession(env.DB, turn.actor.ledger_scope_id, turn.session_key);
          const compatibilityInterrupted = session?.compatibility_interrupted === 1;
          const activePlan = session && !compatibilityInterrupted
            ? await loadPlan(env.DB, session.active_plan_id, session.active_plan_version)
            : null;
          const recentTurnSummaries = compatibilityInterrupted
            ? []
            : await loadRecentTurnSummaries(env.DB, turn.actor.ledger_scope_id, turn.session_key);
          const referenceCatalog = await loadFinanceReferenceCatalog(env);
          const catalogHash = await sha256Hex(canonicalizeJson(referenceCatalog));
          const activeWindow = session && !compatibilityInterrupted
            ? await loadResultWindow(env.DB, session.active_result_set_id, session.active_window_start_ordinal, session.active_window_end_ordinal)
            : null;
          const previousWindow = session && !compatibilityInterrupted
            ? await loadResultWindow(env.DB, session.active_result_set_id, session.previous_window_start_ordinal, session.previous_window_end_ordinal)
            : null;
          const contextSnapshot = await buildTurnContextSnapshot({
            turnId: turn.turn_id,
            sessionKey: turn.session_key,
            baseSessionVersion: turn.base_session_version ?? session?.session_version ?? 0,
            activePlan,
            activeResultSetId: compatibilityInterrupted ? null : session?.active_result_set_id || null,
            activeWindow,
            previousWindow,
            recentTurnSummaries,
            catalogHash
          });
          const shadowPlan = await interpretFinanceTurn(env, turn, {
            sessionVersion: contextSnapshot.base_session_version,
            activePlan,
            recentTurnSummaries: contextSnapshot.recent_turn_summaries,
            referenceCatalog
          });
          shadowState = { turnId: turn.turn_id, startedAt, artifact: shadowV2Artifact(shadowPlan, true, shadowPlan.confidence) };
          console.info('finance v2 shadow interpretation', JSON.stringify({ operation: shadowPlan.operation, confidence: shadowPlan.confidence }));
        }
      } catch (error) {
        if (shadowTurn) shadowState = { turnId: shadowTurn.turn_id, startedAt: shadowStartedAt || performance.now(), artifact: shadowV2Artifact(null, false) };
        console.warn('finance v2 shadow interpretation failed', error instanceof Error ? error.message : 'unknown error');
      }
    }

    if (chatId && text && !update.message?.photo?.length && financeV2TelegramActive) {
      try {
        const turn = await buildTelegramFinanceTurn(update, 'Asia/Shanghai', new Date(), env.TELEGRAM_OWNER_USER_ID);
        if (!turn) return jsonResponse({ ok: true, ignored: true });
        const response = await handleFinanceV2Turn(env, turn, {
          telegramDestinationId: String(chatId),
          telegramThreadId: update.message?.message_thread_id ? String(update.message.message_thread_id) : null
        });
        await enqueueFinanceOutboxDispatch(env);
        const isError = response.result.kind !== 'success';
        if (isError && response.render_payload && response.delivery_queued !== true) {
          for (const part of response.render_payload.telegram_parts) {
            await sendTelegramMessageSafely(env, chatId, part.text);
          }
        }
        return jsonResponse({
          ok: !isError,
          finance_v2: true,
          operation_id: response.operation_id,
          duplicate: response.duplicate || false,
          in_progress: response.in_progress || false,
          result: response.result
        }, response.in_progress ? 409 : 200);
      } catch (error) {
        console.error('telegram finance v2 failed', error instanceof Error ? error.message : 'unknown error');
        return jsonResponse({ ok: false, finance_v2: true, error: 'FINANCE_V2_FAILED' }, 500);
      }
    }

    if (chatId && text && !update.message?.photo?.length && financeRouteMode === 'draining_v2') {
      await sendTelegramMessageSafely(env, chatId, '财务系统正在切换版本，当前文字请求暂不执行，请稍后重试。');
      return jsonResponse({ ok: false, finance_v2: true, error: 'FINANCE_V2_DRAINING' }, 503);
    }

    if (chatId && text && !update.message?.photo?.length) {
      if (!await markCompatibilitySession()) {
        await sendTelegramMessageSafely(env, chatId, '财务系统兼容状态暂时无法保存，当前请求没有执行，请稍后重试。');
        return jsonResponse({ ok: false, error: 'FINANCE_COMPATIBILITY_MARK_FAILED' }, 503);
      }
      try {
        const commandResult = await handleFinanceCommandTelegram(
          env,
          text,
          'telegram',
          telegramSourceId,
          referenceLocalNow
        );
        if (commandResult) {
          await finishShadow({ route: 'command', operation_class: commandResult.action, time_scope_class: 'unknown', clarification: 0, passthrough: 0 });
          await sendTelegramMessageSafely(env, chatId, commandResult.reply);
          return jsonResponse({
            ok: true,
            finance_command: true,
            action: commandResult.action
          });
        }
      } catch (error) {
        console.error('telegram finance command failed', error instanceof Error ? error.message : 'unknown error');
        await sendTelegramMessageSafely(env, chatId, '账本操作失败，没有继续执行修改。请稍后重试。');
        return jsonResponse({ ok: false, error: 'FINANCE_COMMAND_FAILED' }, 500);
      }

      try {
        const conversation = await handleFinanceConversationTelegram(env, String(chatId), text, eventDate);
        if (conversation) {
          await finishShadow({ route: 'conversation', operation_class: conversation.action === 'details' ? 'query' : conversation.action === 'summary' ? 'summarize' : conversation.action, time_scope_class: 'bounded', clarification: 0, passthrough: 0 });
          await sendTelegramMessageSafely(env, chatId, conversation.reply);
          return jsonResponse({
            ok: true,
            finance_query: true,
            finance_conversation: true,
            action: conversation.action
          });
        }
      } catch (error) {
        console.error('telegram finance conversation failed', error instanceof Error ? error.message : 'unknown error');
      }

      const financeQuery = parseFinanceTextQuery(text, timeZone, eventDate);
      if (financeQuery) {
        try {
          await finishShadow({ route: 'query', operation_class: financeQuery.mode === 'details' ? 'query' : 'summarize', time_scope_class: 'bounded', clarification: 0, passthrough: 0 });
          const reply = await formatFinanceTelegramReply(env, financeQuery);
          await rememberFinanceContext(env, String(chatId), financeQuery, text);
          await sendTelegramMessageSafely(env, chatId, reply);
          return jsonResponse({ ok: true, finance_query: true });
        } catch (error) {
          console.error('telegram finance query failed', error instanceof Error ? error.message : 'unknown error');
          await sendTelegramMessageSafely(env, chatId, '财务查询失败，请稍后重试。');
          return jsonResponse({ ok: false, error: 'FINANCE_QUERY_FAILED' }, 500);
        }
      }
    }

    const photos = update.message?.photo;
    if (chatId && photos?.length && ['draining_v1', 'draining_v2'].includes(receiptRouteMode)) {
      await sendTelegramMessageSafely(env, chatId, '小票系统正在切换版本，当前图片暂不入队，请稍后重试。');
      return jsonResponse({ ok: false, receipt: true, error: 'RECEIPT_ROUTE_DRAINING' }, 503);
    }
    if (chatId && photos?.length && receiptRouteMode === 'v1' && !await markCompatibilitySession()) {
      await sendTelegramMessageSafely(env, chatId, '财务系统兼容状态暂时无法保存，当前图片没有入队，请稍后重试。');
      return jsonResponse({ ok: false, receipt: true, error: 'FINANCE_COMPATIBILITY_MARK_FAILED' }, 503);
    }
    if (!photos || photos.length === 0) {
      const legacyResponse = await coreHandler.fetch(legacyRequest, env);
      await finishShadow(await legacyCoreShadowArtifact(legacyResponse));
      return legacyResponse;
    }

    const messageId = update.message?.message_id;
    const photo = selectLargestPhoto(photos);
    if (!chatId || !messageId || !photo) {
      return jsonResponse({ ok: true, ignored: true });
    }

    const job: ReceiptQueueJob = {
      chatId,
      threadId: update.message?.message_thread_id || null,
      messageId,
      updateId: update.update_id,
      photo,
      caption: update.message?.caption?.trim() || '',
      localNow: referenceLocalNow
    };

    const enqueueResult = await enqueueReceiptJob(env, job);
    await sendTelegramMessageSafely(env, chatId, enqueueResult.message);

    return jsonResponse({
      ok: true,
      receipt: true,
      accepted: enqueueResult.queued,
      duplicate: enqueueResult.duplicate || false,
      in_progress: enqueueResult.inProgress || false,
      source_id: enqueueResult.sourceId
    });
  },

  async queue(batch: QueueBatchLike<ReceiptQueueJob | FinanceOutboxDispatchJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (isFinanceOutboxDispatchJob(job)) {
          const settled = await settleRolloutInterruptedOperations(env.DB);
          if (settled > 0) console.info('finance v2 rollout-interrupted operations settled', settled);
          const dispatched = await dispatchFinanceOutbox(env, 50);
          if (dispatched.retryable > 0 || dispatched.claimed === 50) {
            await enqueueFinanceOutboxDispatch(env, dispatched.retryable > 0 ? 30 : 0);
          }
          message.ack();
          continue;
        }
        let receiptRouteMode = 'v1';
        try {
          const runtime = await readRuntimeControl(env.DB);
          receiptRouteMode = runtime.receipt_route_mode;
        } catch {
          console.error('receipt runtime control unavailable; queue message deferred');
          message.retry();
          continue;
        }
        if (receiptRouteMode === 'draining_v2') {
          console.info('receipt v2 route is draining; queue message deferred');
          message.retry();
          continue;
        }
        const result = receiptRouteMode === 'v2'
          ? await processReceiptQueueJobV3(env, job)
          : await processReceiptQueueJobV2(env, job);
        if (result.viaOutbox) await enqueueFinanceOutboxDispatch(env);
        else await sendTelegramMessage(env, job.chatId, result.message);
        message.ack();
      } catch (error) {
        console.error('receipt queue job failed', error instanceof Error ? error.message : 'unknown error');
        message.retry();
      }
    }

  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    try {
      const settled = await settleRolloutInterruptedOperations(env.DB);
      if (settled > 0) console.info('finance v2 rollout-interrupted operations settled', settled);
    } catch (error) {
      console.error('finance v2 rollout-interrupted settlement failed', error instanceof Error ? error.message : 'unknown error');
    }
    await dispatchFinanceOutbox(env, 10);
  }
};
