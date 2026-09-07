import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseIntake } from '../src/ai';
import { Env } from '../src/types';

function getWranglerAuthToken(): string {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const output = execFileSync(
    npx,
    ['wrangler', 'auth', 'token', '--json'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  const credentials = JSON.parse(output) as {
    type?: string;
    token?: string;
  };

  if (!credentials.token) {
    throw new Error(`Wrangler auth token unavailable (type=${credentials.type || 'unknown'})`);
  }
  return credentials.token;
}

async function runRealWorkersAITest() {
  // Do not read oauth_token directly from Wrangler's TOML. That access token may be
  // expired. `wrangler auth token --json` returns the currently configured token and
  // refreshes Wrangler OAuth credentials when needed.
  const authToken = getWranglerAuthToken();
  const accountId = 'ffda4d04feec5de2ef3fb4fbbe35b496';

  // Create real Workers AI shim pointing to Cloudflare REST API via curl (avoiding undici proxy issues)
  const realAiBinding = {
    run: async (model: string, input: Record<string, unknown>) => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
      // Write utf-8 payload to temp file to prevent Windows CLI argument encoding corruption
      const tmpFile = path.join(process.env.TEMP || 'C:\\Users\\mzer8\\AppData\\Local\\Temp', `cf-ai-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(input), 'utf8');
      const curlArgs = [
        '-s',
        '-x', 'http://127.0.0.1:7892',
        '-X', 'POST',
        url,
        '-H', `Authorization: Bearer ${authToken}`,
        '-H', 'Content-Type: application/json; charset=utf-8',
        '--data-binary', `@${tmpFile}`
      ];
      try {
        const resText = execFileSync('curl', curlArgs, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        const data = JSON.parse(resText);
        if (!data.success) {
          throw new Error(`Workers AI failed: ${JSON.stringify(data.errors)}`);
        }
        return data.result;
      } finally {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      }
    }
  };

  // Mock D1 DB that has representative categories including contaminated ones
  const mockCategories = [
    { id: 'cat-food', name: '餐饮', type: 'expense', is_active: 1 },
    { id: 'cat-tobacco', name: '烟酒', type: 'expense', is_active: 1 },
    { id: 'cat-daily', name: '日用品', type: 'expense', is_active: 1 },
    { id: 'cat-traffic', name: '交通', type: 'expense', is_active: 1 },
    { id: 'cat-polluted-1', name: '烟酒, 食', type: 'expense', is_active: 1 },
    { id: 'cat-polluted-2', name: '蔬菜，肉蛋', type: 'expense', is_active: 1 },
  ];

  const mockAccounts = [
    { id: 'acc-unspecified', name: '未指定', is_active: 1 }
  ];

  const mockDb = {
    prepare: (sql: string) => {
      const stmt = {
        bind: (...args: any[]) => ({
          first: async () => {
            if (sql.includes('FROM categories')) {
              const name = args[0];
              const type = args[1];
              const found = mockCategories.find(c => c.name === name && c.type === type && c.is_active === 1);
              return found ? { id: found.id } : null;
            }
            if (sql.includes('FROM accounts')) {
              const name = args[0];
              const found = mockAccounts.find(a => a.name === name && a.is_active === 1);
              return found ? { id: found.id } : null;
            }
            return null;
          },
          all: async () => {
            if (sql.includes('FROM categories')) {
              return { results: mockCategories };
            }
            if (sql.includes('FROM accounts')) {
              return { results: mockAccounts };
            }
            return { results: [] };
          }
        }),
        all: async () => {
          if (sql.includes('FROM categories')) {
            return { results: mockCategories };
          }
          if (sql.includes('FROM accounts')) {
            return { results: mockAccounts };
          }
          return { results: [] };
        }
      };
      return stmt;
    }
  };

  const testEnv: Env = {
    DB: mockDb as any,
    AI: realAiBinding as any,
    AI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    WANXIANG_API_KEY: 'test-key',
    APP_TIMEZONE: 'Asia/Shanghai'
  } as any;

  console.log('Invoking real Workers AI model with user text: "一盒硬白沙烟10元，一提维达抽纸18.9"');
  const parsed = await parseIntake(testEnv, '一盒硬白沙烟10元，一提维达抽纸18.9', '2026-09-06T19:24:37');
  console.log('Real AI Result:', JSON.stringify(parsed, null, 2));

  // Assertions
  if (parsed.intent !== 'create_transaction') {
    throw new Error(`Expected intent create_transaction, got ${parsed.intent}`);
  }
  if (!parsed.transactions || parsed.transactions.length !== 2) {
    throw new Error(`Expected exactly 2 transactions, got ${parsed.transactions?.length}`);
  }

  const tx1 = parsed.transactions[0];
  const tx2 = parsed.transactions[1];

  console.log(`Transaction 1: amount=${tx1.amount}, category=${tx1.category_name}, desc=${tx1.description}`);
  console.log(`Transaction 2: amount=${tx2.amount}, category=${tx2.category_name}, desc=${tx2.description}`);

  if (Math.abs(tx1.amount - 10) > 0.001 || Math.abs(tx2.amount - 18.9) > 0.001) {
    throw new Error(`Amounts do not match expected 10 and 18.9: tx1=${tx1.amount}, tx2=${tx2.amount}`);
  }

  if (tx1.category_name.includes(',') || tx1.category_name.includes('，') ||
      tx2.category_name.includes(',') || tx2.category_name.includes('，')) {
    throw new Error(`Polluted category detected: tx1=${tx1.category_name}, tx2=${tx2.category_name}`);
  }

  if (tx1.category_name !== '烟酒') {
    console.warn(`Note: tx1 category is ${tx1.category_name}`);
  }
  if (tx2.category_name !== '日用品') {
    console.warn(`Note: tx2 category is ${tx2.category_name}`);
  }

  console.log('REAL WORKERS AI ISOLATED VALIDATION PASS!');
}

runRealWorkersAITest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
