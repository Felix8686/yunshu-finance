import type { D1Like } from '../types';
import { auditV3ReadToolCall } from './auditor';
import { resolveV3TimeScope } from './time';
import type {
  V3GroupDimension,
  V3GroupMetric,
  V3GroupRow,
  V3ReadFilters,
  V3ReadSource,
  V3ReadToolCall,
  V3ReadToolResult,
  V3ResolvedDateRange,
  V3Summary,
  V3TransactionRow
} from './protocol';

interface InternalRow extends V3TransactionRow {
  search_text: string;
}

interface AggregateRow {
  transaction_count?: number | string;
  expense_fen?: number | string;
  income_fen?: number | string;
  transfer_fen?: number | string;
}

interface GroupAggregateRow {
  dimension_key?: string | null;
  metric_value?: number | string;
  transaction_count?: number | string;
}

interface CountRow { count?: number | string }
interface NameRow { id: string; name: string }

function num(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function baseWhere(filters: V3ReadFilters | undefined, range: V3ResolvedDateRange | null): { sql: string; params: unknown[] } {
  const where = ['1 = 1'];
  const params: unknown[] = [];
  if (range) {
    where.push('substr(t.occurred_at, 1, 10) >= ? AND substr(t.occurred_at, 1, 10) < ?');
    params.push(range.from_date, range.to_date);
  }
  if (filters?.types?.length) {
    where.push(`t.type IN (${filters.types.map(() => '?').join(', ')})`);
    params.push(...filters.types);
  }
  if (filters?.categories?.length) {
    where.push(`c.name IN (${filters.categories.map(() => '?').join(', ')})`);
    params.push(...filters.categories);
  }
  if (filters?.accounts?.length) {
    where.push(`a.name IN (${filters.accounts.map(() => '?').join(', ')})`);
    params.push(...filters.accounts);
  }
  if (filters?.merchant?.trim()) {
    where.push(`COALESCE(t.merchant, '') LIKE ?`);
    params.push(`%${filters.merchant.trim()}%`);
  }
  if (typeof filters?.amount_min_fen === 'number') {
    where.push('t.amount_fen >= ?');
    params.push(filters.amount_min_fen);
  }
  if (typeof filters?.amount_max_fen === 'number') {
    where.push('t.amount_fen <= ?');
    params.push(filters.amount_max_fen);
  }
  return { sql: where.join(' AND '), params };
}

function selectColumns(): string {
  return `t.id, t.type, t.amount_fen, t.occurred_at,
          c.name AS category, a.name AS account,
          t.merchant, t.description`;
}

function toRow(row: Record<string, unknown>): V3TransactionRow {
  return {
    id: String(row.id || ''),
    type: String(row.type || 'expense') as V3TransactionRow['type'],
    amount_fen: num(row.amount_fen),
    occurred_at: String(row.occurred_at || ''),
    category: row.category === null || row.category === undefined ? null : String(row.category),
    account: row.account === null || row.account === undefined ? null : String(row.account),
    merchant: row.merchant === null || row.merchant === undefined ? null : String(row.merchant),
    description: row.description === null || row.description === undefined ? null : String(row.description)
  };
}

function summaryFromAggregate(row: AggregateRow | null): V3Summary {
  const expense = num(row?.expense_fen);
  const income = num(row?.income_fen);
  return {
    transaction_count: num(row?.transaction_count),
    expense_fen: expense,
    income_fen: income,
    transfer_fen: num(row?.transfer_fen),
    net_fen: income - expense
  };
}

function summaryFromRows(rows: InternalRow[]): V3Summary {
  let expense = 0;
  let income = 0;
  let transfer = 0;
  for (const row of rows) {
    if (row.type === 'expense') expense += row.amount_fen;
    else if (row.type === 'income') income += row.amount_fen;
    else transfer += row.amount_fen;
  }
  return {
    transaction_count: rows.length,
    expense_fen: expense,
    income_fen: income,
    transfer_fen: transfer,
    net_fen: income - expense
  };
}

async function ledgerSummary(db: D1Like, filters: V3ReadFilters | undefined, range: V3ResolvedDateRange | null): Promise<V3Summary> {
  const where = baseWhere(filters, range);
  const row = await db.prepare(
    `SELECT COUNT(*) AS transaction_count,
            COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_fen ELSE 0 END), 0) AS expense_fen,
            COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_fen ELSE 0 END), 0) AS income_fen,
            COALESCE(SUM(CASE WHEN t.type = 'transfer' THEN t.amount_fen ELSE 0 END), 0) AS transfer_fen
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE ${where.sql}`
  ).bind(...where.params).first<AggregateRow>();
  return summaryFromAggregate(row);
}

function groupExpression(dimension: V3GroupDimension): string {
  if (dimension === 'date') return 'substr(t.occurred_at, 1, 10)';
  if (dimension === 'category') return `COALESCE(c.name, '未分类')`;
  if (dimension === 'account') return `COALESCE(a.name, '未指定')`;
  return `COALESCE(t.merchant, '未识别商家')`;
}

function metricExpression(metric: V3GroupMetric): string {
  if (metric === 'count') return 'COUNT(*)';
  if (metric === 'net') {
    return `COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_fen WHEN t.type = 'expense' THEN -t.amount_fen ELSE 0 END), 0)`;
  }
  return 'COALESCE(SUM(t.amount_fen), 0)';
}

async function ledgerGroups(
  db: D1Like,
  filters: V3ReadFilters | undefined,
  range: V3ResolvedDateRange | null,
  dimension: V3GroupDimension,
  metric: V3GroupMetric,
  limit: number
): Promise<V3GroupRow[]> {
  const where = baseWhere(filters, range);
  const dim = groupExpression(dimension);
  const rows = await db.prepare(
    `SELECT ${dim} AS dimension_key,
            ${metricExpression(metric)} AS metric_value,
            COUNT(*) AS transaction_count
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE ${where.sql}
      GROUP BY ${dim}
      ORDER BY metric_value DESC, dimension_key ASC
      LIMIT ?`
  ).bind(...where.params, limit).all<GroupAggregateRow>();
  return (rows.results || []).map((row) => ({
    key: row.dimension_key || '未分类',
    value: num(row.metric_value),
    transaction_count: num(row.transaction_count)
  }));
}

async function ledgerCount(db: D1Like, filters: V3ReadFilters | undefined, range: V3ResolvedDateRange | null, query?: string): Promise<number> {
  const where = baseWhere(filters, range);
  if (query !== undefined) {
    const like = `%${query}%`;
    where.sql += ` AND (
      COALESCE(t.description, '') LIKE ? OR COALESCE(t.merchant, '') LIKE ?
      OR COALESCE(c.name, '') LIKE ? OR COALESCE(a.name, '') LIKE ?
      OR EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transaction_id = t.id AND COALESCE(ti.name, '') LIKE ?)
    )`;
    where.params.push(like, like, like, like, like);
  }
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE ${where.sql}`
  ).bind(...where.params).first<CountRow>();
  return num(row?.count);
}

async function ledgerRows(
  db: D1Like,
  filters: V3ReadFilters | undefined,
  range: V3ResolvedDateRange | null,
  options: { limit: number; orderField: 'occurred_at' | 'amount_fen'; orderDirection: 'asc' | 'desc'; search?: string }
): Promise<V3TransactionRow[]> {
  const where = baseWhere(filters, range);
  if (options.search !== undefined) {
    const like = `%${options.search}%`;
    where.sql += ` AND (
      COALESCE(t.description, '') LIKE ? OR COALESCE(t.merchant, '') LIKE ?
      OR COALESCE(c.name, '') LIKE ? OR COALESCE(a.name, '') LIKE ?
      OR EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transaction_id = t.id AND COALESCE(ti.name, '') LIKE ?)
    )`;
    where.params.push(like, like, like, like, like);
  }
  const sort = options.orderField === 'amount_fen' ? 't.amount_fen' : 't.occurred_at';
  const direction = options.orderDirection === 'asc' ? 'ASC' : 'DESC';
  const rows = await db.prepare(
    `SELECT ${selectColumns()}
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE ${where.sql}
      ORDER BY ${sort} ${direction}, t.id ASC
      LIMIT ?`
  ).bind(...where.params, options.limit).all<Record<string, unknown>>();
  return (rows.results || []).map(toRow);
}

async function resolveResultSetId(db: D1Like, source: Exclude<V3ReadSource, { kind: 'ledger' }>): Promise<string> {
  if (source.kind === 'result_set') return source.result_set_id;
  if (source.kind === 'active_result_set') {
    const row = await db.prepare(
      `SELECT active_result_set_id AS id FROM finance_sessions
        WHERE ledger_scope_id = 'personal:primary' AND session_key = ?`
    ).bind(source.session_key).first<{ id?: string | null }>();
    if (!row?.id) throw new Error('ACTIVE_RESULT_SET_NOT_FOUND');
    return row.id;
  }
  const row = await db.prepare(
    `SELECT entity_id AS id FROM finance_session_references
      WHERE ledger_scope_id = 'personal:primary' AND session_key = ? AND reference_kind = 'active_result_set'
      ORDER BY created_at DESC, reference_id DESC LIMIT 1 OFFSET 1`
  ).bind(source.session_key).first<{ id?: string | null }>();
  if (!row?.id) throw new Error('PREVIOUS_RESULT_SET_NOT_FOUND');
  return row.id;
}

async function namesById(db: D1Like, table: 'categories' | 'accounts', ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.prepare(
    `SELECT id, name FROM ${table} WHERE id IN (${unique.map(() => '?').join(', ')})`
  ).bind(...unique).all<NameRow>();
  return new Map((rows.results || []).map((row) => [row.id, row.name]));
}

async function resultSetRows(db: D1Like, source: Exclude<V3ReadSource, { kind: 'ledger' }>): Promise<{ resultSetId: string; rows: InternalRow[] }> {
  const resultSetId = await resolveResultSetId(db, source);
  const sessionKey = source.kind === 'result_set' ? source.session_key : source.session_key;
  const params: unknown[] = [resultSetId];
  let sessionClause = '';
  if (sessionKey) {
    sessionClause = ' AND rs.session_key = ?';
    params.push(sessionKey);
  }
  const result = await db.prepare(
    `SELECT i.row_snapshot_json
       FROM finance_result_set_items i
       JOIN finance_result_sets rs ON rs.result_set_id = i.result_set_id
      WHERE i.result_set_id = ?${sessionClause}
      ORDER BY i.ordinal ASC`
  ).bind(...params).all<{ row_snapshot_json: string }>();

  const snapshots = (result.results || []).map((row) => JSON.parse(row.row_snapshot_json) as Record<string, unknown>);
  const categoryMap = await namesById(db, 'categories', snapshots.map((row) => String(row.category_id || '')).filter(Boolean));
  const accountMap = await namesById(db, 'accounts', snapshots.map((row) => String(row.account_id || '')).filter(Boolean));

  const rows: InternalRow[] = snapshots
    .filter((row) => row.id && row.type && row.amount_fen !== undefined && row.occurred_at)
    .map((row) => {
      const categoryId = row.category_id ? String(row.category_id) : '';
      const accountId = row.account_id ? String(row.account_id) : '';
      const items = Array.isArray(row.items) ? row.items as Array<Record<string, unknown>> : [];
      const category = categoryId ? categoryMap.get(categoryId) || null : null;
      const account = accountId ? accountMap.get(accountId) || null : null;
      const merchant = row.merchant === null || row.merchant === undefined ? null : String(row.merchant);
      const description = row.description === null || row.description === undefined ? null : String(row.description);
      return {
        id: String(row.id),
        type: String(row.type) as InternalRow['type'],
        amount_fen: num(row.amount_fen),
        occurred_at: String(row.occurred_at),
        category,
        account,
        merchant,
        description,
        search_text: [description, merchant, category, account, ...items.map((item) => item.name ? String(item.name) : '')].filter(Boolean).join('\n')
      };
    });
  return { resultSetId, rows };
}

function rowMatches(row: InternalRow, filters: V3ReadFilters | undefined, range: V3ResolvedDateRange | null): boolean {
  const date = row.occurred_at.slice(0, 10);
  if (range && (date < range.from_date || date >= range.to_date)) return false;
  if (filters?.types?.length && !filters.types.includes(row.type)) return false;
  if (filters?.categories?.length && !filters.categories.includes(row.category || '')) return false;
  if (filters?.accounts?.length && !filters.accounts.includes(row.account || '')) return false;
  if (filters?.merchant?.trim() && !(row.merchant || '').includes(filters.merchant.trim())) return false;
  if (typeof filters?.amount_min_fen === 'number' && row.amount_fen < filters.amount_min_fen) return false;
  if (typeof filters?.amount_max_fen === 'number' && row.amount_fen > filters.amount_max_fen) return false;
  return true;
}

function filterResultRows(rows: InternalRow[], filters: V3ReadFilters | undefined, range: V3ResolvedDateRange | null): InternalRow[] {
  return rows.filter((row) => rowMatches(row, filters, range));
}

function sortRows(rows: InternalRow[], field: 'occurred_at' | 'amount_fen', direction: 'asc' | 'desc'): InternalRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = field === 'amount_fen' ? a.amount_fen : a.occurred_at;
    const bv = field === 'amount_fen' ? b.amount_fen : b.occurred_at;
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return a.id.localeCompare(b.id);
  });
}

function publicRows(rows: InternalRow[]): V3TransactionRow[] {
  return rows.map(({ search_text: _search, ...row }) => row);
}

function resultGroups(rows: InternalRow[], dimension: V3GroupDimension, metric: V3GroupMetric, limit: number): V3GroupRow[] {
  const grouped = new Map<string, { value: number; count: number }>();
  for (const row of rows) {
    const key = dimension === 'date'
      ? row.occurred_at.slice(0, 10)
      : dimension === 'category'
        ? row.category || '未分类'
        : dimension === 'account'
          ? row.account || '未指定'
          : row.merchant || '未识别商家';
    const current = grouped.get(key) || { value: 0, count: 0 };
    current.count += 1;
    if (metric === 'count') current.value += 1;
    else if (metric === 'net') current.value += row.type === 'income' ? row.amount_fen : row.type === 'expense' ? -row.amount_fen : 0;
    else current.value += row.amount_fen;
    grouped.set(key, current);
  }
  return [...grouped.entries()]
    .map(([key, value]) => ({ key, value: value.value, transaction_count: value.count }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
    .slice(0, limit);
}

async function sourceRows(
  db: D1Like,
  source: V3ReadSource,
  filters: V3ReadFilters | undefined,
  range: V3ResolvedDateRange | null
): Promise<{ resultSetId: string | null; rows: InternalRow[] }> {
  if (source.kind === 'ledger') throw new Error('LEDGER_ROWS_REQUIRE_SQL_PATH');
  const loaded = await resultSetRows(db, source);
  return { resultSetId: loaded.resultSetId, rows: filterResultRows(loaded.rows, filters, range) };
}

export async function executeV3ReadTool(db: D1Like, call: V3ReadToolCall, eventTime: string): Promise<V3ReadToolResult> {
  auditV3ReadToolCall(call);

  if (call.tool === 'get_transaction') {
    const row = await db.prepare(
      `SELECT ${selectColumns()}
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.id = ? LIMIT 1`
    ).bind(call.transaction_id).first<Record<string, unknown>>();
    return { tool: 'get_transaction', row: row ? toRow(row) : null };
  }

  if (call.tool === 'describe_result_set') {
    const loaded = await resultSetRows(db, call.source);
    const summary = summaryFromRows(loaded.rows);
    const sortedDates = sortRows(loaded.rows, 'occurred_at', 'asc');
    const sortedAmounts = sortRows(loaded.rows, 'amount_fen', 'asc');
    return {
      tool: 'describe_result_set',
      description: {
        result_set_id: loaded.resultSetId,
        ...summary,
        earliest_date: sortedDates[0]?.occurred_at.slice(0, 10) || null,
        latest_date: sortedDates.at(-1)?.occurred_at.slice(0, 10) || null,
        min_amount_fen: sortedAmounts[0]?.amount_fen ?? null,
        max_amount_fen: sortedAmounts.at(-1)?.amount_fen ?? null
      }
    };
  }

  const range = resolveV3TimeScope('scope' in call ? call.scope : null, eventTime);

  if (call.tool === 'compare_periods') {
    const leftRange = resolveV3TimeScope(call.left, eventTime);
    const rightRange = resolveV3TimeScope(call.right, eventTime);
    if (!leftRange || !rightRange) throw new Error('COMPARE_RANGE_REQUIRED');
    const left = await ledgerSummary(db, call.filters, leftRange);
    const right = await ledgerSummary(db, call.filters, rightRange);
    return { tool: 'compare_periods', left, right, delta_net_fen: left.net_fen - right.net_fen, left_range: leftRange, right_range: rightRange };
  }

  if (call.source.kind === 'ledger') {
    if (call.tool === 'summarize_transactions') {
      return { tool: 'summarize_transactions', summary: await ledgerSummary(db, call.filters, range), range };
    }
    if (call.tool === 'group_transactions') {
      return {
        tool: 'group_transactions',
        groups: await ledgerGroups(db, call.filters, range, call.dimension, call.metric, call.limit || 20),
        summary: await ledgerSummary(db, call.filters, range),
        range
      };
    }
    if (call.tool === 'get_extrema') {
      const rows = await ledgerRows(db, call.filters, range, {
        limit: 1,
        orderField: call.field,
        orderDirection: call.direction === 'min' ? 'asc' : 'desc'
      });
      return { tool: 'get_extrema', row: rows[0] || null, range };
    }
    if (call.tool === 'search_transactions') {
      const query = call.query.trim();
      const rows = await ledgerRows(db, call.filters, range, { limit: call.limit || 20, orderField: 'occurred_at', orderDirection: 'desc', search: query });
      return { tool: 'search_transactions', rows, total_matching: await ledgerCount(db, call.filters, range, query), range };
    }
    const order = call.order_by || { field: 'occurred_at' as const, direction: 'desc' as const };
    const rows = await ledgerRows(db, call.filters, range, { limit: call.limit || 20, orderField: order.field, orderDirection: order.direction });
    return { tool: 'find_transactions', rows, total_matching: await ledgerCount(db, call.filters, range), range };
  }

  const loaded = await sourceRows(db, call.source, 'filters' in call ? call.filters : undefined, range);

  if (call.tool === 'summarize_transactions') {
    return { tool: 'summarize_transactions', summary: summaryFromRows(loaded.rows), range };
  }
  if (call.tool === 'group_transactions') {
    return { tool: 'group_transactions', groups: resultGroups(loaded.rows, call.dimension, call.metric, call.limit || 20), summary: summaryFromRows(loaded.rows), range };
  }
  if (call.tool === 'get_extrema') {
    const row = sortRows(loaded.rows, call.field, call.direction === 'min' ? 'asc' : 'desc')[0] || null;
    return { tool: 'get_extrema', row: row ? publicRows([row])[0] : null, range };
  }
  if (call.tool === 'search_transactions') {
    const needle = call.query.trim().toLocaleLowerCase();
    const matched = loaded.rows.filter((row) => row.search_text.toLocaleLowerCase().includes(needle));
    return { tool: 'search_transactions', rows: publicRows(matched.slice(0, call.limit || 20)), total_matching: matched.length, range };
  }
  const order = call.order_by || { field: 'occurred_at' as const, direction: 'desc' as const };
  const ordered = sortRows(loaded.rows, order.field, order.direction);
  return { tool: 'find_transactions', rows: publicRows(ordered.slice(0, call.limit || 20)), total_matching: ordered.length, range };
}
