import assert from 'node:assert/strict';
import worker from '../src/index';
import type { Env, ParsedIntake } from '../src/types';

interface SqlRow {
  [key: string]: unknown;
}

class MockD1PreparedStatement {
  private bound: unknown[] = [];
  constructor(private sql: string, private db: MockD1Database) {}

  bind(...args: unknown[]): MockD1PreparedStatement {
    this.bound = args;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return this.db.handleFirst<T>(this.sql, this.bound);
  }

  async run(): Promise<{ success: boolean }> {
    return this.db.handleRun(this.sql, this.bound);
  }

  getSql(): string {
    return this.sql;
  }

  getBound(): unknown[] {
    return this.bound;
  }
}

class MockD1Database {
  public transactions: Array<Record<string, unknown>> = [];
  public categories: Array<{ id: string; name: string; type: string; is_active: number }> = [
    { id: 'cat-smoke', name: '烟酒', type: 'expense', is_active: 1 },
    { id: 'cat-daily', name: '日用品', type: 'expense', is_active: 1 },
    { id: 'cat-food', name: '餐饮', type: 'expense', is_active: 1 },
    { id: 'cat-other-expense', name: '其他支出', type: 'expense', is_active: 1 },
    // Polluted legacy category
    { id: 'restored-cat-smoke-food', name: '烟酒, 食', type: 'expense', is_active: 1 }
  ];
  public accounts: Array<{ id: string; name: string; is_active: number }> = [
    { id: 'acc-unspecified', name: '未指定', is_active: 1 },
    { id: 'acc-wechat', name: '微信', is_active: 1 }
  ];
  public failOnSecondBatchInsert: boolean = false;

  prepare(sql: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(sql, this);
  }

  async batch(statements: MockD1PreparedStatement[]): Promise<unknown[]> {
    // If failOnSecondBatchInsert is true, simulate failure during batch execution
    if (this.failOnSecondBatchInsert && statements.length >= 2) {
      throw new Error('SIMULATED_BATCH_D1_FAILURE');
    }

    // Atomic execution simulation
    const rollbackState = [...this.transactions];
    try {
      for (const stmt of statements) {
        await stmt.run();
      }
      return statements.map(() => ({ success: true }));
    } catch (err) {
      this.transactions = rollbackState;
      throw err;
    }
  }

  async handleFirst<T>(sql: string, bound: unknown[]): Promise<T | null> {
    // 1. SELECT id FROM categories WHERE name = ? AND type = ? AND is_active = 1
    if (sql.includes('FROM categories') && sql.includes('WHERE name = ? AND type = ?')) {
      const name = bound[0];
      const type = bound[1];
      const found = this.categories.find((c) => c.name === name && c.type === type && c.is_active === 1);
      return (found ? { id: found.id } : null) as T;
    }
    // 2. SELECT id FROM accounts WHERE name = ? AND is_active = 1
    if (sql.includes('FROM accounts') && sql.includes('WHERE name = ?')) {
      const name = bound[0];
      const found = this.accounts.find((a) => a.name === name && a.is_active === 1);
      return (found ? { id: found.id } : null) as T;
    }
    // 3. SELECT id FROM transactions WHERE source = ? AND source_id = ?
    if (sql.includes('FROM transactions') && sql.includes('WHERE source = ? AND source_id = ?')) {
      const source = bound[0];
      const sourceId = bound[1];
      const found = this.transactions.find((t) => t.source === source && t.source_id === sourceId);
      return (found ? { id: found.id } : null) as T;
    }
    return null;
  }

  async handleRun(sql: string, bound: unknown[]): Promise<{ success: boolean }> {
    if (sql.includes('INSERT INTO transactions')) {
      // Columns: id, type, amount_fen, currency, account_id, category_id, merchant, description, raw_text, source, source_id, occurred_at
      const [id, type, amount_fen, currency, account_id, category_id, merchant, description, raw_text, source, source_id, occurred_at] = bound;
      
      // Check UNIQUE(source, source_id)
      if (source && source_id) {
        const exists = this.transactions.some((t) => t.source === source && t.source_id === source_id);
        if (exists) {
          throw new Error(`UNIQUE constraint failed: transactions.source, transactions.source_id (${source}, ${source_id})`);
        }
      }

      this.transactions.push({
        id,
        type,
        amount_fen,
        currency,
        account_id,
        category_id,
        merchant,
        description,
        raw_text,
        source,
        source_id,
        occurred_at
      });
      return { success: true };
    }
    return { success: true };
  }
}

// Build mock Env
function createTestEnv(db: MockD1Database, mockParsed: ParsedIntake): Env {
  return {
    DB: db as unknown as D1Database,
    AI: {
      run: async () => ({})
    } as unknown as Ai,
    WANXIANG_API_KEY: 'test-token',
    // Inject mock parser via property override or mock
    __mockParsedIntake: mockParsed
  } as unknown as Env;
}

