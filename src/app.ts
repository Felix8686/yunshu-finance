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
import { dispatchFinanceOutbox } from './finance-v2/outbox';
import { readRuntimeControl } from './finance-v2/persistence';
import { handleFinanceV2Turn } from './finance-v2/service';
import { buildTelegramFinanceTurn } from './finance-v2/turn';
import { interpretFinanceTurn } from './finance-v2/orchestrator';
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

    let financeV2TelegramActive = false;
    let financeV2TelegramShadow = false;
    let receiptV2TelegramActive = false;
    try {
      const runtime = await readRuntimeControl(env.DB);
      financeV2TelegramActive = ['canary_v2', 'primary_v2'].includes(runtime.finance_route_mode);
      financeV2TelegramShadow = runtime.finance_route_mode === 'shadow_v2';
      receiptV2TelegramActive = ['v2', 'draining_v2'].includes(runtime.receipt_route_mode);
    } catch {
      financeV2TelegramActive = false;
      receiptV2TelegramActive = false;
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
          const shadowPlan = await interpretFinanceTurn(env, turn, {
            sessionVersion: 0,
            activePlan: null,
            recentTurnSummaries: []
          });
          console.info('finance v2 shadow interpretation', JSON.stringify({ operation: shadowPlan.operation, confidence: shadowPlan.confidence }));
        }
      } catch (error) {
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
        const isError = response.result.kind === 'error' || response.result.kind === 'rejected';
        return jsonResponse({
          ok: !isError,
          finance_v2: true,
          operation_id: response.operation_id,
          duplicate: response.duplicate || false,
          in_progress: response.in_progress || false,
          result: response.result
        }, response.in_progress ? 409 : isError ? 422 : 200);
      } catch (error) {
        console.error('telegram finance v2 failed', error instanceof Error ? error.message : 'unknown error');
        return jsonResponse({ ok: false, finance_v2: true, error: 'FINANCE_V2_FAILED' }, 500);
      }
    }

    if (chatId && text) {
      try {
        const commandResult = await handleFinanceCommandTelegram(
          env,
          text,
          'telegram',
          telegramSourceId,
          referenceLocalNow
        );
        if (commandResult) {
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
    if (!photos || photos.length === 0) {
      return coreHandler.fetch(legacyRequest, env);
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

  async queue(batch: QueueBatchLike<ReceiptQueueJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        let useFinanceV2Receipt = false;
        try {
          const runtime = await readRuntimeControl(env.DB);
          useFinanceV2Receipt = runtime.receipt_route_mode === 'v2';
        } catch {
          useFinanceV2Receipt = false;
        }
        const result = useFinanceV2Receipt
          ? await processReceiptQueueJobV3(env, job)
          : await processReceiptQueueJobV2(env, job);
        if (!result.viaOutbox) await sendTelegramMessage(env, job.chatId, result.message);
        message.ack();
      } catch (error) {
        console.error('receipt queue job failed', error instanceof Error ? error.message : 'unknown error');
        message.retry();
      }
    }
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await dispatchFinanceOutbox(env, 10);
  }
};
