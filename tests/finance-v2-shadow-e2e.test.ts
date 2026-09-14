import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/app';
import type { D1Like, D1StatementLike, Env } from '../src/types';

class SqliteStatement implements D1StatementLike {
  constructor(private readonly db: DatabaseSync, private readonly sql: string, private readonly values: unknown[] = []) {}

  bind(...values: unknown[]): D1StatementLike {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values as never[]) as T | undefined) ?? null;
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
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): D1StatementLike {
    return new SqliteStatement(this.db, query);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    this.db.exec('BEGIN');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');
for (const file of fs.readdirSync(path.join(root, 'migrations')).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
  db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
}
const shadowDb = new DatabaseSync(':memory:');
shadowDb.exec(fs.readFileSync(path.join(root, 'shadow-migrations', '0001_shadow_comparisons.sql'), 'utf8'));
const d1 = new SqliteD1(db);
const shadowD1 = new SqliteD1(shadowDb);

const env = {
  DB: d1,
  SHADOW_DB: shadowD1,
  AI: {
    run: async (_model: string, input: Record<string, unknown>) => {
      const messages = input.messages as Array<{ content?: unknown }> | undefined;
      const system = String(messages?.[0]?.content || '');
      if (system.includes('通用账本命令解析层')) {
        return {
          response: JSON.stringify({
            action: 'passthrough',
            target: { scope: 'matched', count: 0, transaction_type: '', category_name: '', account_name: '', merchant: '', amount: 0, text: '', from: '', to: '' },
            changes: { transaction_type: '', amount: 0, category_name: '', account_name: '', merchant: '', description: '', occurred_at: '' },
            transactions: [],
            confidence: 0.99
          })
        };
      }
      const turnId = /当前 turn_id=([^。]+)/.exec(system)?.[1] || '';
      return {
        response: JSON.stringify({
          schema_version: 2,
          plan_id: 'shadow-e2e-plan',
          plan_version: 1,
          base_session_version: 0,
          source_turn_id: turnId,
          ledger_scope_id: 'personal:primary',
          confidence: 0.98,
          presentation: { mode: 'summary' },
          operation: 'create',
          entries: [{
            client_entry_key: 'shadow-entry',
            type: 'expense',
            money: { amount_fen: 880, currency: 'CNY' },
            occurred_at: '2026-09-08T15:00:00+08:00',
            account: { kind: 'account', value: '未指定' },
            category: { kind: 'category', value: '餐饮' },
            merchant: '影子链路商户',
            description: '影子比对 V1 实际写入',
            items: []
          }]
        })
      };
    }
  },
  FILES: {},
  APP_TIMEZONE: 'Asia/Shanghai',
  AI_MODEL: 'shadow-test-model',
  API_BEARER_TOKEN: 'shadow-api-token',
  FINANCE_RUNTIME_CONTROL_TOKEN: 'shadow-runtime-token',
  TELEGRAM_WEBHOOK_SECRET: 'shadow-telegram-secret',
  TELEGRAM_OWNER_USER_ID: '700',
  TELEGRAM_OWNER_CHAT_ID: '700',
  __mockParsedIntake: {
    intent: 'create_transaction',
    confidence: 0.99,
    transactions: [{
      transaction_type: 'expense',
      amount: 8.8,
      currency: 'CNY',
      category_name: '餐饮',
      account_name: '未指定',
      merchant: '影子链路商户',
      description: '影子比对 V1 实际写入',
      occurred_at: '2026-09-08T15:00:00+08:00'
    }]
  }
} as unknown as Env;

await worker.fetch(new Request('https://test.local/v2/finance/runtime/transition', {
  method: 'POST',
  headers: { Authorization: 'Bearer shadow-runtime-token', 'Content-Type': 'application/json' },
  body: JSON.stringify({ expected_config_epoch: 1, patch: { finance_route_mode: 'shadow_v2' } })
}), env);
const shadowResponse = await worker.fetch(new Request('https://test.local/telegram/webhook', {
  method: 'POST',
  headers: {
    'X-Telegram-Bot-Api-Secret-Token': 'shadow-telegram-secret',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    update_id: 7001,
    message: {
      message_id: 7001,
      date: 1788868800,
      chat: { id: 700, type: 'private' },
      from: { id: 700 },
      text: '影子实际链路测试'
    }
  })
}), env);
assert.equal(shadowResponse.status, 200);
assert.equal(db.prepare("SELECT count(*) AS count FROM transactions WHERE source = 'telegram' AND source_id = 'tg_7001'").get().count, 1);
const comparison = shadowDb.prepare('SELECT v1_route, v1_operation_class, v2_operation_class, divergence_codes_json FROM finance_shadow_comparisons').get() as {
  v1_route: string;
  v1_operation_class: string;
  v2_operation_class: string;
  divergence_codes_json: string;
};
assert.equal(comparison.v1_route, 'core');
assert.equal(comparison.v1_operation_class, 'create');
assert.equal(comparison.v2_operation_class, 'create');
assert.equal(comparison.divergence_codes_json, '[]');

db.close();
shadowDb.close();
console.log('finance-v2-shadow-e2e.test.ts: PASS');
