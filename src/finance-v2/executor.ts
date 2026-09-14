import { resolveAccountId, resolveCategoryId } from '../finance-reference';
import type { Env, D1StatementLike } from '../types';
import {
  canonicalizeJson,
  sha256Hex,
  type CreatePlan,
  type FinanceFilters,
  type FinanceOperationRecord,
  type FinancePlan,
  type FinancePresentation,
  type FinanceResult,
  type FinanceResultRow,
  type FinanceSummary,
  type FinancePage,
  type QueryPlan,
  type ReceiptCreatePlan,
  type ReferenceSpec,
  type ResultSetSnapshot,
  type TemporalScope,
  type TransactionSnapshot
} from './protocol';
import { buildResultSetSnapshot, createPageToken, resultSetWindow, verifyPageToken } from './result-set';
import { buildResultSetStatements, loadResultSetSnapshot } from './persistence';
import { MAX_ANALYSIS_DIMENSIONS, MAX_D1_BATCH_STATEMENTS, MAX_MUTATION_TARGETS } from './capacity';

interface TransactionRow {
  id: string;
  type: 'expense' | 'income' | 'transfer';
  amount_fen: number;
  currency: 'CNY';
  account_id: string | null;
  category_id: string | null;
  merchant: string | null;
  description: string | null;
  occurred_at: string;
  account_name: string | null;
  category_name: string | null;
}

interface TransactionItemRow {
  id: string;
  transaction_id: string;
  name: string;
  quantity: number;
  unit_price_fen: number | null;
  line_total_fen: number;
  category: string;
}

export interface ExecutionDraft {
  result: FinanceResult;
  presentation: FinancePresentation;
  side_effect_statements: D1StatementLike[];
  outbox_rows: Array<{
    outbox_id: string;
    delivery_request_id: string;
    part_index: number;
    destination_id: string;
    thread_id?: string | null;
  }>;
  result_set_id?: string | null;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function operationFence(operation: FinanceOperationRecord): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM finance_operations op
       JOIN finance_runtime_control ctl ON ctl.control_id = 'primary'
      WHERE op.operation_id = ?
        AND op.status = 'executing'
        AND op.lease_owner = ?
        AND op.lease_epoch = ?
        AND op.route_epoch = ?
        AND ctl.config_epoch = op.route_epoch
        AND (
          (op.operation_type = 'receipt_create' AND ctl.receipt_route_mode = 'v2')
          OR
          (op.operation_type <> 'receipt_create' AND ctl.finance_route_mode IN ('canary_v2', 'primary_v2'))
        )
    )`,
    params: [operation.operation_id, operation.lease_owner, operation.lease_epoch, operation.route_epoch]
  };
}

function assertUnchangedEntity(env: Env, row: TransactionRow, items: TransactionItemRow[]): D1StatementLike {
  // Compare the exact state read during planning inside the commit batch.
  // Session CAS alone does not protect writes from different sessions.
  return env.DB.prepare(`UPDATE transactions SET id = id
    WHERE id = ? AND type IS ? AND amount_fen IS ? AND currency IS ?
      AND account_id IS ? AND category_id IS ? AND merchant IS ?
      AND description IS ? AND occurred_at IS ?
      AND (SELECT count(*) FROM transaction_items WHERE transaction_id = transactions.id) = ?
      AND NOT EXISTS (
        SELECT 1 FROM transaction_items i WHERE i.transaction_id = transactions.id
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) e
          WHERE i.id IS json_extract(e.value, '$.id')
            AND i.name IS json_extract(e.value, '$.name')
            AND i.quantity IS json_extract(e.value, '$.quantity')
            AND i.unit_price_fen IS json_extract(e.value, '$.unit_price_fen')
            AND i.line_total_fen IS json_extract(e.value, '$.line_total_fen')
            AND i.category IS json_extract(e.value, '$.category')
        )
      )`).bind(row.id, row.type, row.amount_fen, row.currency, row.account_id, row.category_id,
        row.merchant, row.description, row.occurred_at, items.length, canonicalizeJson(items));
}

async function loadItems(env: Env, transactionIds: string[]): Promise<Map<string, TransactionItemRow[]>> {
  const grouped = new Map<string, TransactionItemRow[]>();
  for (let offset = 0; offset < transactionIds.length; offset += 90) {
    const ids = transactionIds.slice(offset, offset + 90);
    if (!ids.length) continue;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await env.DB.prepare(
      `SELECT id, transaction_id, name, quantity, unit_price_fen, line_total_fen, category
         FROM transaction_items
        WHERE transaction_id IN (${placeholders})
        ORDER BY transaction_id, id`
    ).bind(...ids).all<TransactionItemRow>();
    for (const row of rows.results || []) {
      const list = grouped.get(row.transaction_id) || [];
      list.push(row);
      grouped.set(row.transaction_id, list);
    }
  }
  return grouped;
}

async function queryTransactions(
  env: Env,
  filters: FinanceFilters,
  temporalScope: TemporalScope | null | undefined,
  presentation?: FinancePresentation
): Promise<{ rows: TransactionRow[]; items: Map<string, TransactionItemRow[]> }> {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (temporalScope) {
    where.push('t.occurred_at >= ? AND t.occurred_at < ?');
    params.push(temporalScope.from, temporalScope.to);
  }
  if (filters.types?.length) {
    where.push(`t.type IN (${filters.types.map(() => '?').join(', ')})`);
    params.push(...filters.types);
  }
  if (filters.categories?.length) {
    where.push(`c.name IN (${filters.categories.map(() => '?').join(', ')})`);
    params.push(...filters.categories.map((item) => item.value));
  }
  if (filters.accounts?.length) {
    where.push(`a.name IN (${filters.accounts.map(() => '?').join(', ')})`);
    params.push(...filters.accounts.map((item) => item.value));
  }
  if (filters.merchant_text) {
    where.push('COALESCE(t.merchant, \'\') LIKE ?');
    params.push(`%${filters.merchant_text}%`);
  }
  if (filters.semantic_text) {
    const semanticLike = `%${filters.semantic_text}%`;
    where.push(`(
      COALESCE(t.description, '') LIKE ?
      OR COALESCE(t.merchant, '') LIKE ?
      OR COALESCE(c.name, '') LIKE ?
      OR EXISTS (
        SELECT 1 FROM transaction_items semantic_item
         WHERE semantic_item.transaction_id = t.id
           AND (COALESCE(semantic_item.name, '') LIKE ? OR COALESCE(semantic_item.category, '') LIKE ?)
      )
    )`);
    params.push(semanticLike, semanticLike, semanticLike, semanticLike, semanticLike);
  }
  if (filters.amount_min_fen !== undefined && filters.amount_min_fen !== null) {
    where.push('t.amount_fen >= ?');
    params.push(filters.amount_min_fen);
  }
  if (filters.amount_max_fen !== undefined && filters.amount_max_fen !== null) {
    where.push('t.amount_fen <= ?');
    params.push(filters.amount_max_fen);
  }
  const sortColumn = presentation?.sort_field === 'amount'
    ? 't.amount_fen'
    : presentation?.sort_field === 'item'
      ? 'COALESCE(t.description, \'\')'
      : presentation?.sort_field === 'category'
        ? 'COALESCE(c.name, \'\')'
        : presentation?.sort_field === 'account'
          ? 'COALESCE(a.name, \'\')'
          : 't.occurred_at';
  const sortDirection = presentation?.sort_direction === 'asc' ? 'ASC' : 'DESC';
  const rows = await env.DB.prepare(
    `SELECT t.id, t.type, t.amount_fen, t.currency, t.account_id, t.category_id,
            t.merchant, t.description, t.occurred_at,
            a.name AS account_name, c.name AS category_name
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${sortColumn} ${sortDirection}, t.occurred_at DESC, t.id DESC
      LIMIT 200`
  ).bind(...params).all<TransactionRow>();
  const normalized = rows.results || [];
  return { rows: normalized, items: await loadItems(env, normalized.map((row) => row.id)) };
}

async function loadTransactionsByIds(env: Env, ids: string[]): Promise<{ rows: TransactionRow[]; items: Map<string, TransactionItemRow[]> }> {
  if (!ids.length) return { rows: [], items: new Map() };
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT t.id, t.type, t.amount_fen, t.currency, t.account_id, t.category_id,
            t.merchant, t.description, t.occurred_at,
            a.name AS account_name, c.name AS category_name
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.id IN (${placeholders})
      ORDER BY t.occurred_at DESC, t.id DESC`
  ).bind(...ids).all<TransactionRow>();
  const normalized = rows.results || [];
  return { rows: normalized, items: await loadItems(env, normalized.map((row) => row.id)) };
}

