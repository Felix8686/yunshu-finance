import type { Env } from '../types';
import { loadSession, readRuntimeControl } from './persistence';
import { dispatchFinanceOutbox } from './outbox';
import { buildApiFinanceTurn } from './turn';
import { handleFinanceV2Turn } from './service';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

function authorized(request: Request, env: Env): boolean {
  const configured = [env.WANXIANG_API_KEY, env.API_BEARER_TOKEN].filter((value): value is string => Boolean(value));
  if (!configured.length) return false;
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return configured.includes(token);
}

export async function handleFinanceV2ApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!url.pathname.startsWith('/v2/finance')) return null;
  if (method === 'OPTIONS') return jsonResponse(null, 204);
  if (!authorized(request, env)) return jsonResponse({ ok: false, error: 'UNAUTHORIZED' }, 401);

  if (url.pathname === '/v2/finance/runtime' && method === 'GET') {
    try {
      return jsonResponse({ ok: true, data: { runtime: await readRuntimeControl(env.DB) } });
    } catch {
      return jsonResponse({ ok: false, error: 'RUNTIME_CONTROL_NOT_FOUND' }, 503);
    }
  }

  if (url.pathname === '/v2/finance/session' && method === 'GET') {
    const sessionKey = url.searchParams.get('session_key') || 'api:owner:default';
    try {
      return jsonResponse({
        ok: true,
        data: {
          session_key: sessionKey,
          session: await loadSession(env.DB, 'personal:primary', sessionKey)
        }
      });
    } catch {
      return jsonResponse({ ok: false, error: 'SESSION_READ_FAILED' }, 500);
    }
  }

  if (url.pathname === '/v2/finance/outbox/dispatch' && method === 'POST') {
    try {
      const body = await request.json().catch(() => ({})) as { max_rows?: number };
      return jsonResponse({ ok: true, data: await dispatchFinanceOutbox(env, body.max_rows || 10) });
    } catch (error) {
      console.error('finance v2 outbox dispatch failed', error instanceof Error ? error.message : 'unknown error');
      return jsonResponse({ ok: false, error: 'OUTBOX_DISPATCH_FAILED' }, 500);
    }
  }

  if (url.pathname !== '/v2/finance' || method !== 'POST') return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404);
  let body: {
    request_id?: string;
    session_key?: string;
    text?: string;
    plan?: unknown;
    plan_patch?: unknown;
    telegram_destination_id?: string;
    telegram_thread_id?: string | null;
    replay_idempotency_key?: string;
    base_session_version?: number | null;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const requestId = body.request_id || request.headers.get('Idempotency-Key') || crypto.randomUUID();
  const sessionKey = body.session_key || 'api:owner:default';
  if (!body.plan && !body.plan_patch && !body.text) return jsonResponse({ ok: false, error: 'PLAN_OR_TEXT_REQUIRED' }, 400);
  let deliveryDestinationId: string | undefined;
  if (body.telegram_destination_id !== undefined) {
    const configuredOwnerChatId = env.TELEGRAM_OWNER_CHAT_ID?.trim();
    if (!configuredOwnerChatId) return jsonResponse({ ok: false, error: 'TELEGRAM_OWNER_NOT_CONFIGURED' }, 503);
    if (String(body.telegram_destination_id) !== configuredOwnerChatId) return jsonResponse({ ok: false, error: 'TELEGRAM_DESTINATION_FORBIDDEN' }, 403);
    deliveryDestinationId = configuredOwnerChatId;
  }
  try {
    const turn = await buildApiFinanceTurn({
      requestId,
      sessionKey,
      text: body.text,
      structuredPayload: body.plan,
      baseSessionVersion: body.base_session_version
    });
    const response = await handleFinanceV2Turn(env, turn, {
      structuredPlan: body.plan,
      structuredPatch: body.plan_patch,
      telegramDestinationId: deliveryDestinationId,
      telegramThreadId: body.telegram_thread_id,
      delivery: body.replay_idempotency_key
        ? { kind: 'replay', replayIdempotencyKey: body.replay_idempotency_key }
        : { kind: 'initial' }
    });
    const isError = response.result.kind === 'error' || response.result.kind === 'rejected';
    const status = response.in_progress ? 409 : isError ? 422 : 200;
    return jsonResponse({ ok: !isError, ...response }, status);
  } catch (error) {
    console.error('finance v2 api failed', error instanceof Error ? error.message : 'unknown error');
    return jsonResponse({ ok: false, error: 'FINANCE_V2_FAILED' }, 500);
  }
}
