import { resolveTelegramReferenceTime, telegramMessageDateToDate } from '../telegram-time';
import type { TelegramUpdate } from '../types';
import { canonicalizeJson, sha256Hex, type AttachmentReference, type FinanceActor, type FinanceChannel, type FinanceTurn } from './protocol';

export interface ApiTurnInput {
  requestId: string;
  text?: string | null;
  structuredPayload?: unknown;
  structuredPatch?: unknown;
  subjectId?: 'api:owner';
  baseSessionVersion?: number | null;
  sessionKey: string;
  eventTime?: string;
  receivedTime?: string;
  timezone?: 'Asia/Shanghai';
}

export interface ReceiptTurnInput {
  jobId: string;
  sourceEventId: string;
  attachmentRef: string;
  sessionKey: string;
  eventTime: string;
  receivedTime?: string;
  caption?: string | null;
}

function ownerActor(channel: FinanceChannel, telegramUserId?: string): FinanceActor {
  if (channel === 'receipt') {
    return {
      schema_version: 2,
      ledger_scope_id: 'personal:primary',
      subject_id: 'system:receipt',
      auth_source: 'system_receipt',
      permissions: ['finance:read', 'finance:write', 'finance:receipt']
    };
  }
  return {
    schema_version: 2,
    ledger_scope_id: 'personal:primary',
    subject_id: channel === 'telegram' ? `telegram:${telegramUserId || 'owner'}` : 'api:owner',
    auth_source: channel === 'telegram' ? 'telegram_owner' : 'api_owner',
    permissions: ['finance:read', 'finance:write']
  };
}

async function buildTurn(input: {
  channel: FinanceChannel;
  channelEventId: string;
  idempotencyKey: string;
  sessionKey: string;
  ordering: FinanceTurn['ordering'];
  eventTime: string;
  receivedTime: string;
  text?: string | null;
  attachments: AttachmentReference[];
  baseSessionVersion?: number | null;
  telegramUserId?: string;
}): Promise<FinanceTurn> {
  const payload = JSON.stringify({
    channel: input.channel,
    channel_event_id: input.channelEventId,
    text: input.text ?? null,
    attachments: input.attachments
  });
  return {
    schema_version: 2,
    turn_id: `turn_${crypto.randomUUID()}`,
    channel: input.channel,
    channel_event_id: input.channelEventId,
    idempotency_key: input.idempotencyKey,
    payload_hash: await sha256Hex(payload),
    actor: ownerActor(input.channel, input.telegramUserId),
    session_key: input.sessionKey,
    ordering: input.ordering,
    event_time: input.eventTime,
    received_time: input.receivedTime,
    timezone: 'Asia/Shanghai',
    text: input.text ?? null,
    attachments: input.attachments,
    correlation_id: `corr_${crypto.randomUUID()}`,
    base_session_version: input.baseSessionVersion ?? null
  };
}

export async function buildTelegramFinanceTurn(
  update: TelegramUpdate,
  timezone: 'Asia/Shanghai' = 'Asia/Shanghai',
  receivedAt = new Date(),
  telegramUserId?: string
): Promise<FinanceTurn | null> {
  const message = update.message;
  if (!message?.chat?.id || !message.message_id) return null;
  const threadId = String(message.message_thread_id || 0);
  const chatId = String(message.chat.id);
  const eventDate = telegramMessageDateToDate(message.date) || receivedAt;
  const attachments: AttachmentReference[] = (message.photo || []).length
    ? [{ kind: 'telegram_photo', attachment_ref: message.photo?.[message.photo.length - 1]?.file_unique_id || message.photo?.[message.photo.length - 1]?.file_id || '' }]
    : [];
  return buildTurn({
    channel: 'telegram',
    channelEventId: `tg_${update.update_id}_${message.message_id}`,
    idempotencyKey: `telegram:${update.update_id}:${message.message_id}`,
    sessionKey: `telegram:${chatId}:topic:${threadId}`,
    ordering: { kind: 'telegram', epoch: 0, update_id: update.update_id },
    eventTime: eventDate.toISOString(),
    receivedTime: receivedAt.toISOString(),
    text: message.text || message.caption || null,
    attachments,
    telegramUserId
  });
}

export async function buildApiFinanceTurn(input: ApiTurnInput): Promise<FinanceTurn> {
  const receivedTime = input.receivedTime || new Date().toISOString();
  const turn = await buildTurn({
    channel: input.structuredPayload === undefined ? 'api' : 'api',
    channelEventId: `api_${input.requestId}`,
    idempotencyKey: input.requestId,
    sessionKey: input.sessionKey,
    ordering: { kind: 'api', base_session_version: input.baseSessionVersion ?? 0, request_id: input.requestId },
    eventTime: input.eventTime || receivedTime,
    receivedTime,
    text: input.text ?? (input.structuredPayload === undefined ? null : JSON.stringify(input.structuredPayload)),
    attachments: [],
    baseSessionVersion: input.baseSessionVersion ?? null
  });
  turn.payload_hash = await sha256Hex(canonicalizeJson({
    session_key: input.sessionKey,
    text: input.text ?? null,
    plan: input.structuredPayload ?? null,
    plan_patch: input.structuredPatch ?? null,
    base_session_version: input.baseSessionVersion ?? null
  }));
  return turn;
}

export async function buildReceiptFinanceTurn(input: ReceiptTurnInput): Promise<FinanceTurn> {
  return buildTurn({
    channel: 'receipt',
    channelEventId: input.sourceEventId,
    idempotencyKey: `receipt:${input.sourceEventId}:${input.jobId}`,
    sessionKey: input.sessionKey,
    ordering: { kind: 'receipt_completion', source_turn_id: input.sourceEventId, job_id: input.jobId },
    eventTime: input.eventTime,
    receivedTime: input.receivedTime || new Date().toISOString(),
    text: input.caption ?? null,
    attachments: [{ kind: 'receipt_artifact', receipt_artifact_id: input.attachmentRef, job_id: input.jobId }]
  });
}

export function telegramReferenceLocalNow(update: TelegramUpdate, timezone: 'Asia/Shanghai' = 'Asia/Shanghai'): string {
  return resolveTelegramReferenceTime(update.message?.date, timezone);
}
