import type { Env } from '../types';
import { readRuntimeControl } from './persistence';
import { sha256Hex, type RenderPayload } from './protocol';
import { assertRenderCapacity, MAX_OUTBOX_ATTEMPTS } from './capacity';

interface OutboxRow {
  outbox_id: string;
  ledger_scope_id: string;
  result_id: string;
  delivery_request_id: string;
  part_index: number;
  render_hash: string;
  destination_id: string;
  thread_id: string | null;
  status: string;
  lease_owner: string | null;
  lease_epoch: number;
  route_epoch: number;
  attempt_count: number;
  render_payload_json: string;
  stored_render_hash: string;
}

interface TelegramSendResponse {
  ok?: boolean;
  result?: { message_id?: number };
}

export interface FinanceOutboxDispatchJob {
  kind: 'finance_outbox_dispatch';
}

export function isFinanceOutboxDispatchJob(value: unknown): value is FinanceOutboxDispatchJob {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'finance_outbox_dispatch';
}

export async function enqueueFinanceOutboxDispatch(env: Env, delaySeconds = 0): Promise<void> {
  if (!env.RECEIPT_QUEUE) throw new Error('FINANCE_OUTBOX_QUEUE_NOT_CONFIGURED');
  await env.RECEIPT_QUEUE.send(
    { kind: 'finance_outbox_dispatch' } satisfies FinanceOutboxDispatchJob,
    delaySeconds > 0 ? { delaySeconds } : undefined
  );
}

function changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes || 0);
}

async function claimNextOutbox(env: Env, owner: string): Promise<OutboxRow | null> {
  const control = await readRuntimeControl(env.DB);
  if (control.outbox_mode !== 'enabled' && control.outbox_mode !== 'draining') return null;
  const candidate = await env.DB.prepare(
    `SELECT o.*, r.render_payload_json, r.render_hash AS stored_render_hash
       FROM finance_outbox o
       JOIN finance_results r ON r.result_id = o.result_id
      WHERE o.status IN ('pending', 'failed_retryable')
        AND o.attempt_count < ?
        AND (o.next_attempt_at IS NULL OR julianday(o.next_attempt_at) <= julianday('now'))
      ORDER BY o.created_at, o.outbox_id
      LIMIT 1`
  ).bind(MAX_OUTBOX_ATTEMPTS).first<OutboxRow>();
  if (!candidate) return null;
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE finance_outbox
        SET status = 'sending', lease_owner = ?, lease_epoch = lease_epoch + 1,
            route_epoch = ?, lease_expires_at = ?, last_attempt_started_at = CURRENT_TIMESTAMP,
            attempt_count = attempt_count + 1, last_error_code = NULL
      WHERE outbox_id = ? AND status IN ('pending', 'failed_retryable')
        AND attempt_count < ?
        AND EXISTS (
          SELECT 1 FROM finance_runtime_control c
           WHERE c.control_id = 'primary'
             AND c.config_epoch = ?
             AND c.outbox_mode IN ('enabled', 'draining')
        )`
  ).bind(owner, control.config_epoch, expiresAt, candidate.outbox_id, MAX_OUTBOX_ATTEMPTS, control.config_epoch).run();
  if (changes(claimed) !== 1) return null;
  return env.DB.prepare(
    `SELECT o.*, r.render_payload_json, r.render_hash AS stored_render_hash
       FROM finance_outbox o JOIN finance_results r ON r.result_id = o.result_id
      WHERE o.outbox_id = ?`
  ).bind(candidate.outbox_id).first<OutboxRow>();
}

async function finishOutbox(
  env: Env,
  row: OutboxRow,
  status: 'accepted' | 'failed_retryable' | 'failed_terminal' | 'unknown',
  errorCode: string | null,
  telegramMessageId: number | null
): Promise<boolean> {
  const nextAttemptAt = status === 'failed_retryable'
    ? new Date(Date.now() + Math.min(300_000, Math.max(30_000, row.attempt_count * 30_000))).toISOString()
    : null;
  const result = await env.DB.prepare(
    `UPDATE finance_outbox
        SET status = ?, telegram_message_id = COALESCE(?, telegram_message_id),
            accepted_at = CASE WHEN ? = 'accepted' THEN CURRENT_TIMESTAMP ELSE accepted_at END,
            last_error_code = ?, next_attempt_at = ?, lease_expires_at = NULL
      WHERE outbox_id = ? AND status = 'sending'
        AND lease_owner = ? AND lease_epoch = ? AND route_epoch = ?
        AND EXISTS (
          SELECT 1 FROM finance_runtime_control c
           WHERE c.control_id = 'primary'
             AND c.config_epoch = finance_outbox.route_epoch
             AND c.outbox_mode IN ('enabled', 'draining')
        )`
  ).bind(
    status,
    telegramMessageId,
    status,
    errorCode,
    nextAttemptAt,
    row.outbox_id,
    row.lease_owner,
    row.lease_epoch,
    row.route_epoch
  ).run();
  return changes(result) === 1;
}

async function parseRenderPart(row: OutboxRow): Promise<{ text: string; partHash: string }> {
  if (row.render_hash !== row.stored_render_hash) throw new Error('RENDER_HASH_MISMATCH');
  const payload = JSON.parse(row.render_payload_json) as RenderPayload;
  assertRenderCapacity(payload);
  const part = payload.telegram_parts.find((item) => item.part_index === row.part_index);
  if (!part || !part.part_hash || !part.text) throw new Error('RENDER_PART_NOT_FOUND');
  if (await sha256Hex(part.text) !== part.part_hash) throw new Error('RENDER_PART_HASH_MISMATCH');
  return { text: part.text, partHash: part.part_hash };
}

async function sendTelegram(env: Env, destinationId: string, text: string, threadId: string | null): Promise<{ ok: true; messageId: number | null } | { ok: false; retryable: boolean; code: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, retryable: true, code: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: destinationId,
        text,
        ...(threadId ? { message_thread_id: Number(threadId) || threadId } : {})
      })
    });
    let body: TelegramSendResponse | null = null;
    try { body = await response.json() as TelegramSendResponse; } catch { /* do not persist provider body */ }
    if (response.ok && body?.ok) return { ok: true, messageId: body.result?.message_id || null };
    return { ok: false, retryable: response.status === 408 || response.status === 429 || response.status >= 500, code: `TELEGRAM_HTTP_${response.status}` };
  } catch {
    return { ok: false, retryable: false, code: 'TELEGRAM_AMBIGUOUS_TRANSPORT' };
  }
}

async function markExpiredSendingUnknown(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE finance_outbox
        SET status = 'unknown', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = 'LEASE_EXPIRED'
      WHERE status = 'sending' AND lease_expires_at IS NOT NULL
        AND julianday(lease_expires_at) < julianday('now')`
  ).run();
  return changes(result);
}

