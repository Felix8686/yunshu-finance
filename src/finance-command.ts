import type { Env, ParsedTransactionItem, TransactionType } from './types';
import {
  accountEnum,
  categoryEnum,
  financeReferencePrompt,
  loadFinanceReferenceCatalog,
  resolveAccountId,
  resolveCategoryId
} from './finance-reference';

type CommandAction = 'passthrough' | 'create' | 'query' | 'summarize' | 'update' | 'delete' | 'restore';
type TargetScope = 'latest' | 'recent' | 'today' | 'yesterday' | 'date_range' | 'matched';

interface FinanceCommandTarget {
  scope: TargetScope;
  count: number;
  transaction_type: '' | TransactionType;
  category_name: string;
  account_name: string;
  merchant: string;
  amount: number;
  text: string;
  from: string;
  to: string;
}

interface FinanceCommandChanges {
  transaction_type: '' | TransactionType;
  amount: number;
  category_name: string;
  account_name: string;
  merchant: string;
  description: string;
  occurred_at: string;
}

interface FinanceCommand {
  action: CommandAction;
  target: FinanceCommandTarget;
  changes: FinanceCommandChanges;
  transactions: ParsedTransactionItem[];
  confidence: number;
}

interface TransactionRow {
  id: string;
  type: TransactionType;
  amount_fen: number;
  currency: string;
  account_id: string | null;
  category_id: string | null;
  merchant: string | null;
  description: string | null;
  occurred_at: string;
  source: string;
  source_id: string | null;
  raw_text: string | null;
  created_at: string;
  updated_at: string;
  category_name?: string | null;
  account_name?: string | null;
}

interface TransactionItemRow {
  id: string;
  transaction_id: string;
  name: string;
  quantity: number;
  unit_price_fen: number | null;
  line_total_fen: number;
  category: string;
  confidence: number;
  created_at: string;
}

interface TransactionSnapshot {
  transaction: TransactionRow;
  items: TransactionItemRow[];
}

export interface FinanceCommandResult {
  reply: string;
  action: Exclude<CommandAction, 'passthrough'>;
}

function buildCommandSchema(categoryNames: string[], accountNames: string[]) {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['passthrough', 'create', 'query', 'summarize', 'update', 'delete', 'restore']
      },
      target: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['latest', 'recent', 'today', 'yesterday', 'date_range', 'matched'] },
          count: { type: 'integer', minimum: 0, maximum: 20 },
          transaction_type: { type: 'string', enum: ['', 'expense', 'income', 'transfer'] },
          category_name: { type: 'string' },
          account_name: { type: 'string' },
          merchant: { type: 'string' },
          amount: { type: 'number', minimum: 0 },
          text: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' }
        },
        required: [
          'scope', 'count', 'transaction_type', 'category_name', 'account_name',
          'merchant', 'amount', 'text', 'from', 'to'
        ]
      },
      changes: {
        type: 'object',
        properties: {
          transaction_type: { type: 'string', enum: ['', 'expense', 'income', 'transfer'] },
          amount: { type: 'number', minimum: 0 },
          category_name: { type: 'string' },
          account_name: { type: 'string' },
          merchant: { type: 'string' },
          description: { type: 'string' },
          occurred_at: { type: 'string' }
        },
        required: [
          'transaction_type', 'amount', 'category_name', 'account_name',
          'merchant', 'description', 'occurred_at'
        ]
      },
      transactions: {
        type: 'array',
        maxItems: 20,
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
            'transaction_type', 'amount', 'currency', 'category_name', 'account_name',
            'merchant', 'description', 'occurred_at'
          ]
        }
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: ['action', 'target', 'changes', 'transactions', 'confidence']
  } as const;
}

function clean(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanType(value: unknown): '' | TransactionType {
  const v = clean(value);
  return v === 'expense' || v === 'income' || v === 'transfer' ? v : '';
}

function cleanTransaction(value: unknown): ParsedTransactionItem | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const type = cleanType(v.transaction_type);
  const amount = Number(v.amount);
  if (!type || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    transaction_type: type,
    amount,
    currency: clean(v.currency) || 'CNY',
    category_name: clean(v.category_name),
    account_name: clean(v.account_name) || '未指定',
    merchant: clean(v.merchant),
    description: clean(v.description),
    occurred_at: clean(v.occurred_at, 64)
  };
}