async function loadSnapshotReferencedTransactions(
  env: Env,
  references: Array<{ entity_id: string; entity_fingerprint: string }>
): Promise<{ rows: TransactionRow[]; items: Map<string, TransactionItemRow[]> }> {
  const selected = await loadTransactionsByIds(env, references.map((item) => item.entity_id));
  const byId = new Map(selected.rows.map((row) => [row.id, row]));
  for (const reference of references) {
    const row = byId.get(reference.entity_id);
    if (!row) throw new Error('STALE_REFERENCE');
    const snapshot = transactionSnapshot(row, selected.items);
    if (await sha256Hex(canonicalizeJson(snapshot)) !== reference.entity_fingerprint) throw new Error('STALE_REFERENCE');
  }
  return selected;
}

function transactionSnapshot(row: TransactionRow, items: Map<string, TransactionItemRow[]>): TransactionSnapshot {
  return {
    id: row.id,
    type: row.type,
    amount_fen: row.amount_fen,
    currency: row.currency,
    occurred_at: row.occurred_at,
    account_id: row.account_id,
    category_id: row.category_id,
    merchant: row.merchant,
    description: row.description,
    items: (items.get(row.id) || []).map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unit_price_fen: item.unit_price_fen,
      line_total_fen: item.line_total_fen,
      category: item.category
    }))
  };
}

async function resultRows(rows: TransactionRow[], items: Map<string, TransactionItemRow[]>): Promise<FinanceResultRow[]> {
  const output: FinanceResultRow[] = [];
  for (const row of rows) {
    const snapshot = transactionSnapshot(row, items);
    output.push({
      entity_type: 'transaction',
      entity_id: row.id,
      entity_fingerprint: await sha256Hex(canonicalizeJson(snapshot)),
      snapshot
    });
  }
  return output;
}

function summary(rows: TransactionRow[]): FinanceSummary {
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

function baseResult(plan: FinancePlan, operation: FinanceResult['operation']): Record<string, unknown> {
  return {
    schema_version: 2,
    kind: 'success',
    result_id: id('result'),
    turn_id: plan.source_turn_id,
    operation,
    ledger_scope_id: 'personal:primary',
    commit_status: operation === 'query' || operation === 'summarize' || operation === 'analyze' || operation === 'compare'
      ? 'not_required'
      : 'committed',
    render_hash: '0'.repeat(64)
  };
}

function dimensionValue(row: TransactionRow, dimension: string): string {
  if (dimension === 'date') return row.occurred_at.slice(0, 10);
  if (dimension === 'category') return row.category_name || '未分类';
  if (dimension === 'account') return row.account_name || '未指定';
  if (dimension === 'merchant') return row.merchant || '未识别商家';
  return 'all';
}

function metricValue(row: TransactionRow, metric: string): number {
  if (metric === 'count') return 1;
  if (metric === 'income') return row.type === 'income' ? row.amount_fen : 0;
  if (metric === 'net') return row.type === 'income' ? row.amount_fen : row.type === 'expense' ? -row.amount_fen : 0;
  return row.type === 'expense' ? row.amount_fen : 0;
}

function analysisDimensions(rows: TransactionRow[], metric: string, dimension: string): Array<{ key: string; value_fen: number; count: number }> {
  const map = new Map<string, { value_fen: number; count: number }>();
  for (const row of rows) {
    const key = dimensionValue(row, dimension);
    const current = map.get(key) || { value_fen: 0, count: 0 };
    current.value_fen += metricValue(row, metric);
    current.count += 1;
    map.set(key, current);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].value_fen - a[1].value_fen || a[0].localeCompare(b[0]))
    .slice(0, MAX_ANALYSIS_DIMENSIONS)
    .map(([key, value]) => ({ key, ...value }));
}

function summaryMetric(value: FinanceSummary, metric: string): number {
  if (metric === 'count') return value.transaction_count;
  if (metric === 'income') return value.income_fen;
  if (metric === 'net') return value.net_fen;
  return value.expense_fen;
}

