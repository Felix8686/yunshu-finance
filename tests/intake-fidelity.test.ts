import assert from 'node:assert/strict';
import {
  categoryEnum,
  financeReferencePrompt,
  filterAtomicCategories,
  normalizeParsedReferenceFields,
  type FinanceReferenceCatalog
} from '../src/finance-reference';
import { resolveTelegramReferenceTime, telegramMessageDateToDate } from '../src/telegram-time';
import type { ParsedIntake, ParsedTransactionItem } from '../src/types';

// Mock taxonomy with real polluted samples (restored composite categories with commas)
const rawCategories = [
  { id: 'cat-food', name: '餐饮', type: 'expense' as const, parent_name: null },
  { id: 'cat-smoke', name: '烟酒', type: 'expense' as const, parent_name: null },
  { id: 'cat-daily', name: '日用品', type: 'expense' as const, parent_name: null },
  { id: 'cat-other-expense', name: '其他支出', type: 'expense' as const, parent_name: null },
  { id: 'cat-salary', name: '工资', type: 'income' as const, parent_name: null },
  { id: 'cat-other-income', name: '其他收入', type: 'income' as const, parent_name: null },
  { id: 'cat-transfer', name: '转账', type: 'transfer' as const, parent_name: null },
  // Polluted composite categories from historical restoration
  { id: 'restored-cat-1', name: '烟酒, 食', type: 'expense' as const, parent_name: null },
  { id: 'restored-cat-2', name: '蔬菜, 肉蛋, 粮油', type: 'expense' as const, parent_name: null },
  { id: 'restored-cat-3', name: '电子, 软件', type: 'expense' as const, parent_name: null },
  { id: 'restored-cat-4', name: '运动，户外', type: 'expense' as const, parent_name: null }
];

// Verify atomic filter isolates composite categories
const atomicCategories = filterAtomicCategories(rawCategories);
assert.equal(atomicCategories.length, 7);
assert.ok(atomicCategories.some((c) => c.name === '烟酒'));
assert.ok(atomicCategories.some((c) => c.name === '日用品'));
assert.ok(!atomicCategories.some((c) => c.name.includes(',') || c.name.includes('，')));

const catalog: FinanceReferenceCatalog = {
  categories: atomicCategories,
  accounts: [
    { id: 'unspecified', name: '未指定', type: 'other' },
    { id: 'wechat', name: '微信', type: 'wallet' },
    { id: 'ccb', name: '建行', type: 'bank' }
  ]
};

// Verify prompt and categoryEnum exclude polluted categories
const catNames = categoryEnum(catalog);
assert.ok(catNames.includes('烟酒'));
assert.ok(catNames.includes('日用品'));
assert.ok(!catNames.includes('烟酒, 食'));
assert.ok(!catNames.includes('蔬菜, 肉蛋, 粮油'));

const prompt = financeReferencePrompt(catalog);
assert.match(prompt, /烟酒/);
assert.match(prompt, /日用品/);
assert.doesNotMatch(prompt, /烟酒, 食/);
assert.doesNotMatch(prompt, /蔬菜, 肉蛋, 粮油/);

// Test A: Single item "硬盒红塔山一盒10元" -> 1 tx -> 烟酒
const singleItem: ParsedTransactionItem = {
  transaction_type: 'expense',
  amount: 10,
  currency: 'CNY',
  category_name: '烟酒',
  account_name: '微信',
  merchant: '',
  description: '硬盒红塔山一盒',
  occurred_at: '2026-09-05T21:31:00'
};
const parsedSingle: ParsedIntake = {
  intent: 'create_transaction',
  confidence: 0.98,
  transactions: [singleItem]
};
const normSingle = normalizeParsedReferenceFields(parsedSingle, catalog);
assert.equal(normSingle.transactions.length, 1);
assert.equal(normSingle.transactions[0].amount, 10);
assert.equal(normSingle.transactions[0].category_name, '烟酒');
assert.equal(normSingle.transactions[0].account_name, '微信');
assert.equal(normSingle.transactions[0].description, '硬盒红塔山一盒');