function validateCommand(value: unknown): FinanceCommand | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const action = clean(v.action) as CommandAction;
  if (!new Set<CommandAction>(['passthrough', 'create', 'query', 'summarize', 'update', 'delete', 'restore']).has(action)) return null;

  const t = (v.target && typeof v.target === 'object' ? v.target : {}) as Record<string, unknown>;
  const c = (v.changes && typeof v.changes === 'object' ? v.changes : {}) as Record<string, unknown>;
  const scope = clean(t.scope) as TargetScope;
  if (!new Set<TargetScope>(['latest', 'recent', 'today', 'yesterday', 'date_range', 'matched']).has(scope)) return null;
  const confidence = Number(v.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const transactions = Array.isArray(v.transactions)
    ? v.transactions.map(cleanTransaction).filter((item): item is ParsedTransactionItem => Boolean(item))
    : [];

  return {
    action,
    target: {
      scope,
      count: Math.max(0, Math.min(20, Math.trunc(Number(t.count) || 0))),
      transaction_type: cleanType(t.transaction_type),
      category_name: clean(t.category_name),
      account_name: clean(t.account_name),
      merchant: clean(t.merchant),
      amount: Math.max(0, Number(t.amount) || 0),
      text: clean(t.text),
      from: clean(t.from, 32),
      to: clean(t.to, 32)
    },
    changes: {
      transaction_type: cleanType(c.transaction_type),
      amount: Math.max(0, Number(c.amount) || 0),
      category_name: clean(c.category_name),
      account_name: clean(c.account_name),
      merchant: clean(c.merchant),
      description: clean(c.description),
      occurred_at: clean(c.occurred_at, 64)
    },
    transactions,
    confidence
  };
}

function localDate(referenceLocalNow: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(referenceLocalNow)
    ? referenceLocalNow.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function classifyFinanceCommand(
  env: Env,
  text: string,
  referenceLocalNow: string
): Promise<FinanceCommand | null> {
  const catalog = await loadFinanceReferenceCatalog(env);
  const schema = buildCommandSchema(categoryEnum(catalog), accountEnum(catalog));
  try {
    const result = await env.AI.run(env.AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: [
            '你是“万象助手”的通用账本命令解析层。只把自然语言转换成通用 FinanceCommand，不得直接执行数据库操作。',
            'action 语义：',
            '- create：新增一笔或多笔账。transactions 必须逐笔给出真实可确定的流水。',
            '- query：查找具体流水，例如“找一下昨天买烟的记录”“刚才那笔是什么”。',
            '- summarize：基于目标流水汇总金额，例如“刚才两笔一共多少”。',
            '- update：修改已有流水，例如“刚才那笔改成支付宝”“金额不是38，是28”。',
            '- delete：撤销/删除已有流水，例如“撤销上一笔”“把刚才两笔删掉”。',
            '- restore：恢复最近撤销的流水，例如“恢复刚才删掉的那笔”。',
            '- passthrough：财务分析、周期比较、与财务无关、或不能可靠判断；交给其他既有链路。',
            '不要为不同句型创造新的 action。把千变万化的人话映射到上述固定动作。',
            'create 规则：一句话中不同事项各自有明确金额时，拆成多条 transactions；不得把不同分类拼成一个 category_name；不得猜分摊金额。',
            '如果用户只给出“烟和抽纸一共28.9”而无法知道各自金额，不要猜；返回 passthrough 或低 confidence。',
            'target.scope：latest=上一笔/刚才那一笔；recent=刚才几笔；today/yesterday；date_range=明确日期范围；matched=按分类/金额/商家/文本等条件匹配。',
            '用户明确说“刚才两笔/最近3笔”时填 count；latest 默认 count=1；未明确数量的 matched 填 count=0。',
            'target 只描述如何寻找真实流水，绝不能编造 transaction id。',
            'changes 只填写用户明确要求修改的字段；未修改字段必须用空字符串或 0。',
            '修改分类/账户时必须使用当前数据库中存在的原子分类/账户。',
            '用户说“撤销/删掉”就是 delete；“恢复/找回刚才删的”就是 restore，不要当成普通聊天。',
            '用户问分析/建议/比较，不在本层处理，返回 passthrough。',
            `参考本地时间：${referenceLocalNow}。用户新增账目未说明时间时，每条 occurred_at 使用这个时间。`,
            financeReferencePrompt(catalog)
          ].join('\n')
        },
        { role: 'user', content: text }
      ],
      response_format: { type: 'json_schema', json_schema: schema }
    });
    const response = (result as { response?: unknown })?.response;
    const parsed = typeof response === 'string' ? JSON.parse(response) : response;
    return validateCommand(parsed);
  } catch (error) {
    console.error('finance command classify failed', error instanceof Error ? error.message : 'unknown error');
    return null;
  }
}