async function resolveReferenceWindow(
  env: Env,
  reference: ReferenceSpec,
  sessionKey: string
): Promise<{ snapshot: ResultSetSnapshot; start: number; pageSize: number }> {
  if (reference.kind === 'result_ordinal' || reference.kind === 'result_window') {
    const snapshot = await loadResultSetSnapshot(env.DB, reference.result_set_id, 'personal:primary', sessionKey);
    if (!snapshot) throw new Error('EXPIRED_REFERENCE');
    if (reference.kind === 'result_ordinal') return { snapshot, start: reference.ordinal, pageSize: 1 };
    if (reference.result_set_version !== snapshot.result_set_version) throw new Error('EXPIRED_REFERENCE');
    if (reference.window_end_ordinal < reference.window_start_ordinal) throw new Error('EXPIRED_REFERENCE');
    return {
      snapshot,
      start: reference.window_start_ordinal,
      pageSize: Math.min(20, reference.window_end_ordinal - reference.window_start_ordinal + 1)
    };
  }
  if (reference.kind !== 'session_semantic') throw new Error('REFERENCE_NOT_SUPPORTED');
  const session = await env.DB.prepare(
    `SELECT active_result_set_id, active_window_start_ordinal, active_window_end_ordinal,
            previous_window_start_ordinal, previous_window_end_ordinal
       FROM finance_sessions
      WHERE ledger_scope_id = 'personal:primary' AND session_key = ?`
  ).bind(sessionKey).first<{
    active_result_set_id: string | null;
    active_window_start_ordinal: number | null;
    active_window_end_ordinal: number | null;
    previous_window_start_ordinal: number | null;
    previous_window_end_ordinal: number | null;
  }>();
  if (!session?.active_result_set_id) throw new Error('EXPIRED_REFERENCE');
  let resultSetId = session.active_result_set_id;
  let start = 1;
  let pageSize = 20;
  if (reference.semantic_key === 'active_window' || reference.semantic_key === 'previous_window') {
    const usePrevious = reference.semantic_key === 'previous_window';
    start = (usePrevious ? session.previous_window_start_ordinal : session.active_window_start_ordinal) || 1;
    const end = usePrevious ? session.previous_window_end_ordinal : session.active_window_end_ordinal;
    pageSize = end ? Math.max(1, Math.min(20, end - start + 1)) : 20;
    if (usePrevious) {
      const previous = await env.DB.prepare(
        `SELECT entity_id FROM finance_session_references
          WHERE ledger_scope_id = 'personal:primary' AND session_key = ?
            AND reference_kind = 'active_result_set'
          ORDER BY created_at DESC, reference_id DESC LIMIT 1 OFFSET 1`
      ).bind(sessionKey).first<{ entity_id: string }>();
      if (!previous) throw new Error('EXPIRED_REFERENCE');
      resultSetId = previous.entity_id;
    }
  } else if (reference.semantic_key === 'previous_result_set') {
    const previous = await env.DB.prepare(
      `SELECT entity_id FROM finance_session_references
        WHERE ledger_scope_id = 'personal:primary' AND session_key = ?
          AND reference_kind = 'active_result_set'
        ORDER BY created_at DESC, reference_id DESC LIMIT 1 OFFSET 1`
    ).bind(sessionKey).first<{ entity_id: string }>();
    if (!previous) throw new Error('EXPIRED_REFERENCE');
    resultSetId = previous.entity_id;
  }
  const snapshot = await loadResultSetSnapshot(env.DB, resultSetId, 'personal:primary', sessionKey);
  if (!snapshot) throw new Error('EXPIRED_REFERENCE');
  return { snapshot, start, pageSize: reference.semantic_key === 'active_result_set' || reference.semantic_key === 'previous_result_set' ? snapshot.page_size : pageSize };
}

async function buildReferencedReadDraft(
  env: Env,
  plan: QueryPlan | Extract<FinancePlan, { operation: 'summarize' | 'analyze' | 'compare' }>,
  operation: FinanceOperationRecord,
  reference: ReferenceSpec
): Promise<ExecutionDraft> {
  if (plan.operation === 'analyze' || plan.operation === 'compare') throw new Error('REFERENCE_NOT_SUPPORTED');
  const resolved = await resolveReferenceWindow(env, reference, operation.session_key);
  const window = resultSetWindow(resolved.snapshot, resolved.start, resolved.pageSize);
  const secret = env.FINANCE_PAGE_TOKEN_SECRET?.trim();
  const page: FinancePage = {
    result_set_id: resolved.snapshot.result_set_id,
    result_set_version: resolved.snapshot.result_set_version,
    start_ordinal: window.start_ordinal,
    end_ordinal: window.end_ordinal,
    page_size: resolved.pageSize,
    has_previous: window.has_previous,
    has_next: window.has_next,
    next_page_token: window.has_next && secret
      ? await createPageToken(secret, {
          schema_version: 2,
          ledger_scope_id: 'personal:primary',
          session_key: operation.session_key,
          result_set_id: resolved.snapshot.result_set_id,
          result_set_version: resolved.snapshot.result_set_version,
          next_start_ordinal: window.end_ordinal + 1,
          page_size: resolved.pageSize,
          expires_at: resolved.snapshot.expires_at
        })
      : null
  };
  if (window.has_next && !page.next_page_token) throw new Error('PAGE_TOKEN_SECRET_NOT_CONFIGURED');
  const rows = window.items.map((item) => ({
    entity_type: item.entity_type as FinanceResultRow['entity_type'],
    entity_id: item.entity_id,
    entity_fingerprint: item.entity_fingerprint,
    snapshot: JSON.parse(item.row_snapshot_json)
  }));
  const result = {
    ...baseResult(plan, plan.operation),
    result_set_id: resolved.snapshot.result_set_id,
    ...(plan.operation === 'summarize' ? {} : { rows }),
    summary: summaryFromSnapshots(window.items),
    page
  } as unknown as FinanceResult;
  return {
    result,
    presentation: plan.presentation,
    side_effect_statements: [],
    outbox_rows: [],
    result_set_id: resolved.snapshot.result_set_id
  };
}

