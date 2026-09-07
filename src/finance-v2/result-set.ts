import {
  canonicalizeJson,
  canonicalizeResultSetRow,
  sha256Hex,
  validateResultSetSnapshot,
  type ResultSetItemSnapshot,
  type ResultSetSnapshot
} from './protocol';

export interface ResultSetRowInput {
  entity_type: string;
  entity_id: string;
  entity_fingerprint?: string;
  snapshot: unknown;
}

export interface PageTokenPayload {
  schema_version: 2;
  ledger_scope_id: 'personal:primary';
  session_key: string;
  result_set_id: string;
  result_set_version: number;
  next_start_ordinal: number;
  page_size: number;
  expires_at: string;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmac(secret: string, value: string, operation: 'sign' | 'verify', signature?: string): Promise<string | boolean> {
  if (!secret.trim()) throw new Error('PAGE_TOKEN_SECRET_NOT_CONFIGURED');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  if (operation === 'sign') {
    const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    let binary = '';
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  if (!signature) return false;
  const signatureBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - signature.length % 4) % 4)), (char) => char.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(value));
}

export async function createPageToken(secret: string, payload: PageTokenPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(canonicalizeJson(payload));
  const signature = await hmac(secret, encodedPayload, 'sign') as string;
  return `${encodedPayload}.${signature}`;
}

export async function verifyPageToken(
  secret: string,
  token: string,
  expected: { ledger_scope_id: 'personal:primary'; session_key: string }
): Promise<PageTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('EXPIRED_REFERENCE');
  let valid = false;
  try {
    valid = await hmac(secret, parts[0], 'verify', parts[1]) as boolean;
  } catch {
    throw new Error('EXPIRED_REFERENCE');
  }
  if (!valid) throw new Error('EXPIRED_REFERENCE');
  let payload: PageTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[0])) as PageTokenPayload;
  } catch {
    throw new Error('EXPIRED_REFERENCE');
  }
  if (
    payload.schema_version !== 2 ||
    payload.ledger_scope_id !== expected.ledger_scope_id ||
    payload.session_key !== expected.session_key ||
    !payload.result_set_id ||
    !Number.isInteger(payload.result_set_version) || payload.result_set_version < 1 ||
    !Number.isInteger(payload.next_start_ordinal) ||
    payload.next_start_ordinal < 1 || payload.next_start_ordinal > 201 ||
    !Number.isInteger(payload.page_size) ||
    payload.page_size < 1 || payload.page_size > 20 ||
    Date.parse(payload.expires_at) <= Date.now()
  ) throw new Error('EXPIRED_REFERENCE');
  return payload;
}

export async function buildResultSetSnapshot(input: {
  resultSetId: string;
  ledgerScopeId: 'personal:primary';
  sessionKey: string;
  sortFilterFingerprint: string;
  pageSize: number;
  rows: ResultSetRowInput[];
  createdAt?: string;
  expiresAt: string;
}): Promise<ResultSetSnapshot> {
  if (input.rows.length > 200) throw new Error('RESULT_SET_TOO_LARGE');
  const items: ResultSetItemSnapshot[] = [];
  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index];
    const canonical = canonicalizeResultSetRow(row.snapshot);
    items.push({
      ordinal: index + 1,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      entity_fingerprint: row.entity_fingerprint || await sha256Hex(canonical.json),
      row_snapshot_json: canonical.json,
      row_snapshot_bytes: canonical.bytes
    });
  }
  const snapshotBytes = new TextEncoder().encode(canonicalizeJson(items)).byteLength;
  const snapshot: ResultSetSnapshot = {
    schema_version: 2,
    result_set_id: input.resultSetId,
    ledger_scope_id: input.ledgerScopeId,
    session_key: input.sessionKey,
    result_set_version: 1,
    row_count: items.length,
    page_size: Math.max(1, Math.min(20, Math.trunc(input.pageSize))),
    sort_filter_fingerprint: input.sortFilterFingerprint,
    snapshot_bytes: snapshotBytes,
    items,
    created_at: input.createdAt || new Date().toISOString(),
    expires_at: input.expiresAt
  };
  validateResultSetSnapshot(snapshot);
  return snapshot;
}

export function resultSetWindow(snapshot: ResultSetSnapshot, startOrdinal = 1, pageSize = snapshot.page_size): {
  start_ordinal: number;
  end_ordinal: number;
  items: ResultSetItemSnapshot[];
  has_previous: boolean;
  has_next: boolean;
} {
  const page = Math.max(1, Math.min(20, Math.trunc(pageSize)));
  const start = Math.max(1, Math.min(snapshot.row_count + 1, Math.trunc(startOrdinal)));
  if (snapshot.row_count === 0 || start > snapshot.row_count) {
    return {
      start_ordinal: snapshot.row_count === 0 ? 0 : start,
      end_ordinal: snapshot.row_count === 0 ? 0 : start - 1,
      items: [],
      has_previous: snapshot.row_count > 0,
      has_next: false
    };
  }
  const end = Math.min(snapshot.row_count, start + page - 1);
  return {
    start_ordinal: start,
    end_ordinal: end,
    items: snapshot.items.filter((item) => item.ordinal >= start && item.ordinal <= end),
    has_previous: start > 1,
    has_next: end < snapshot.row_count
  };
}