function targetWhere(command: FinanceCommand, referenceLocalNow: string): { clauses: string[]; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const t = command.target;
  const today = localDate(referenceLocalNow);

  if (t.scope === 'today') {
    clauses.push("substr(t.occurred_at, 1, 10) = ?");
    binds.push(today);
  } else if (t.scope === 'yesterday') {
    clauses.push("substr(t.occurred_at, 1, 10) = ?");
    binds.push(addDays(today, -1));
  } else if (t.scope === 'date_range') {
    if (t.from) {
      clauses.push("substr(t.occurred_at, 1, 10) >= ?");
      binds.push(t.from);
    }
    if (t.to) {
      clauses.push("substr(t.occurred_at, 1, 10) <= ?");
      binds.push(t.to);
    }
  }

  if (t.transaction_type) {
    clauses.push('t.type = ?');
    binds.push(t.transaction_type);
  }
  if (t.category_name) {
    clauses.push('c.name = ?');
    binds.push(t.category_name);
  }
  if (t.account_name) {
    clauses.push('a.name = ?');
    binds.push(t.account_name);
  }
  if (t.merchant) {
    clauses.push("COALESCE(t.merchant, '') LIKE ?");
    binds.push(`%${t.merchant}%`);
  }
  if (t.amount > 0) {
    clauses.push('t.amount_fen = ?');
    binds.push(Math.round(t.amount * 100));
  }
  if (t.text) {
    clauses.push("(COALESCE(t.raw_text, '') LIKE ? OR COALESCE(t.description, '') LIKE ? OR COALESCE(t.merchant, '') LIKE ?)");
    const like = `%${t.text}%`;
    binds.push(like, like, like);
  }
  return { clauses, binds };
}

function targetLimit(command: FinanceCommand, probeForAmbiguity: boolean): number {
  if (command.target.scope === 'latest') return 1;
  if (command.target.count > 0) return command.target.count;
  if (probeForAmbiguity) return 21;
  if (command.action === 'summarize') return 100;
  return 10;
}

async function resolveTargets(
  env: Env,
  command: FinanceCommand,
  referenceLocalNow: string,
  probeForAmbiguity = false
): Promise<TransactionRow[]> {
  const { clauses, binds } = targetWhere(command, referenceLocalNow);
  const result = await env.DB.prepare(`
    SELECT
      t.id, t.type, t.amount_fen, t.currency, t.account_id, t.category_id,
      t.merchant, t.description, t.occurred_at, t.source, t.source_id,
      t.raw_text, t.created_at, t.updated_at,
      c.name AS category_name, a.name AS account_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY t.occurred_at DESC, t.created_at DESC, t.id DESC
    LIMIT ?
  `).bind(...binds, targetLimit(command, probeForAmbiguity)).all<TransactionRow>();
  return (result.results || []).map((row) => ({ ...row, amount_fen: Number(row.amount_fen) }));
}

async function snapshotTargets(env: Env, rows: TransactionRow[]): Promise<TransactionSnapshot[]> {
  const snapshots: TransactionSnapshot[] = [];
  for (const row of rows) {
    const items = await env.DB.prepare(`
      SELECT id, transaction_id, name, quantity, unit_price_fen, line_total_fen, category, confidence, created_at
      FROM transaction_items
      WHERE transaction_id = ?
      ORDER BY created_at, id
    `).bind(row.id).all<TransactionItemRow>();
    snapshots.push({ transaction: row, items: items.results || [] });
  }
  return snapshots;
}

function typeLabel(type: TransactionType): string {
  if (type === 'income') return '收入';
  if (type === 'transfer') return '转账';
  return '支出';
}

function rowLine(row: TransactionRow, index?: number): string {
  const prefix = typeof index === 'number' ? `${index + 1}. ` : '';
  const label = row.category_name || row.description || '未指定';
  const account = row.account_name || '未指定';
  return `${prefix}${typeLabel(row.type)} ¥${(row.amount_fen / 100).toFixed(2)} · ${label} · ${account}`;
}

function commandJson(command: FinanceCommand): string {
  return JSON.stringify(command);
}