async function buildReadDraft(env: Env, plan: QueryPlan | Extract<FinancePlan, { operation: 'summarize' | 'analyze' | 'compare' }>, operation: FinanceOperationRecord): Promise<ExecutionDraft> {
  if (plan.reference) return buildReferencedReadDraft(env, plan, operation, plan.reference);
  if (plan.presentation.page_token) {
    if (plan.operation !== 'query' && plan.operation !== 'summarize') throw new Error('PAGE_TOKEN_UNSUPPORTED');
    const secret = env.FINANCE_PAGE_TOKEN_SECRET?.trim();
    if (!secret) throw new Error('PAGE_TOKEN_SECRET_NOT_CONFIGURED');
    const token = await verifyPageToken(secret, plan.presentation.page_token, {
      ledger_scope_id: 'personal:primary',
      session_key: operation.session_key
    });
    const snapshot = await loadResultSetSnapshot(env.DB, token.result_set_id, 'personal:primary', operation.session_key);
    if (!snapshot || snapshot.result_set_version !== token.result_set_version) throw new Error('EXPIRED_REFERENCE');
    const window = resultSetWindow(snapshot, token.next_start_ordinal, token.page_size);
    const visibleRows = window.items.map((item) => ({
      entity_type: item.entity_type as FinanceResultRow['entity_type'],
      entity_id: item.entity_id,
      entity_fingerprint: item.entity_fingerprint,
      snapshot: JSON.parse(item.row_snapshot_json)
    }));
    const page: FinancePage = {
      result_set_id: snapshot.result_set_id,
      result_set_version: snapshot.result_set_version,
      start_ordinal: window.start_ordinal,
      end_ordinal: window.end_ordinal,
      page_size: window.items.length ? token.page_size : snapshot.page_size,
      has_previous: window.has_previous,
      has_next: window.has_next,
      next_page_token: window.has_next
        ? await createPageToken(secret, {
            schema_version: 2,
            ledger_scope_id: 'personal:primary',
            session_key: operation.session_key,
            result_set_id: snapshot.result_set_id,
            result_set_version: snapshot.result_set_version,
            next_start_ordinal: window.end_ordinal + 1,
            page_size: token.page_size,
            expires_at: snapshot.expires_at
          })
        : null
    };
    const result = {
      ...baseResult(plan, plan.operation),
      result_set_id: snapshot.result_set_id,
      ...(plan.operation === 'summarize' ? {} : { rows: visibleRows }),
      summary: summaryFromSnapshots(window.items),
      page
    } as unknown as FinanceResult;
    return {
      result,
      presentation: plan.presentation,
      side_effect_statements: [],
      outbox_rows: [],
      result_set_id: snapshot.result_set_id
    };
  }
  const temporalScope = plan.operation === 'compare' ? plan.left_scope : ('temporal_scope' in plan ? plan.temporal_scope : null);
  const queried = await queryTransactions(env, plan.filters, temporalScope, plan.presentation);
  const rows = await resultRows(queried.rows, queried.items);
  const resultSetId = id('result_set');
  const snapshot = await buildResultSetSnapshot({
    resultSetId,
    ledgerScopeId: 'personal:primary',
    sessionKey: operation.session_key,
    sortFilterFingerprint: await sha256Hex(canonicalizeJson({ filters: plan.filters, temporalScope, presentation: plan.presentation })),
    pageSize: plan.presentation.page_size || 10,
    rows: rows.map((row) => ({
      entity_type: row.entity_type as 'transaction' | 'transaction_item' | 'receipt_parent',
      entity_id: row.entity_id,
      entity_fingerprint: row.entity_fingerprint,
      snapshot: row.snapshot
    })),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
  const sideEffects = buildResultSetStatements(env.DB, snapshot, plan.plan_id, plan.plan_version, operation.route_epoch);
  const window = resultSetWindow(snapshot, 1, snapshot.page_size);
  const visibleRows = rows.slice(0, window.items.length);
  const secret = env.FINANCE_PAGE_TOKEN_SECRET?.trim();
  const page: FinancePage = {
    result_set_id: snapshot.result_set_id,
    result_set_version: snapshot.result_set_version,
    start_ordinal: window.start_ordinal,
    end_ordinal: window.end_ordinal,
    page_size: snapshot.page_size,
    has_previous: window.has_previous,
    has_next: window.has_next,
    next_page_token: window.has_next
      ? secret
        ? await createPageToken(secret, {
            schema_version: 2,
            ledger_scope_id: 'personal:primary',
            session_key: operation.session_key,
            result_set_id: snapshot.result_set_id,
            result_set_version: snapshot.result_set_version,
            next_start_ordinal: window.end_ordinal + 1,
            page_size: snapshot.page_size,
            expires_at: snapshot.expires_at
          })
        : null
      : null
  };
  if (window.has_next && !page.next_page_token) throw new Error('PAGE_TOKEN_SECRET_NOT_CONFIGURED');
  const calculated = summary(queried.rows);
  let analysis: Record<string, unknown> | undefined;
  let comparison: Record<string, unknown> | undefined;
  if (plan.operation === 'analyze') {
    analysis = {
      metric: plan.metric,
      summary: calculated,
      dimensions: analysisDimensions(queried.rows, plan.metric, plan.dimension)
    };
  }
  if (plan.operation === 'compare') {
    const right = await queryTransactions(env, plan.filters, plan.right_scope, plan.presentation);
    const rightSummary = summary(right.rows);
    const leftValue = summaryMetric(calculated, plan.metric);
    const rightValue = summaryMetric(rightSummary, plan.metric);
    comparison = {
      metric: plan.metric,
      left: calculated,
      right: rightSummary,
      delta_fen: leftValue - rightValue
    };
  }
  const result = {
    ...baseResult(plan, plan.operation),
    result_set_id: resultSetId,
    ...(plan.operation === 'summarize' ? {} : { rows: visibleRows }),
    summary: calculated,
    page,
    ...(analysis ? { analysis_data: analysis } : {}),
    ...(comparison ? { comparison_data: comparison } : {})
  } as unknown as FinanceResult;
  return {
    result,
    presentation: plan.presentation,
    side_effect_statements: sideEffects,
    outbox_rows: [],
    result_set_id: resultSetId
  };
}

function summaryFromSnapshots(items: Array<{ row_snapshot_json: string }>): FinanceSummary {
  let expense = 0;
  let income = 0;
  let transfer = 0;
  for (const item of items) {
    const snapshot = JSON.parse(item.row_snapshot_json) as TransactionSnapshot;
    if (snapshot.type === 'expense') expense += snapshot.amount_fen;
    else if (snapshot.type === 'income') income += snapshot.amount_fen;
    else if (snapshot.type === 'transfer') transfer += snapshot.amount_fen;
  }
  return {
    transaction_count: items.length,
    expense_fen: expense,
    income_fen: income,
    transfer_fen: transfer,
    net_fen: income - expense
  };
}

async function fallbackCategoryId(env: Env, type: 'expense' | 'income' | 'transfer'): Promise<string | null> {
  const fallback = type === 'expense' ? '其他支出' : type === 'income' ? '其他收入' : '转账';
  return resolveCategoryId(env, fallback, type);
}

async function createDraft(env: Env, plan: CreatePlan | ReceiptCreatePlan, operation: FinanceOperationRecord): Promise<ExecutionDraft> {
  const fence = operationFence(operation);
  const statements: D1StatementLike[] = [];
  const transactionIds: string[] = [];
  const itemIds: string[] = [];
  const auditIds: string[] = [];
  for (const entry of plan.entries) {
    const transactionId = id('tx');
    const auditId = id('audit');
    transactionIds.push(transactionId);
    auditIds.push(auditId);
    const accountName = entry.account?.value || '未指定';
    const categoryName = entry.category?.value || (entry.type === 'expense' ? '其他支出' : entry.type === 'income' ? '其他收入' : '转账');
    const accountId = await resolveAccountId(env, accountName) || await resolveAccountId(env, '未指定');
    const categoryId = await resolveCategoryId(env, categoryName, entry.type) || await fallbackCategoryId(env, entry.type);
    if (!accountId) throw new Error('ACCOUNT_NOT_CONFIGURED');
    if (!categoryId) throw new Error('CATEGORY_NOT_CONFIGURED');
    const itemSnapshots: TransactionSnapshot['items'] = [];
    statements.push(env.DB.prepare(
      `INSERT INTO transactions (
         id, type, amount_fen, currency, account_id, category_id, merchant, description,
         occurred_at, source, source_id, raw_text, created_at, updated_at
       ) SELECT ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        WHERE ${fence.sql}`
    ).bind(
      transactionId,
      entry.type,
      entry.money.amount_fen,
      accountId,
      categoryId,
      entry.merchant || null,
      entry.description || null,
      entry.occurred_at,
      plan.operation === 'receipt_create' ? 'telegram' : 'finance_v2',
      plan.operation === 'receipt_create'
        ? plan.receipt_job_id
        : `${operation.idempotency_key}:${entry.client_entry_key}`,
      entry.description || null,
      ...fence.params
    ));
    if (entry.items?.length) {
      for (const item of entry.items) {
        const itemId = id('item');
        itemIds.push(itemId);
        itemSnapshots.push({
          id: itemId,
          name: item.name,
          quantity: item.quantity,
          unit_price_fen: item.unit_price_fen ?? null,
          line_total_fen: item.line_total_fen,
          category: item.category
        });
        statements.push(env.DB.prepare(
          `INSERT INTO transaction_items (
             id, transaction_id, name, quantity, unit_price_fen, line_total_fen, category, confidence, created_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
            WHERE ${fence.sql}`
        ).bind(
          itemId,
          transactionId,
          item.name,
          item.quantity,
          item.unit_price_fen ?? null,
          item.line_total_fen,
          item.category,
          item.confidence,
          ...fence.params
        ));
      }
    }
    const afterSnapshot: TransactionSnapshot = {
      id: transactionId,
      type: entry.type,
      amount_fen: entry.money.amount_fen,
      currency: 'CNY',
      occurred_at: entry.occurred_at,
      account_id: accountId,
      category_id: categoryId,
      merchant: entry.merchant || null,
      description: entry.description || null,
      items: itemSnapshots
    };
    statements.push(env.DB.prepare(
      `INSERT INTO finance_audit_snapshots (
         audit_id, ledger_scope_id, operation_id, entity_type, entity_id, before_json, after_json, child_set_json
       ) SELECT ?, ?, ?, 'transaction', ?, NULL, ?, ?
          WHERE ${fence.sql}`
    ).bind(
      auditId,
      operation.ledger_scope_id,
      operation.operation_id,
      transactionId,
      canonicalizeJson(afterSnapshot),
      canonicalizeJson(afterSnapshot.items),
      ...fence.params
    ));
  }
    const result = {
    ...baseResult(plan, plan.operation),
    transaction_ids: transactionIds,
    item_ids: itemIds,
    audit_ids: auditIds,
    ...(plan.operation === 'receipt_create' ? {
      receipt_artifact_id: plan.receipt_artifact_id,
      receipt_merchant: plan.receipt_merchant ?? plan.entries[0]?.merchant ?? null,
      receipt_total_fen: plan.receipt_total_fen ?? plan.entries[0]?.money.amount_fen ?? null,
      receipt_item_count: plan.receipt_item_count ?? plan.entries[0]?.items?.length ?? 0
    } : {})
  } as unknown as FinanceResult;
  return {
    result,
    presentation: plan.presentation,
    side_effect_statements: statements,
    outbox_rows: []
  };
}

type MutationPlan = Extract<FinancePlan, { operation: 'update' | 'delete' }>;

function hasEffectiveMutationFilter(filters: FinanceFilters): boolean {
  return Boolean(
    filters.types?.length
    || filters.categories?.some((item) => item.value.trim())
    || filters.accounts?.some((item) => item.value.trim())
    || filters.merchant_text?.trim()
    || filters.semantic_text?.trim()
    || filters.amount_min_fen !== undefined && filters.amount_min_fen !== null
    || filters.amount_max_fen !== undefined && filters.amount_max_fen !== null
  );
}

async function selectMutationTargets(env: Env, plan: MutationPlan, sessionKey: string): Promise<{ rows: TransactionRow[]; items: Map<string, TransactionItemRow[]> }> {
  let selected: { rows: TransactionRow[]; items: Map<string, TransactionItemRow[]> };
  if (plan.selection.mode === 'reference') {
    const reference = plan.selection.reference;
    if (reference.kind === 'transaction') {
      const trusted = await env.DB.prepare(
        `SELECT 1 FROM finance_session_references
          WHERE ledger_scope_id = 'personal:primary' AND session_key = ?
            AND entity_id = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
          LIMIT 1`
      ).bind(sessionKey, reference.transaction_id).first();
      if (!trusted) throw new Error('STALE_REFERENCE');
      selected = await loadTransactionsByIds(env, [reference.transaction_id]);
      if (selected.rows.length !== 1) throw new Error('STALE_REFERENCE');
    } else if (reference.kind === 'transaction_item') {
      const parent = await env.DB.prepare(
        `SELECT transaction_id FROM transaction_items WHERE id = ?`
      ).bind(reference.item_id).first<{ transaction_id: string }>();
      if (!parent) throw new Error('STALE_REFERENCE');
      const trusted = await env.DB.prepare(
        `SELECT 1 FROM finance_result_set_items i
           JOIN finance_result_sets s ON s.result_set_id = i.result_set_id
          WHERE s.ledger_scope_id = 'personal:primary' AND s.session_key = ?
            AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
            AND i.entity_type = 'transaction_item' AND i.entity_id = ?
          UNION ALL
         SELECT 1 FROM finance_session_references
          WHERE ledger_scope_id = 'personal:primary' AND session_key = ?
            AND entity_id = ? AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
          LIMIT 1`
      ).bind(sessionKey, reference.item_id, sessionKey, parent.transaction_id).first();
      if (!trusted) throw new Error('STALE_REFERENCE');
      selected = await loadTransactionsByIds(env, [parent.transaction_id]);
    } else if (reference.kind === 'result_ordinal') {
      let snapshot: ResultSetSnapshot | null;
      try {
        snapshot = await loadResultSetSnapshot(env.DB, reference.result_set_id, 'personal:primary', sessionKey);
      } catch (error) {
        if (error instanceof Error && error.message === 'EXPIRED_REFERENCE') throw error;
        throw new Error('STALE_REFERENCE');
      }
      if (!snapshot) throw new Error('STALE_REFERENCE');
      const item = snapshot.items.find((candidate) => candidate.ordinal === reference.ordinal);
      if (!item) throw new Error('EXPIRED_REFERENCE');
      if (item.entity_type !== 'transaction' && item.entity_type !== 'receipt_parent') throw new Error('STALE_REFERENCE');
      selected = await loadTransactionsByIds(env, [item.entity_id]);
      if (selected.rows.length !== 1) throw new Error('STALE_REFERENCE');
      const liveSnapshot = transactionSnapshot(selected.rows[0], selected.items);
      if (await sha256Hex(canonicalizeJson(liveSnapshot)) !== item.entity_fingerprint) throw new Error('STALE_REFERENCE');
    } else if (reference.kind === 'receipt') {
      const resultRow = await env.DB.prepare(
        `SELECT r.result_json
           FROM finance_receipt_artifacts a
           JOIN finance_receipt_jobs j ON j.job_id = a.job_id
           JOIN finance_operations o ON o.turn_id = j.turn_id AND o.status = 'committed'
           JOIN finance_results r ON r.result_id = o.result_id
          WHERE a.receipt_artifact_id = ? AND a.ledger_scope_id = 'personal:primary'
          ORDER BY o.committed_at DESC LIMIT 1`
      ).bind(reference.receipt_artifact_id).first<{ result_json: string }>();
      if (!resultRow) throw new Error('STALE_REFERENCE');
      const result = JSON.parse(resultRow.result_json) as { transaction_ids?: string[] };
      if (!result.transaction_ids?.length) throw new Error('STALE_REFERENCE');
      selected = await loadTransactionsByIds(env, result.transaction_ids);
    } else if (reference.kind === 'operation') {
      const resultRow = await env.DB.prepare(
        `SELECT result_json FROM finance_results
          WHERE operation_id = ? AND ledger_scope_id = 'personal:primary'`
      ).bind(reference.operation_id).first<{ result_json: string }>();
      if (!resultRow) throw new Error('STALE_REFERENCE');
      const result = JSON.parse(resultRow.result_json) as { transaction_ids?: string[] };
      if (!result.transaction_ids?.length) throw new Error('STALE_REFERENCE');
      selected = await loadTransactionsByIds(env, result.transaction_ids);
    } else if (reference.kind === 'session_semantic') {
      const key = reference.semantic_key;
      if (['last_created', 'last_updated', 'last_deleted', 'last_restored', 'last_receipt'].includes(key)) {
        const referenceRow = await env.DB.prepare(
          `SELECT entity_id FROM finance_session_references
            WHERE ledger_scope_id = 'personal:primary' AND session_key = ?
              AND reference_kind = ?
              AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            ORDER BY created_at DESC, reference_id DESC LIMIT 1`
        ).bind(sessionKey, key).first<{ entity_id: string }>();
        if (!referenceRow) throw new Error('NO_MATCH');
        selected = await loadTransactionsByIds(env, [referenceRow.entity_id]);
      } else {
        const session = await env.DB.prepare(
          `SELECT active_result_set_id, active_window_start_ordinal, active_window_end_ordinal,
                  previous_window_start_ordinal, previous_window_end_ordinal
             FROM finance_sessions
            WHERE ledger_scope_id = 'personal:primary' AND session_key = ?`
        ).bind(sessionKey).first<{
          active_result_set_id: string | null;
          active_window_start_ordinal: number | null;
          active_window_end_ordinal: number | null;
          previous_window_start_ordinal: number | null;
          previous_window_end_ordinal: number | null;
        }>();
        if (!session?.active_result_set_id) throw new Error('EXPIRED_REFERENCE');
        const usePrevious = key === 'previous_window';
        const start = usePrevious ? session.previous_window_start_ordinal : session.active_window_start_ordinal;
        const end = usePrevious ? session.previous_window_end_ordinal : session.active_window_end_ordinal;
        let resultSetId = session.active_result_set_id;
        if (usePrevious || key === 'previous_result_set') {
          const previousReference = await env.DB.prepare(
            `SELECT entity_id FROM finance_session_references
              WHERE ledger_scope_id = 'personal:primary' AND session_key = ?
                AND reference_kind = 'active_result_set'
              ORDER BY created_at DESC, reference_id DESC LIMIT 1 OFFSET 1`
          ).bind(sessionKey).first<{ entity_id: string }>();
          if (!previousReference) throw new Error('EXPIRED_REFERENCE');
          resultSetId = previousReference.entity_id;
        }
        const itemRows = await env.DB.prepare(
          `SELECT entity_id, entity_fingerprint FROM finance_result_set_items
            WHERE result_set_id = ? AND (? IN ('active_result_set', 'previous_result_set') OR ordinal BETWEEN ? AND ?)
            ORDER BY ordinal`
        ).bind(resultSetId, key, start ?? 1, end ?? 200).all<{ entity_id: string; entity_fingerprint: string }>();
        if (!itemRows.results?.length) throw new Error('EXPIRED_REFERENCE');
        selected = await loadSnapshotReferencedTransactions(env, itemRows.results);
      }
    } else {
      throw new Error('REFERENCE_NOT_SUPPORTED');
    }
  } else {
    if (!hasEffectiveMutationFilter(plan.filters)) throw new Error('INSUFFICIENT_SCOPE');
    selected = await queryTransactions(env, plan.filters, null);
  }
  const count = selected.rows.length;
  if (count > MAX_MUTATION_TARGETS) throw new Error('OPERATION_TOO_LARGE');
  if (plan.selection.mode === 'exactly_one' && count !== 1) throw new Error('CARDINALITY_MISMATCH');
  if (plan.selection.mode === 'exact_count' && count !== plan.selection.count) throw new Error('CARDINALITY_MISMATCH');
  if (!count) throw new Error('NO_MATCH');
  return selected;
}

async function resolveChangeIds(env: Env, changes: Record<string, unknown>, current: TransactionRow): Promise<{ accountId: string | null | undefined; categoryId: string | null | undefined }> {
  let accountId: string | null | undefined;
  let categoryId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(changes, 'account')) {
    if (changes.account === null) accountId = null;
    else {
      const account = changes.account as { value?: string };
      accountId = await resolveAccountId(env, account.value || '') || undefined;
      if (!accountId) throw new Error('INVALID_ACCOUNT');
    }
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'category')) {
    if (changes.category === null) categoryId = null;
    else {
      const category = changes.category as { value?: string };
      categoryId = await resolveCategoryId(env, category.value || '', current.type) || undefined;
      if (!categoryId) throw new Error('INVALID_CATEGORY');
    }
  }
  return { accountId, categoryId };
}