async function runTests() {
  console.log('Running multi-intake lifecycle and idempotency tests...');

  // Test G: Multi-item intake with source_id and idempotent repeat
  {
    const db = new MockD1Database();
    // Simulate AI parsing result for "一盒硬白沙烟10元，一提维达抽纸18.9"
    const parsedPayload: ParsedIntake = {
      intent: 'create_transaction',
      confidence: 0.98,
      transactions: [
        {
          transaction_type: 'expense',
          amount: 10,
          currency: 'CNY',
          category_name: '烟酒',
          account_name: '未指定',
          merchant: '',
          description: '一盒硬白沙烟',
          occurred_at: '2026-09-06T19:24:37'
        },
        {
          transaction_type: 'expense',
          amount: 18.9,
          currency: 'CNY',
          category_name: '日用品',
          account_name: '未指定',
          merchant: '',
          description: '一提维达抽纸',
          occurred_at: '2026-09-06T19:24:37'
        }
      ]
    };

    const env = createTestEnv(db, parsedPayload);

    // 1. First intake submission
    const req1 = new Request('http://localhost/v1/intake', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer test-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: '一盒硬白沙烟10元，一提维达抽纸18.9',
        source: 'telegram',
        source_id: 'tg_56',
        reference_time: '2026-09-06T19:24:37'
      })
    });

    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 200);
    const json1 = (await res1.json()) as any;
    assert.equal(json1.ok, true);
    assert.match(json1.message, /已记录 2 笔，共 ¥28.90/);
    assert.match(json1.message, /1. 烟酒 ¥10.00 · 未指定/);
    assert.match(json1.message, /2. 日用品 ¥18.90 · 未指定/);
    assert.equal(json1.data.transactions.length, 2);

    // Verify transactions in D1
    assert.equal(db.transactions.length, 2);
    const tx1 = db.transactions[0];
    const tx2 = db.transactions[1];

    // Verify item 1
    assert.equal(tx1.amount_fen, 1000);
    assert.equal(tx1.category_id, 'cat-smoke');
    assert.equal(tx1.account_id, 'acc-unspecified');
    assert.equal(tx1.source, 'telegram');
    assert.equal(tx1.source_id, 'tg_56'); // First transaction retains original source_id
    assert.equal(tx1.raw_text, '一盒硬白沙烟10元，一提维达抽纸18.9');
    assert.equal(tx1.occurred_at, '2026-09-06T19:24:37');

    // Verify item 2
    assert.equal(tx2.amount_fen, 1890);
    assert.equal(tx2.category_id, 'cat-daily');
    assert.equal(tx2.account_id, 'acc-unspecified');
    assert.equal(tx2.source, 'telegram');
    assert.equal(tx2.source_id, 'tg_56#2'); // Second transaction gets idempotent suffix #2
    assert.equal(tx2.raw_text, '一盒硬白沙烟10元，一提维达抽纸18.9');
    assert.equal(tx2.occurred_at, '2026-09-06T19:24:37');

    // 2. Second intake submission (identical repeat from Telegram)
    const req2 = new Request('http://localhost/v1/intake', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer test-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: '一盒硬白沙烟10元，一提维达抽纸18.9',
        source: 'telegram',
        source_id: 'tg_56',
        reference_time: '2026-09-06T19:24:37'
      })
    });

    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 200);
    const json2 = (await res2.json()) as any;
    assert.equal(json2.ok, true);
    assert.equal(json2.data?.duplicate, true);
    assert.match(json2.message, /已经处理过/);

    // Verify 0 new transactions added
    assert.equal(db.transactions.length, 2, 'Idempotent repeated call must not add any new transaction');
  }

  // Test H: Atomic batch rollback when second transaction insertion fails
  {
    const db = new MockD1Database();
    db.failOnSecondBatchInsert = true;

    const parsedPayload: ParsedIntake = {
      intent: 'create_transaction',
      confidence: 0.98,
      transactions: [
        {
          transaction_type: 'expense',
          amount: 10,
          currency: 'CNY',
          category_name: '烟酒',
          account_name: '未指定',
          merchant: '',
          description: '一盒硬白沙烟',
          occurred_at: '2026-09-06T19:24:37'
        },
        {
          transaction_type: 'expense',
          amount: 18.9,
          currency: 'CNY',
          category_name: '日用品',
          account_name: '未指定',
          merchant: '',
          description: '一提维达抽纸',
          occurred_at: '2026-09-06T19:24:37'
        }
      ]
    };

    const env = createTestEnv(db, parsedPayload);

    const req = new Request('http://localhost/v1/intake', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer test-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: '一盒硬白沙烟10元，一提维达抽纸18.9',
        source: 'telegram',
        source_id: 'tg_fail_test',
        reference_time: '2026-09-06T19:24:37'
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 500);
    const json = (await res.json()) as any;
    assert.equal(json.ok, false);
    assert.equal(json.error, 'INTERNAL_ERROR');

    // Verify ATOMICITY: Tx 1 was NOT committed/left in db
    assert.equal(db.transactions.length, 0, 'No partial transaction should remain when batch fails');
  }

  console.log('multi-intake lifecycle and idempotency tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