async function auditStatement(
  env: Env,
  action: 'update' | 'delete' | 'restore',
  source: string,
  sourceId: string,
  command: FinanceCommand,
  targetIds: string[],
  before: unknown,
  after: unknown,
  status: 'applied' | 'rejected' | 'failed' = 'applied'
) {
  return env.DB.prepare(`
    INSERT INTO ledger_operations (
      id, action, source, source_id, command_json, target_ids_json,
      before_json, after_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    crypto.randomUUID(), action, source, sourceId, commandJson(command), JSON.stringify(targetIds),
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    status
  );
}

function sourceIdForIndex(sourceId: string, index: number): string {
  return index === 0 ? sourceId : `${sourceId}#${index + 1}`;
}

async function executeCreate(
  env: Env,
  command: FinanceCommand,
  source: string,
  sourceId: string,
  rawText: string,
  referenceLocalNow: string
): Promise<FinanceCommandResult> {
  if (!command.transactions.length) {
    return { action: 'create', reply: '这句话里有记账意图，但我无法可靠确定每笔金额和用途，因此没有记账。' };
  }
  const existing = await env.DB.prepare(
    'SELECT id FROM transactions WHERE source = ? AND source_id = ? LIMIT 1'
  ).bind(source, sourceId).first<{ id: string }>();
  if (existing) return { action: 'create', reply: '这条消息已经处理过，没有重复记账。' };

  const statements = [];
  const rows: TransactionRow[] = [];
  for (let index = 0; index < command.transactions.length; index += 1) {
    const tx = command.transactions[index];
    const accountId = await resolveAccountId(env, tx.account_name) || await resolveAccountId(env, '未指定');
    const categoryId = await resolveCategoryId(env, tx.category_name, tx.transaction_type);
    if (!accountId || !categoryId) {
      return { action: 'create', reply: `无法将“${tx.category_name || '未指定'} / ${tx.account_name || '未指定'}”映射到当前合法账本分类或账户，因此整条消息没有记账。` };
    }
    const txId = crypto.randomUUID();
    const occurredAt = tx.occurred_at || referenceLocalNow;
    const txSourceId = sourceIdForIndex(sourceId, index);
    statements.push(env.DB.prepare(`
      INSERT INTO transactions (
        id, type, amount_fen, currency, account_id, category_id,
        merchant, description, raw_text, source, source_id, occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      txId,
      tx.transaction_type,
      Math.round(tx.amount * 100),
      tx.currency || 'CNY',
      accountId,
      categoryId,
      tx.merchant || null,
      tx.description || tx.category_name,
      rawText,
      source,
      txSourceId,
      occurredAt
    ));
    rows.push({
      id: txId,
      type: tx.transaction_type,
      amount_fen: Math.round(tx.amount * 100),
      currency: tx.currency || 'CNY',
      account_id: accountId,
      category_id: categoryId,
      merchant: tx.merchant || null,
      description: tx.description || tx.category_name,
      occurred_at: occurredAt,
      source,
      source_id: txSourceId,
      raw_text: rawText,
      created_at: '',
      updated_at: '',
      category_name: tx.category_name,
      account_name: tx.account_name || '未指定'
    });
  }

  await env.DB.batch(statements);
  const total = rows.reduce((sum, row) => sum + row.amount_fen, 0);
  if (rows.length === 1) return { action: 'create', reply: `已记录${rowLine(rows[0]).replace(/^支出 |^收入 |^转账 /, '')}` };
  return {
    action: 'create',
    reply: [`已记录 ${rows.length} 笔，共 ¥${(total / 100).toFixed(2)}：`, ...rows.map((row, index) => rowLine(row, index))].join('\n')
  };
}

async function executeDelete(
  env: Env,
  command: FinanceCommand,
  source: string,
  sourceId: string,
  referenceLocalNow: string
): Promise<FinanceCommandResult> {
  const rows = await resolveTargets(env, command, referenceLocalNow, true);
  if (!rows.length) return { action: 'delete', reply: '没有找到符合条件的账目，没有执行删除。' };
  if (command.target.scope === 'matched' && command.target.count === 0 && rows.length > 1) {
    return { action: 'delete', reply: `找到 ${rows.length > 20 ? '20+' : rows.length} 笔可能匹配的账目。请再说明金额、时间、分类或数量，我不会猜着删除。` };
  }

  const selected = command.target.count > 0 ? rows.slice(0, command.target.count) : rows.slice(0, 1);
  const before = await snapshotTargets(env, selected);
  const statements = selected.map((row) => env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(row.id));
  statements.push(await auditStatement(env, 'delete', source, sourceId, command, selected.map((r) => r.id), before, null));
  await env.DB.batch(statements);

  const total = selected.reduce((sum, row) => sum + row.amount_fen, 0);
  return {
    action: 'delete',
    reply: selected.length === 1
      ? `已撤销：${rowLine(selected[0])}。需要时可以说“恢复刚才删掉的那笔”。`
      : `已撤销 ${selected.length} 笔，共 ¥${(total / 100).toFixed(2)}。需要时可以说“恢复刚才删掉的账目”。`
  };
}

function hasChanges(command: FinanceCommand): boolean {
  const c = command.changes;
  return Boolean(c.transaction_type || c.amount > 0 || c.category_name || c.account_name || c.merchant || c.description || c.occurred_at);
}

async function executeUpdate(
  env: Env,
  command: FinanceCommand,
  source: string,
  sourceId: string,
  referenceLocalNow: string
): Promise<FinanceCommandResult> {
  if (!hasChanges(command)) return { action: 'update', reply: '我理解你想修改账目，但没有识别到具体要改成什么。' };
  const rows = await resolveTargets(env, command, referenceLocalNow, true);
  if (!rows.length) return { action: 'update', reply: '没有找到符合条件的账目，没有执行修改。' };
  if (command.target.scope === 'matched' && command.target.count === 0 && rows.length > 1) {
    return { action: 'update', reply: `找到 ${rows.length > 20 ? '20+' : rows.length} 笔可能匹配的账目。请再说明具体是哪一笔，我不会猜着修改。` };
  }
  const selected = command.target.count > 0 ? rows.slice(0, command.target.count) : rows.slice(0, 1);
  const before = await snapshotTargets(env, selected);
  const statements = [];
  const afterRows: TransactionRow[] = [];

  for (const row of selected) {
    const nextType = command.changes.transaction_type || row.type;
    let nextCategoryId = row.category_id;
    let nextAccountId = row.account_id;
    if (command.changes.category_name) {
      nextCategoryId = await resolveCategoryId(env, command.changes.category_name, nextType);
      if (!nextCategoryId) return { action: 'update', reply: `分类“${command.changes.category_name}”不是当前可用的合法分类，没有修改。` };
    } else if (command.changes.transaction_type && command.changes.transaction_type !== row.type) {
      return { action: 'update', reply: '修改收支类型时必须同时说明新的合法分类，以避免分类与类型不一致。' };
    }
    if (command.changes.account_name) {
      nextAccountId = await resolveAccountId(env, command.changes.account_name);
      if (!nextAccountId) return { action: 'update', reply: `账户“${command.changes.account_name}”不存在，没有修改。` };
    }
    const nextAmountFen = command.changes.amount > 0 ? Math.round(command.changes.amount * 100) : row.amount_fen;
    const nextMerchant = command.changes.merchant || row.merchant;
    const nextDescription = command.changes.description || row.description;
    const nextOccurredAt = command.changes.occurred_at || row.occurred_at;
    statements.push(env.DB.prepare(`
      UPDATE transactions
      SET type = ?, amount_fen = ?, category_id = ?, account_id = ?, merchant = ?, description = ?, occurred_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      nextType,
      nextAmountFen,
      nextCategoryId,
      nextAccountId,
      nextMerchant,
      nextDescription,
      nextOccurredAt,
      row.id
    ));
    afterRows.push({
      ...row,
      type: nextType,
      amount_fen: nextAmountFen,
      category_id: nextCategoryId,
      account_id: nextAccountId,
      merchant: nextMerchant,
      description: nextDescription,
      occurred_at: nextOccurredAt,
      category_name: command.changes.category_name || row.category_name,
      account_name: command.changes.account_name || row.account_name
    });
  }

  statements.push(await auditStatement(env, 'update', source, sourceId, command, selected.map((r) => r.id), before, afterRows));
  await env.DB.batch(statements);
  return {
    action: 'update',
    reply: afterRows.length === 1 ? `已修改：${rowLine(afterRows[0])}` : `已修改 ${afterRows.length} 笔账目。`
  };
}

function parseSnapshots(value: unknown): TransactionSnapshot[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as TransactionSnapshot[] : [];
  } catch {
    return [];
  }
}