async function updateDraft(env: Env, plan: Extract<FinancePlan, { operation: 'update' }>, operation: FinanceOperationRecord): Promise<ExecutionDraft> {
  const selected = await selectMutationTargets(env, plan, operation.session_key);
  const changes = plan.changes as Record<string, unknown>;
  const fence = operationFence(operation);
  const statements: D1StatementLike[] = [];
  const transactionIds: string[] = [];
  const auditIds: string[] = [];
  const resultRowsList: FinanceResultRow[] = [];
  if (changes.item_patch && selected.rows.length !== 1) throw new Error('CARDINALITY_MISMATCH');
  for (const row of selected.rows) {
    statements.push(assertUnchangedEntity(env, row, selected.items.get(row.id) || []));
    if (changes.item_patch) {
      const itemPatch = changes.item_patch as Record<string, unknown>;
      const target = itemPatch.target && typeof itemPatch.target === 'object' ? itemPatch.target as Record<string, unknown> : null;
      if (!target || target.kind !== 'transaction_item' || typeof target.item_id !== 'string') throw new Error('REFERENCE_NOT_SUPPORTED');
      if (row.id !== (await env.DB.prepare('SELECT transaction_id FROM transaction_items WHERE id = ?').bind(target.item_id).first<{ transaction_id: string }>())?.transaction_id) throw new Error('STALE_REFERENCE');
      const currentItem = (selected.items.get(row.id) || []).find((item) => item.id === target.item_id);
      if (!currentItem) throw new Error('STALE_REFERENCE');
      const itemSet: string[] = [];
      const itemParams: unknown[] = [];
      if (itemPatch.name !== undefined) {
        if (typeof itemPatch.name !== 'string' || !itemPatch.name.trim()) throw new Error('INVALID_ITEM');
        itemSet.push('name = ?');
        itemParams.push(itemPatch.name.trim().slice(0, 160));
      }
      if (itemPatch.quantity !== undefined) {
        if (typeof itemPatch.quantity !== 'number' || !Number.isFinite(itemPatch.quantity) || itemPatch.quantity <= 0 || itemPatch.quantity > 10000) throw new Error('INVALID_ITEM');
        itemSet.push('quantity = ?');
        itemParams.push(itemPatch.quantity);
      }
      if (itemPatch.unit_price_fen !== undefined) {
        const unitPrice = itemPatch.unit_price_fen;
        if (unitPrice !== null && (typeof unitPrice !== 'number' || !Number.isInteger(unitPrice) || unitPrice < 0)) throw new Error('INVALID_ITEM_AMOUNT');
        itemSet.push('unit_price_fen = ?');
        itemParams.push(unitPrice);
      }
      if (itemPatch.line_total_fen !== undefined) {
        const lineTotal = itemPatch.line_total_fen;
        if (typeof lineTotal !== 'number' || !Number.isInteger(lineTotal) || lineTotal < 0) throw new Error('INVALID_ITEM_AMOUNT');
        itemSet.push('line_total_fen = ?');
        itemParams.push(lineTotal);
      }
      if (itemPatch.category !== undefined) {
        if (typeof itemPatch.category !== 'string' || !itemPatch.category.trim()) throw new Error('INVALID_ITEM');
        itemSet.push('category = ?');
        itemParams.push(itemPatch.category.trim().slice(0, 64));
      }
      if (!itemSet.length) throw new Error('NO_CHANGES');
      const beforeSnapshot = transactionSnapshot(row, selected.items);
      const afterItems = (selected.items.get(row.id) || []).map((item) => item.id === currentItem.id ? {
        id: item.id,
        name: typeof itemPatch.name === 'string' ? itemPatch.name.trim().slice(0, 160) : item.name,
        quantity: typeof itemPatch.quantity === 'number' ? itemPatch.quantity : item.quantity,
        unit_price_fen: itemPatch.unit_price_fen === undefined ? item.unit_price_fen : itemPatch.unit_price_fen as number | null,
        line_total_fen: itemPatch.line_total_fen === undefined ? item.line_total_fen : itemPatch.line_total_fen as number,
        category: typeof itemPatch.category === 'string' ? itemPatch.category.trim().slice(0, 64) : item.category
      } : {
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unit_price_fen: item.unit_price_fen,
        line_total_fen: item.line_total_fen,
        category: item.category
      });
      const afterSnapshot = { ...beforeSnapshot, items: afterItems };
      const auditId = id('audit');
      transactionIds.push(row.id);
      auditIds.push(auditId);
      resultRowsList.push({
        entity_type: 'transaction',
        entity_id: row.id,
        entity_fingerprint: await sha256Hex(canonicalizeJson(afterSnapshot)),
        snapshot: afterSnapshot
      });
      statements.push(env.DB.prepare(
        `UPDATE transaction_items SET ${itemSet.join(', ')} WHERE id = ? AND transaction_id = ? AND ${fence.sql}`
      ).bind(...itemParams, currentItem.id, row.id, ...fence.params));
      statements.push(env.DB.prepare(
        `INSERT INTO finance_audit_snapshots (
           audit_id, ledger_scope_id, operation_id, entity_type, entity_id, before_json, after_json, child_set_json
         ) SELECT ?, ?, ?, 'transaction', ?, ?, ?, ? WHERE ${fence.sql}`
      ).bind(
        auditId,
        operation.ledger_scope_id,
        operation.operation_id,
        row.id,
        canonicalizeJson(beforeSnapshot),
        canonicalizeJson(afterSnapshot),
        canonicalizeJson(afterSnapshot.items),
        ...fence.params
      ));
      continue;
    }
    const resolved = await resolveChangeIds(env, changes, row);
    const set: string[] = [];
    const params: unknown[] = [];
    if (Object.prototype.hasOwnProperty.call(changes, 'amount_fen')) { set.push('amount_fen = ?'); params.push(changes.amount_fen); }
    if (Object.prototype.hasOwnProperty.call(changes, 'occurred_at')) { set.push('occurred_at = ?'); params.push(changes.occurred_at); }
    if (Object.prototype.hasOwnProperty.call(changes, 'merchant')) { set.push('merchant = ?'); params.push(changes.merchant); }
    if (Object.prototype.hasOwnProperty.call(changes, 'description')) { set.push('description = ?'); params.push(changes.description); }
    if (resolved.accountId !== undefined) { set.push('account_id = ?'); params.push(resolved.accountId); }
    if (resolved.categoryId !== undefined) { set.push('category_id = ?'); params.push(resolved.categoryId); }
    if (!set.length) throw new Error('NO_CHANGES');
    set.push('updated_at = CURRENT_TIMESTAMP');
    statements.push(env.DB.prepare(
      `UPDATE transactions SET ${set.join(', ')} WHERE id = ? AND ${fence.sql}`
    ).bind(...params, row.id, ...fence.params));
    const afterRow: TransactionRow = {
      ...row,
      amount_fen: typeof changes.amount_fen === 'number' ? changes.amount_fen : row.amount_fen,
      occurred_at: typeof changes.occurred_at === 'string' ? changes.occurred_at : row.occurred_at,
      merchant: Object.prototype.hasOwnProperty.call(changes, 'merchant') ? (changes.merchant as string | null) : row.merchant,
      description: Object.prototype.hasOwnProperty.call(changes, 'description') ? (changes.description as string | null) : row.description,
      account_id: resolved.accountId === undefined ? row.account_id : resolved.accountId,
      category_id: resolved.categoryId === undefined ? row.category_id : resolved.categoryId
    };
    const afterSnapshot = transactionSnapshot(afterRow, selected.items);
    const auditId = id('audit');
    transactionIds.push(row.id);
    auditIds.push(auditId);
    resultRowsList.push({
      entity_type: 'transaction',
      entity_id: row.id,
      entity_fingerprint: await sha256Hex(canonicalizeJson(afterSnapshot)),
      snapshot: afterSnapshot
    });
    statements.push(env.DB.prepare(
      `INSERT INTO finance_audit_snapshots (
         audit_id, ledger_scope_id, operation_id, entity_type, entity_id, before_json, after_json, child_set_json
       ) SELECT ?, ?, ?, 'transaction', ?, ?, ?, ? WHERE ${fence.sql}`
    ).bind(
      auditId,
      operation.ledger_scope_id,
      operation.operation_id,
      row.id,
      canonicalizeJson(transactionSnapshot(row, selected.items)),
      canonicalizeJson(afterSnapshot),
      canonicalizeJson(afterSnapshot.items),
      ...fence.params
    ));
  }
  return {
    result: {
      ...baseResult(plan, 'update'),
      transaction_ids: transactionIds,
      audit_ids: auditIds,
      rows: resultRowsList
    } as unknown as FinanceResult,
    presentation: plan.presentation,
    side_effect_statements: statements,
    outbox_rows: []
  };
}

