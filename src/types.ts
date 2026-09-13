export type TransactionType = "expense" | "income";

export interface CreateTransactionInput {
  type: TransactionType;
  amount_fen: number;
  category: string;
  description: string;
  account: string;
  occurred_at: string;
}

export interface DateRange {
  start_date: string;
  end_date: string;
  label: string;
}

export interface ReportFilter {
  type: TransactionType | "all";
  category: string | null;
}

export type FinanceCommand =
  | {
      action: "create";
      transactions: CreateTransactionInput[];
    }
  | {
      action: "report";
      report_type: "summary" | "details" | "category_breakdown" | "compare";
      range: DateRange;
      compare_range: DateRange | null;
      filter: ReportFilter;
      limit: number;
    }
  | {
      action: "undo";
    }
  | {
      action: "clarify";
      question: string;
    }
  | {
      action: "help";
      message: string;
    };

export interface Env {
  DB: D1Database;
  AI: Ai;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_VISION_MODEL?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN: string;
  OWNER_TELEGRAM_ID: string;
  APP_TIMEZONE?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max = 100): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new Error(`${field} is invalid`);
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, max = 100): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field, max);
}

function transactionType(value: unknown): TransactionType {
  if (value === "expense" || value === "income") return value;
  throw new Error("invalid transaction type");
}

function date(value: unknown, field: string): string {
  const result = text(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  return result;
}

function dateTime(value: unknown, field: string): string {
  const result = text(value, field, 19);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(result)) {
    throw new Error(`${field} must be YYYY-MM-DDTHH:mm:ss`);
  }
  return result;
}

function parseRange(value: unknown, field: string): DateRange {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  const start_date = date(value.start_date, `${field}.start_date`);
  const end_date = date(value.end_date, `${field}.end_date`);
  if (start_date > end_date) throw new Error(`${field} start_date is after end_date`);
  return {
    start_date,
    end_date,
    label: text(value.label, `${field}.label`, 40),
  };
}

export function validateFinanceCommand(value: unknown): FinanceCommand {
  if (!isObject(value)) throw new Error("command must be an object");
  const action = value.action;

  if (action === "create") {
    if (!Array.isArray(value.transactions) || value.transactions.length < 1 || value.transactions.length > 20) {
      throw new Error("transactions must contain 1-20 items");
    }
    const transactions = value.transactions.map((item, index) => {
      if (!isObject(item)) throw new Error(`transactions[${index}] must be an object`);
      const amount = item.amount_fen;
      if (!Number.isInteger(amount) || (amount as number) <= 0 || (amount as number) > 1_000_000_000) {
        throw new Error(`transactions[${index}].amount_fen is invalid`);
      }
      return {
        type: transactionType(item.type),
        amount_fen: amount as number,
        category: text(item.category, `transactions[${index}].category`, 32),
        description: typeof item.description === "string" ? item.description.trim().slice(0, 120) : "",
        account: typeof item.account === "string" && item.account.trim() ? item.account.trim().slice(0, 32) : "未指定",
        occurred_at: dateTime(item.occurred_at, `transactions[${index}].occurred_at`),
      };
    });
    return { action: "create", transactions };
  }

  if (action === "report") {
    const reportType = value.report_type;
    if (!["summary", "details", "category_breakdown", "compare"].includes(String(reportType))) {
      throw new Error("invalid report_type");
    }
    if (!isObject(value.filter)) throw new Error("filter must be an object");
    const filterType = value.filter.type;
    if (!["expense", "income", "all"].includes(String(filterType))) {
      throw new Error("invalid filter.type");
    }
    const compareRange = value.compare_range === null || value.compare_range === undefined
      ? null
      : parseRange(value.compare_range, "compare_range");
    if (reportType === "compare" && compareRange === null) {
      throw new Error("compare report requires compare_range");
    }
    const rawLimit = value.limit ?? 50;
    if (!Number.isInteger(rawLimit)) throw new Error("limit must be an integer");
    const limit = Math.min(100, Math.max(1, rawLimit as number));
    return {
      action: "report",
      report_type: reportType as "summary" | "details" | "category_breakdown" | "compare",
      range: parseRange(value.range, "range"),
      compare_range: compareRange,
      filter: {
        type: filterType as TransactionType | "all",
        category: optionalText(value.filter.category, "filter.category", 32),
      },
      limit,
    };
  }

  if (action === "undo") return { action: "undo" };

  if (action === "clarify") {
    return { action: "clarify", question: text(value.question, "question", 200) };
  }

  if (action === "help") {
    return { action: "help", message: text(value.message, "message", 200) };
  }

  throw new Error("unsupported action");
}