async function executeRestore(
  env: Env,
  command: FinanceCommand,
  source: string,
  sourceId: string
): Promise<FinanceCommandResult> {
  const requestedCount = command.target.count > 0 ? command.target.count : 1;
  const ops = await env.DB.prepare(`
    SELECT id, before_json
    FROM ledger_operations
    WHERE action = 'delete' AND status = 'applied'
    ORDER BY created_at DESC, id DESC
    LIMIT 20
  `).all<{ id: string; before_json: string | null }>();

  const candidates: TransactionSnapshot[] = [];
  for (const op of ops.results || []) {
    for (const snap of parseSnapshots(op.before_json)) {
      const exists = await env.DB.prepare('SELECT id FROM transactions WHERE id = ? LIMIT 1').bind(snap.transaction.id).first<{ id: string }>();
      if (!exists) candidates.push(snap);
      if (candidates.length >= requestedCount) break;
    }
    if (candidates.length >= requestedCount) break;
  }
  if (!candidates.length) return { action: 'restore', reply: '没有找到可以恢复的最近删除记录。' };

  const statements = [];
  for (const snap of candidates) {
    const t = snap.transaction;
    statements.push(env.DB.prepare(`
      INSERT INTO transactions (
        id, type, amount_fen, currency, account_id, category_id,
        merchant, description, occurred_at, source, source_id, raw_text,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      t.id, t.type, t.amount_fen, t.currency, t.account_id, t.category_id,
      t.merchant, t.description, t.occurred_at, t.source, t.source_id, t.raw_text,
      t.created_at, t.updated_at
    ));
    for (const item of snap.items || []) {
      statements.push(env.DB.prepare(`
        INSERT INTO transaction_items (
          id, transaction_id, name, quantity, unit_price_fen, line_total_fen, category, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        item.id, item.transaction_id, item.name, item.quantity, item.unit_price_fen,
        item.line_total_fen, item.category, item.confidence, item.created_at
      ));
    }
  }
  statements.push(await auditStatement(env, 'restore', source, sourceId, command, candidates.map((s) => s.transaction.id), null, candidates));
  await env.DB.batch(statements);
  const total = candidates.reduce((sum, snap) => sum + Number(snap.transaction.amount_fen || 0), 0);
  return {
    action: 'restore',
    reply: candidates.length === 1
      ? `已恢复：${rowLine(candidates[0].transaction)}`
      : `已恢复 ${candidates.length} 笔，共 ¥${(total / 100).toFixed(2)}。`
  };
}