async function deleteDraft(env: Env, plan: Extract<FinancePlan, { operation: 'delete' }>, operation: FinanceOperationRecord): Promise<ExecutionDraft> {
  const selected = await selectMutationTargets(env, plan, operation.session_key);
  const fence = operationFence(operation);
  const statements: D1StatementLike[] = [];
  const transactionIds: string[] = [];
  const auditIds: string[] = [];
  const resultRowsList: FinanceResultRow[] = [];
  for (const row of selected.rows) {
    const beforeSnapshot = transactionSnapshot(row, selected.items);
    statements.push(assertUnchangedEntity(env, row, selected.items.get(row.id) || []));
    const auditId = id('audit');
    transactionIds.push(row.id);
    auditIds.push(auditId);
    resultRowsList.push({
      entity_type: 'transaction',
      entity_id: row.id,
      entity_fingerprint: await sha256Hex(canonicalizeJson(beforeSnapshot)),
      snapshot: beforeSnapshot
    });
    statements.push(env.DB.prepare(
      `INSERT INTO finance_audit_snapshots (
         audit_id, ledger_scope_id, operation_id, entity_type, entity_id, before_json, after_json, child_set_json
       ) SELECT ?, ?, ?, 'transaction', ?, ?, NULL, ? WHERE ${fence.sql}`
    ).bind(
      auditId,
      operation.ledger_scope_id,
      operation.operation_id,
      row.id,
      canonicalizeJson(beforeSnapshot),
      canonicalizeJson(beforeSnapshot.items),
      ...fence.params
    ));
    statements.push(env.DB.prepare(
      `DELETE FROM transactions WHERE id = ? AND ${fence.sql}`
    ).bind(row.id, ...fence.params));
  }
  return {
    result: {
      ...baseResult(plan, 'delete'),
      transaction_ids: transactionIds,
      audit_ids: auditIds,
      rows: resultRowsList
    } as unknown as FinanceResult,
    presentation: plan.presentation,
    side_effect_statements: statements,
    outbox_rows: []
  };
}

