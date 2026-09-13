import type { CreateTransactionInput, DateRange, FinanceCommand, ReportFilter } from "./types";

type ReportCommand = Extract<FinanceCommand, { action: "report" }>;

export interface SummaryResult {
  income_fen: number;
  expense_fen: number;
  count: number;
}

export interface DetailRow {
  id: string;
  type: "expense" | "income";
  amount_fen: number;
  category: string;
  description: string;
  account: string;
  occurred_at: string;
}

export interface CategoryRow {
  type: "expense" | "income";
  category: string;
  amount_fen: number;
  count: number;
}

export type ReportResult =
  | { kind: "summary"; range: DateRange; summary: SummaryResult }
  | { kind: "details"; range: DateRange; summary: SummaryResult; rows: DetailRow[] }
  | { kind: "category_breakdown"; range: DateRange; summary: SummaryResult; rows: CategoryRow[] }
  | {
      kind: "compare";
      range: DateRange;
      compare_range: DateRange;
      current: SummaryResult;
      previous: SummaryResult;
    };

interface WhereClause {
  sql: string;
  bindings: Array<string | number>;
}

function buildWhere(range: DateRange, filter: ReportFilter): WhereClause {
  const conditions = ["substr(occurred_at, 1, 10) BETWEEN ? AND ?"];
  const bindings: Array<string | number> = [range.start_date, range.end_date];

  if (filter.type !== "all") {
    conditions.push("type = ?");
    bindings.push(filter.type);
  }

  if (filter.category) {
    conditions.push("category = ?");
    bindings.push(filter.category);
  }

  return { sql: conditions.join(" AND "), bindings };
}

export async function createTransactions(
  db: D1Database,
  transactions: CreateTransactionInput[],
  meta: {
    chatId: string;
    messageId: string;
    rawText: string;
  },
): Promise<{ duplicate: boolean; count: number; total_fen: number }> {
  const existing = await db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_fen), 0) AS total_fen FROM transactions WHERE telegram_chat_id = ? AND telegram_message_id = ?")
    .bind(meta.chatId, meta.messageId)
    .first<{ count: number; total_fen: number }>();

  if ((existing?.count ?? 0) > 0) {
    return {
      duplicate: true,
      count: Number(existing?.count ?? 0),
      total_fen: Number(existing?.total_fen ?? 0),
    };
  }

  const sourceGroup = `${meta.chatId}:${meta.messageId}`;
  const statements = transactions.map((item, index) =>
    db
      .prepare(
        `INSERT INTO transactions (
          id, type, amount_fen, category, description, account, occurred_at,
          source_group, source_item_index, telegram_chat_id, telegram_message_id, raw_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        item.type,
        item.amount_fen,
        item.category,
        item.description,
        item.account,
        item.occurred_at,
        sourceGroup,
        index,
        meta.chatId,
        meta.messageId,
        meta.rawText,
      ),
  );

  await db.batch(statements);

  return {
    duplicate: false,
    count: transactions.length,
    total_fen: transactions.reduce((sum, item) => sum + item.amount_fen, 0),
  };
}

async function querySummary(db: D1Database, range: DateRange, filter: ReportFilter): Promise<SummaryResult> {
  const where = buildWhere(range, filter);
  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount_fen ELSE 0 END), 0) AS income_fen,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_fen ELSE 0 END), 0) AS expense_fen,
        COUNT(*) AS count
       FROM transactions
       WHERE ${where.sql}`,
    )
    .bind(...where.bindings)
    .first<SummaryResult>();

  return {
    income_fen: Number(row?.income_fen ?? 0),
    expense_fen: Number(row?.expense_fen ?? 0),
    count: Number(row?.count ?? 0),
  };
}

async function queryDetails(
  db: D1Database,
  range: DateRange,
  filter: ReportFilter,
  limit: number,
): Promise<DetailRow[]> {
  const where = buildWhere(range, filter);
  const result = await db
    .prepare(
      `SELECT id, type, amount_fen, category, description, account, occurred_at
       FROM transactions
       WHERE ${where.sql}
       ORDER BY occurred_at DESC, rowid DESC
       LIMIT ?`,
    )
    .bind(...where.bindings, limit)
    .all<DetailRow>();

  return result.results ?? [];
}

async function queryCategoryBreakdown(
  db: D1Database,
  range: DateRange,
  filter: ReportFilter,
): Promise<CategoryRow[]> {
  const where = buildWhere(range, filter);
  const result = await db
    .prepare(
      `SELECT type, category, SUM(amount_fen) AS amount_fen, COUNT(*) AS count
       FROM transactions
       WHERE ${where.sql}
       GROUP BY type, category
       ORDER BY amount_fen DESC, category ASC`,
    )
    .bind(...where.bindings)
    .all<CategoryRow>();

  return (result.results ?? []).map((row) => ({
    ...row,
    amount_fen: Number(row.amount_fen),
    count: Number(row.count),
  }));
}

export async function runReport(db: D1Database, command: ReportCommand): Promise<ReportResult> {
  if (command.report_type === "summary") {
    return {
      kind: "summary",
      range: command.range,
      summary: await querySummary(db, command.range, command.filter),
    };
  }

  if (command.report_type === "details") {
    const [summary, rows] = await Promise.all([
      querySummary(db, command.range, command.filter),
      queryDetails(db, command.range, command.filter, command.limit),
    ]);
    return { kind: "details", range: command.range, summary, rows };
  }

  if (command.report_type === "category_breakdown") {
    const [summary, rows] = await Promise.all([
      querySummary(db, command.range, command.filter),
      queryCategoryBreakdown(db, command.range, command.filter),
    ]);
    return { kind: "category_breakdown", range: command.range, summary, rows };
  }

  const compareRange = command.compare_range;
  if (!compareRange) throw new Error("compare_range is required");
  const [current, previous] = await Promise.all([
    querySummary(db, command.range, command.filter),
    querySummary(db, compareRange, command.filter),
  ]);
  return {
    kind: "compare",
    range: command.range,
    compare_range: compareRange,
    current,
    previous,
  };
}

export async function undoLatestTransactionGroup(
  db: D1Database,
  chatId: string,
): Promise<{ found: boolean; count: number; total_fen: number }> {
  const latest = await db
    .prepare(
      `SELECT source_group
       FROM transactions
       WHERE telegram_chat_id = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .bind(chatId)
    .first<{ source_group: string }>();

  if (!latest?.source_group) return { found: false, count: 0, total_fen: 0 };

  const summary = await db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_fen), 0) AS total_fen FROM transactions WHERE source_group = ?")
    .bind(latest.source_group)
    .first<{ count: number; total_fen: number }>();

  await db.prepare("DELETE FROM transactions WHERE source_group = ?").bind(latest.source_group).run();

  return {
    found: true,
    count: Number(summary?.count ?? 0),
    total_fen: Number(summary?.total_fen ?? 0),
  };
}
