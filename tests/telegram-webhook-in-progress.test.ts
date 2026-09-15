import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/app';
import { reserveTurn, transitionRuntimeControl } from '../src/finance-v2/persistence';
import { buildTelegramFinanceTurn } from '../src/finance-v2/turn';
import type { D1Like, D1StatementLike, Env, TelegramUpdate } from '../src/types';

class SqliteStatement implements D1StatementLike {
  constructor(private readonly db: DatabaseSync, readonly sql: string, private readonly values: unknown[] = []) {}

  bind(...values: unknown[]): D1StatementLike {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values as never[]) as T | undefined;
    return row ?? null;
  }

  async run(): Promise<unknown> {
    const result = this.db.prepare(this.sql).run(...this.values as never[]);
    return { meta: { changes: Number(result.changes) } };
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] };
  }
}

class SqliteD1 implements D1Like {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1StatementLike {
    return new SqliteStatement(this.sqlite, query);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'migrations');
const db = new DatabaseSync(':memory:');
for (const file of fs.readdirSync(migrationDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
  db.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
}
const d1 = new SqliteD1(db);

await transitionRuntimeControl(d1, 1, { finance_route_mode: 'shadow_v2', outbox_mode: 'enabled' });
await transitionRuntimeControl(d1, 2, { finance_route_mode: 'canary_v2' });
await transitionRuntimeControl(d1, 3, { finance_route_mode: 'primary_v2' });

let dispatchEnqueues = 0;
const env = {
  DB: d1,
  AI: { run: async () => { throw new Error('AI must not run for a duplicate in-progress turn'); } },
  FILES: {},
  APP_TIMEZONE: 'Asia/Shanghai',
  AI_MODEL: 'test-model',
  FINANCE_PAGE_TOKEN_SECRET: 'telegram-hotfix-test-secret',
  TELEGRAM_OWNER_CHAT_ID: '10001',
  TELEGRAM_OWNER_USER_ID: '10002',
  TELEGRAM_WEBHOOK_SECRET: 'telegram-test-secret',
  TELEGRAM_BOT_TOKEN: 'test-token',
  RECEIPT_QUEUE: {
    send: async () => { dispatchEnqueues += 1; }
  }
} as unknown as Env;

const update: TelegramUpdate = {
  update_id: 91001,
  message: {
    message_id: 81001,
    date: 1789434960,
    chat: { id: 10001, type: 'private' },
    from: { id: 10002 },
    text: '上个月支出多少'
  }
};

const firstTurn = await buildTelegramFinanceTurn(update, 'Asia/Shanghai', new Date('2026-09-15T01:16:00Z'), env.TELEGRAM_OWNER_USER_ID);
assert.ok(firstTurn);
const reservation = await reserveTurn(d1, firstTurn);
assert.equal(reservation.created, true);

let telegramSendCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('api.telegram.org')) telegramSendCount += 1;
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

try {
  const response = await worker.fetch(new Request('https://test.local/telegram/webhook', {
    method: 'POST',
    headers: {
      'X-Telegram-Bot-Api-Secret-Token': 'telegram-test-secret',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(update)
  }), env);

  assert.equal(response.status, 200, 'duplicate in-progress Telegram updates must be ACKed with HTTP 200');
  const body = await response.json() as {
    ok?: boolean;
    finance_v2?: boolean;
    duplicate?: boolean;
    in_progress?: boolean;
    acknowledged?: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(body.finance_v2, true);
  assert.equal(body.duplicate, true);
  assert.equal(body.in_progress, true);
  assert.equal(body.acknowledged, true);
  assert.equal(telegramSendCount, 0, 'duplicate in-progress delivery must not send a user-visible Telegram message');
  assert.equal(dispatchEnqueues, 1, 'existing outbox dispatch behavior remains intact');

  const stored = db.prepare(
    `SELECT result_id, completed_at FROM finance_turns
      WHERE ledger_scope_id = 'personal:primary' AND channel = 'telegram' AND channel_event_id = ?`
  ).get(`tg_${update.update_id}_${update.message?.message_id}`) as { result_id: string | null; completed_at: string | null } | undefined;
  assert.ok(stored);
  assert.equal(stored.result_id, null, 'ACK must not fabricate a result');
  assert.equal(stored.completed_at, null, 'ACK must preserve the in-progress state');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('telegram webhook in-progress ACK test: PASS');