async function restoreDraft(env: Env, plan: Extract<FinancePlan, { operation: 'restore' }>, operation: FinanceOperationRecord): Promise<ExecutionDraft> {
  if (plan.reference.kind !== 'operation') throw new Error('RESTORE_OPERATION_REFERENCE_REQUIRED');
  const auditRows = await env.DB.prepare(
    `SELECT audit_id, entity_id, before_json
       FROM finance_audit_snapshots
      WHERE operation_id = ? AND entity_type = 'transaction' AND before_json IS NOT NULL
      ORDER BY audit_id`
  ).bind(plan.reference.operation_id).all<{ audit_id: string; entity_id: string; before_json: string }>();
  if (!auditRows.results?.length) throw new Error('NO_RESTORE_SNAPSHOT');
  const fence = operationFence(operation);
  const statements: D1StatementLike[] = [];
  const transactionIds: string[] = [];
  const auditIds: string[] = [];
  const resultRowsList: FinanceResultRow[] = [];
  for (const auditRow of auditRows.results) {
    const snapshot = JSON.parse(auditRow.before_json) as TransactionSnapshot;
    const auditId = id('audit');
    transactionIds.push(snapshot.id);
    auditIds.push(auditId);
    resultRowsList.push({
      entity_type: 'transaction',
      entity_id: snapshot.id,
      entity_fingerprint: await sha256Hex(canonicalizeJson(snapshot)),
      snapshot
    });
    statements.push(env.DB.prepare(
      `INSERT INTO transactions (
         id, type, amount_fen, currency, account_id, category_id, merchant, description,
         occurred_at, source, source_id, raw_text, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finance_v2', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE id = ?) AND ${fence.sql}`
    ).bind(
      snapshot.id,
      snapshot.type,
      snapshot.amount_fen,
      snapshot.currency,
      snapshot.account_id,
      snapshot.category_id,
      snapshot.merchant,
      snapshot.description,
      snapshot.occurred_at,
      `restore:${operation.operation_id}:${snapshot.id}`,
      snapshot.description,
      snapshot.id,
      ...fence.params
    ));
    for (const item of snapshot.items) {
      statements.push(env.DB.prepare(
        `INSERT INTO transaction_items (
           id, transaction_id, name, quantity, unit_price_fen, line_total_fen, category, confidence, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, 1.0, CURRENT_TIMESTAMP
          WHERE NOT EXISTS (SELECT 1 FROM transaction_items WHERE id = ?) AND ${fence.sql}`
      ).bind(
        item.id,
        snapshot.id,
        item.name,
        item.quantity,
        item.unit_price_fen,
        item.line_total_fen,
        item.category,
        item.id,
        ...fence.params
      ));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO finance_audit_snapshots (
         audit_id, ledger_scope_id, operation_id, entity_type, entity_id, before_json, after_json, child_set_json
       ) SELECT ?, ?, ?, 'transaction', ?, NULL, ?, ? WHERE ${fence.sql}`
    ).bind(
      auditId,
      operation.ledger_scope_id,
      operation.operation_id,
      snapshot.id,
      canonicalizeJson(snapshot),
      canonicalizeJson(snapshot.items),
      ...fence.params
    ));
  }
  if (statements.length > MAX_D1_BATCH_STATEMENTS) throw new Error('OPERATION_TOO_LARGE');
  return {
    result: {
      ...baseResult(plan, 'restore'),
      transaction_ids: transactionIds,
      audit_ids: auditIds,
      rows: resultRowsList
    } as unknown as FinanceResult,
    presentation: plan.presentation,
    side_effect_statements: statements,
    outbox_rows: []
  };
}

export async function prepareFinanceExecution(env: Env, plan: FinancePlan, operation: FinanceOperationRecord): Promise<ExecutionDraft> {
  if (plan.operation === 'create' || plan.operation === 'receipt_create') return createDraft(env, plan, operation);
  if (plan.operation === 'query' || plan.operation === 'summarize' || plan.operation === 'analyze' || plan.operation === 'compare') {
    return buildReadDraft(env, plan, operation);
  }
  if (plan.operation === 'update') return updateDraft(env, plan, operation);
  if (plan.operation === 'delete') return deleteDraft(env, plan, operation);
  if (plan.operation === 'restore') return restoreDraft(env, plan, operation);
  throw new Error('V2_OPERATION_NOT_IMPLEMENTED');
}