async function executeQuery(
  env: Env,
  command: FinanceCommand,
  referenceLocalNow: string,
  summarize: boolean
): Promise<FinanceCommandResult> {
  const rows = await resolveTargets(env, command, referenceLocalNow, false);
  const action = summarize ? 'summarize' : 'query';
  if (!rows.length) return { action, reply: '没有找到符合条件的账目。' };

  if (summarize) {
    const expense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount_fen, 0);
    const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.amount_fen, 0);
    const transfer = rows.filter((r) => r.type === 'transfer').reduce((s, r) => s + r.amount_fen, 0);
    const parts = [`共 ${rows.length} 笔`];
    if (expense) parts.push(`支出 ¥${(expense / 100).toFixed(2)}`);
    if (income) parts.push(`收入 ¥${(income / 100).toFixed(2)}`);
    if (transfer) parts.push(`转账 ¥${(transfer / 100).toFixed(2)}`);
    return { action, reply: parts.join('，') + '。' };
  }

  return {
    action,
    reply: rows.length === 1
      ? rowLine(rows[0])
      : [`找到 ${rows.length} 笔：`, ...rows.slice(0, 10).map((row, index) => rowLine(row, index))].join('\n')
  };
}

export async function handleFinanceCommandTelegram(
  env: Env,
  text: string,
  source: string,
  sourceId: string,
  referenceLocalNow: string
): Promise<FinanceCommandResult | null> {
  const command = await classifyFinanceCommand(env, text, referenceLocalNow);
  if (!command || command.confidence < 0.6 || command.action === 'passthrough') return null;

  if (command.action === 'create') return executeCreate(env, command, source, sourceId, text, referenceLocalNow);
  if (command.action === 'query') return executeQuery(env, command, referenceLocalNow, false);
  if (command.action === 'summarize') return executeQuery(env, command, referenceLocalNow, true);
  if (command.action === 'update') return executeUpdate(env, command, source, sourceId, referenceLocalNow);
  if (command.action === 'delete') return executeDelete(env, command, source, sourceId, referenceLocalNow);
  if (command.action === 'restore') return executeRestore(env, command, source, sourceId);
  return null;
}