export async function dispatchFinanceOutbox(env: Env, maxRows = 10): Promise<{ claimed: number; accepted: number; retryable: number; terminal: number; unknown: number }> {
  const counts = { claimed: 0, accepted: 0, retryable: 0, terminal: 0, unknown: 0 };
  counts.unknown += await markExpiredSendingUnknown(env);
  for (let index = 0; index < Math.max(1, Math.min(50, maxRows)); index += 1) {
    const row = await claimNextOutbox(env, `outbox_${crypto.randomUUID()}`);
    if (!row) break;
    counts.claimed += 1;
    try {
      const part = await parseRenderPart(row);
      const sent = await sendTelegram(env, row.destination_id, part.text, row.thread_id);
      if (sent.ok) {
        if (await finishOutbox(env, row, 'accepted', null, sent.messageId)) counts.accepted += 1;
      } else if (sent.retryable) {
        if (row.attempt_count >= MAX_OUTBOX_ATTEMPTS) {
          if (await finishOutbox(env, row, 'failed_terminal', 'RETRY_LIMIT_EXCEEDED', null)) counts.terminal += 1;
        } else if (await finishOutbox(env, row, 'failed_retryable', sent.code, null)) counts.retryable += 1;
      } else if (sent.code === 'TELEGRAM_AMBIGUOUS_TRANSPORT') {
        if (await finishOutbox(env, row, 'unknown', sent.code, null)) counts.unknown += 1;
      } else {
        if (await finishOutbox(env, row, 'failed_terminal', sent.code, null)) counts.terminal += 1;
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'OUTBOX_RENDER_INVALID';
      if (await finishOutbox(env, row, 'failed_terminal', code.slice(0, 128), null)) counts.terminal += 1;
    }
  }
  return counts;
}