// Test B: Multi item "一盒硬白沙烟10元，一提维达抽纸18.9" -> 2 tx -> 10 / 18.9 -> 烟酒 / 日用品 -> 总额 28.9
const parsedMulti: ParsedIntake = {
  intent: 'create_transaction',
  confidence: 0.95,
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
const normMulti = normalizeParsedReferenceFields(parsedMulti, catalog);
assert.equal(normMulti.transactions.length, 2);
assert.equal(normMulti.transactions[0].amount, 10);
assert.equal(normMulti.transactions[0].category_name, '烟酒');
assert.equal(normMulti.transactions[1].amount, 18.9);
assert.equal(normMulti.transactions[1].category_name, '日用品');
const total = normMulti.transactions.reduce((s, t) => s + t.amount, 0);
assert.equal(Math.round(total * 100) / 100, 28.9);

// Test C: "早餐8元，公交2元，咖啡12元" -> 3 tx
const parsed3: ParsedIntake = {
  intent: 'create_transaction',
  confidence: 0.96,
  transactions: [
    {
      transaction_type: 'expense',
      amount: 8,
      currency: 'CNY',
      category_name: '餐饮',
      account_name: '未指定',
      merchant: '',
      description: '早餐',
      occurred_at: '2026-09-06T08:00:00'
    },
    {
      transaction_type: 'expense',
      amount: 2,
      currency: 'CNY',
      category_name: '其他支出',
      account_name: '未指定',
      merchant: '',
      description: '公交',
      occurred_at: '2026-09-06T08:30:00'
    },
    {
      transaction_type: 'expense',
      amount: 12,
      currency: 'CNY',
      category_name: '餐饮',
      account_name: '未指定',
      merchant: '',
      description: '咖啡',
      occurred_at: '2026-09-06T09:00:00'
    }
  ]
};
const norm3 = normalizeParsedReferenceFields(parsed3, catalog);
assert.equal(norm3.transactions.length, 3);
assert.equal(norm3.transactions[0].amount, 8);
assert.equal(norm3.transactions[1].amount, 2);
assert.equal(norm3.transactions[2].amount, 12);

// Test D: Same category multiple independent amounts (e.g. 咖啡15元，蛋糕25元) -> independent amounts not merged
const parsedSameCat: ParsedIntake = {
  intent: 'create_transaction',
  confidence: 0.95,
  transactions: [
    {
      transaction_type: 'expense',
      amount: 15,
      currency: 'CNY',
      category_name: '餐饮',
      account_name: '未指定',
      merchant: '星巴克',
      description: '咖啡',
      occurred_at: '2026-09-06T15:00:00'
    },
    {
      transaction_type: 'expense',
      amount: 25,
      currency: 'CNY',
      category_name: '餐饮',
      account_name: '未指定',
      merchant: '星巴克',
      description: '蛋糕',
      occurred_at: '2026-09-06T15:00:00'
    }
  ]
};
const normSameCat = normalizeParsedReferenceFields(parsedSameCat, catalog);
assert.equal(normSameCat.transactions.length, 2);
assert.equal(normSameCat.transactions[0].amount, 15);
assert.equal(normSameCat.transactions[1].amount, 25);
assert.equal(normSameCat.transactions[0].category_name, '餐饮');
assert.equal(normSameCat.transactions[1].category_name, '餐饮');
assert.equal(normSameCat.transactions[0].merchant, '星巴克');
assert.equal(normSameCat.transactions[1].merchant, '星巴克');

// Test E: Unspecified account -> each tx gets "未指定"
const parsedUnspecAcc: ParsedIntake = {
  intent: 'create_transaction',
  confidence: 0.9,
  transactions: [
    {
      transaction_type: 'expense',
      amount: 10,
      currency: 'CNY',
      category_name: '烟酒',
      account_name: '非法或者空账户',
      merchant: '',
      description: '烟',
      occurred_at: '2026-09-06T12:00:00'
    },
    {
      transaction_type: 'expense',
      amount: 20,
      currency: 'CNY',
      category_name: '日用品',
      account_name: '',
      merchant: '',
      description: '纸',
      occurred_at: '2026-09-06T12:00:00'
    }
  ]
};
const normUnspec = normalizeParsedReferenceFields(parsedUnspecAcc, catalog);
assert.equal(normUnspec.transactions[0].account_name, '未指定');
assert.equal(normUnspec.transactions[1].account_name, '未指定');

// Test F: Telegram event time -> multi occurred_at properly use message.date
const unixSeconds = Math.floor(Date.parse('2026-09-06T11:24:37.000Z') / 1000);
const eventDate = telegramMessageDateToDate(unixSeconds);
assert.ok(eventDate);
assert.equal(resolveTelegramReferenceTime(unixSeconds, 'Asia/Shanghai'), '2026-09-06T19:24:37');

// Test unknown category fallback to '其他支出'
const unknownCatTx: ParsedIntake = {
  intent: 'create_transaction',
  confidence: 0.9,
  transactions: [
    {
      transaction_type: 'expense',
      amount: 10,
      currency: 'CNY',
      category_name: 'AI自己编的未知分类',
      account_name: '微信',
      merchant: '',
      description: '杂项',
      occurred_at: '2026-09-06T12:00:00'
    }
  ]
};
const normUnknownCat = normalizeParsedReferenceFields(unknownCatTx, catalog);
assert.equal(normUnknownCat.transactions[0].category_name, '其他支出');

console.log('intake-fidelity tests passed');
