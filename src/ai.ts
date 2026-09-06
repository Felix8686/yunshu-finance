import {
  accountEnum,
  categoryEnum,
  financeReferencePrompt,
  loadFinanceReferenceCatalog,
  normalizeParsedReferenceFields
} from './finance-reference';
import type { Env, ParsedIntake, ParsedTransactionItem, TransactionType } from './types';

function buildSchema(categoryNames: string[], accountNames: string[]) {
  return {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['create_transaction', 'spending_today', 'unknown'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      transactions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            transaction_type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
            amount: { type: 'number', minimum: 0 },
            currency: { type: 'string' },
            category_name: { type: 'string', enum: categoryNames },
            account_name: { type: 'string', enum: accountNames },
            merchant: { type: 'string' },
            description: { type: 'string' },
            occurred_at: { type: 'string' }
          },
          required: [
            'transaction_type', 'amount', 'currency', 'category_name',
            'account_name', 'merchant', 'description', 'occurred_at'
          ]
        }
      }
    },
    required: ['intent', 'confidence', 'transactions']
  } as const;
}

export async function parseIntake(env: Env, text: string, referenceLocalNow: string): Promise<ParsedIntake> {
  const catalog = await loadFinanceReferenceCatalog(env);
  const schema = buildSchema(categoryEnum(catalog), accountEnum(catalog));
  const result = await env.AI.run(env.AI_MODEL, {
    messages: [
      {
        role: 'system',
        content: [
          '你是“万象云端”的输入解析层。你的职责仅是把用户输入转换成结构化意图，绝不能自行执行数据库操作。',
          '支持三种 intent：create_transaction（新增收支）、spending_today（查询今天总支出）、unknown。',
          '当 intent 为 create_transaction 时，transactions 数组至少包含 1 条记录。',
          '当 intent 为 spending_today 或 unknown 时，transactions 数组必须为空数组 []。',
          '【关键规则：一条用户消息可以包含多笔独立流水】',
          '1. 当不同事项具有各自明确金额时，必须逐笔拆分至 transactions 数组。',
          '   例如：“一盒硬白沙烟10元，一提维达抽纸18.9” 必须拆为 2 笔：',
          '   - 10 元 / expense / category_name=烟酒 / description=一盒硬白沙烟',
          '   - 18.9 元 / expense / category_name=日用品（或当前合法原子分类） / description=一提维达抽纸',
          '   例如：“早餐8元，公交2元，咖啡12元” 必须拆为 3 笔。',
          '2. 严禁把多个不同分类拼成一个 category_name（如严禁“烟酒, 食”或“日用, 餐饮”）。',
          '   category_name 永远只能是一个数据库中合法的单一原子分类。',
          '3. 严禁为了拆分而瞎猜或编造金额！',
          '   例如：“买了烟和抽纸一共28.9”，如果无法知道各自多少钱，绝不能自行编造 10 / 18.9。此时如果涉及明显不同分类且无法可靠拆分，应将 intent 设为 unknown。',
          '4. 如果一个消费整体明确一个总金额（例如“买了两瓶水6元”），保持 1 笔即可。',
          '5. 如果一个商家适用于同一句话中的所有流水（例如“在永辉买烟10元、抽纸18.9”），每笔 transaction 的 merchant 均填该商家。',
          '6. 用户没有说明支付方式/账户时，每笔 account_name 均必须填“未指定”；绝不要猜测微信、支付宝或现金。',
          '7. 金额单位默认人民币 CNY。',
          '8. 分类和账户必须严格从下面的当前数据库列表中选择，禁止自行创造不存在的分类或账户。',
          '9. 选择最符合真实用途的最具体原子分类，如烟、香烟、卷烟选择“烟酒”。',
          `10. 参考本地时间：${referenceLocalNow}。用户没有说明时间时，每笔 occurred_at 使用这个时间；“今天/昨天/刚才”等相对时间也以它为基准。`,
          financeReferencePrompt(catalog),
          '无法确定的信息使用空字符串；不要编造商家、账户、时间或消费原因。'
        ].join('\n')
      },
      { role: 'user', content: text }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: schema
    }
  });

  const response = (result as { response?: unknown })?.response;
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;
  return normalizeParsedReferenceFields(validateParsed(parsed), catalog);
}

function validateParsed(value: unknown): ParsedIntake {
  if (!value || typeof value !== 'object') throw new Error('AI_PARSE_INVALID_OBJECT');
  const v = value as Record<string, unknown>;

  const intents = new Set(['create_transaction', 'spending_today', 'unknown']);
  const types = new Set(['expense', 'income', 'transfer']);

  const intent = String(v.intent) as ParsedIntake['intent'];
  if (!intents.has(intent)) throw new Error('AI_PARSE_INVALID_INTENT');

  const confidence = Number(v.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('AI_PARSE_INVALID_CONFIDENCE');
  }

  let transactions: ParsedTransactionItem[] = [];

  // Support array format
  if (Array.isArray(v.transactions)) {
    transactions = v.transactions.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('AI_PARSE_INVALID_TRANSACTION_ITEM');
      const tx = item as Record<string, unknown>;
      const tType = String(tx.transaction_type) as TransactionType;
      if (!types.has(tType)) throw new Error('AI_PARSE_INVALID_TRANSACTION_TYPE');
      const amt = Number(tx.amount);
      if (!Number.isFinite(amt) || amt < 0) throw new Error('AI_PARSE_INVALID_AMOUNT');

      return {
        transaction_type: tType,
        amount: amt,
        currency: clean(tx.currency) || 'CNY',
        category_name: clean(tx.category_name),
        account_name: clean(tx.account_name) || '未指定',
        merchant: clean(tx.merchant),
        description: clean(tx.description),
        occurred_at: clean(tx.occurred_at)
      };
    });
  } else if (v.amount !== undefined && v.transaction_type !== undefined) {
    // Backward compatibility if model returns legacy single object
    const tType = String(v.transaction_type) as TransactionType;
    if (!types.has(tType)) throw new Error('AI_PARSE_INVALID_TRANSACTION_TYPE');
    const amt = Number(v.amount);
    if (!Number.isFinite(amt) || amt < 0) throw new Error('AI_PARSE_INVALID_AMOUNT');

    transactions = [
      {
        transaction_type: tType,
        amount: amt,
        currency: clean(v.currency) || 'CNY',
        category_name: clean(v.category_name),
        account_name: clean(v.account_name) || '未指定',
        merchant: clean(v.merchant),
        description: clean(v.description),
        occurred_at: clean(v.occurred_at)
      }
    ];
  }

  if (intent === 'create_transaction' && transactions.length === 0) {
    throw new Error('AI_PARSE_EMPTY_TRANSACTIONS');
  }

  if (intent !== 'create_transaction') {
    transactions = [];
  }

  const firstTx = transactions[0];

  return {
    intent,
    confidence,
    transactions,
    transaction_type: firstTx?.transaction_type ?? 'expense',
    amount: firstTx?.amount ?? 0,
    currency: firstTx?.currency ?? 'CNY',
    category_name: firstTx?.category_name ?? '',
    account_name: firstTx?.account_name ?? '未指定',
    merchant: firstTx?.merchant ?? '',
    description: firstTx?.description ?? '',
    occurred_at: firstTx?.occurred_at ?? ''
  };
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 300) : '';
}
