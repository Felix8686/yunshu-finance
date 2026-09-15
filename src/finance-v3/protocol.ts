export type V3TransactionType = 'expense' | 'income' | 'transfer';
export type V3PeriodPreset =
  | 'today'
  | 'yesterday'
  | 'this_month'
  | 'this_month_to_date'
  | 'last_month'
  | 'this_year'
  | 'last_year';

export type V3ReadSource =
  | { kind: 'ledger' }
  | { kind: 'result_set'; result_set_id: string; session_key?: string }
  | { kind: 'active_result_set'; session_key: string }
  | { kind: 'previous_result_set'; session_key: string };

export type V3TimeScope =
  | { kind: 'preset'; preset: V3PeriodPreset }
  | { kind: 'explicit'; from: string; to: string };

export interface V3ReadFilters {
  types?: V3TransactionType[];
  categories?: string[];
  accounts?: string[];
  merchant?: string | null;
  amount_min_fen?: number | null;
  amount_max_fen?: number | null;
}

export type V3SortField = 'occurred_at' | 'amount_fen';
export type V3SortDirection = 'asc' | 'desc';
export type V3GroupDimension = 'category' | 'date' | 'account' | 'merchant';
export type V3GroupMetric = 'amount' | 'count' | 'net';

export interface V3FindTransactionsCall {
  tool: 'find_transactions';
  source: V3ReadSource;
  scope?: V3TimeScope | null;
  filters?: V3ReadFilters;
  order_by?: { field: V3SortField; direction: V3SortDirection } | null;
  limit?: number;
}

export interface V3SummarizeTransactionsCall {
  tool: 'summarize_transactions';
  source: V3ReadSource;
  scope?: V3TimeScope | null;
  filters?: V3ReadFilters;
}

export interface V3GroupTransactionsCall {
  tool: 'group_transactions';
  source: V3ReadSource;
  scope?: V3TimeScope | null;
  filters?: V3ReadFilters;
  dimension: V3GroupDimension;
  metric: V3GroupMetric;
  limit?: number;
}

export interface V3GetExtremaCall {
  tool: 'get_extrema';
  source: V3ReadSource;
  scope?: V3TimeScope | null;
  filters?: V3ReadFilters;
  field: V3SortField;
  direction: 'min' | 'max';
}

export interface V3ComparePeriodsCall {
  tool: 'compare_periods';
  source: Extract<V3ReadSource, { kind: 'ledger' }>;
  left: V3TimeScope;
  right: V3TimeScope;
  filters?: V3ReadFilters;
}

export interface V3SearchTransactionsCall {
  tool: 'search_transactions';
  source: V3ReadSource;
  scope?: V3TimeScope | null;
  filters?: V3ReadFilters;
  explicit_search: true;
  query: string;
  limit?: number;
}

export interface V3DescribeResultSetCall {
  tool: 'describe_result_set';
  source: Exclude<V3ReadSource, { kind: 'ledger' }>;
}

export interface V3GetTransactionCall {
  tool: 'get_transaction';
  transaction_id: string;
}

export type V3ReadToolCall =
  | V3FindTransactionsCall
  | V3SummarizeTransactionsCall
  | V3GroupTransactionsCall
  | V3GetExtremaCall
  | V3ComparePeriodsCall
  | V3SearchTransactionsCall
  | V3DescribeResultSetCall
  | V3GetTransactionCall;

export interface V3ResolvedDateRange {
  from_date: string;
  to_date: string;
  timezone: 'Asia/Shanghai';
  source: string;
}

export interface V3TransactionRow {
  id: string;
  type: V3TransactionType;
  amount_fen: number;
  occurred_at: string;
  category: string | null;
  account: string | null;
  merchant: string | null;
  description: string | null;
}

export interface V3Summary {
  transaction_count: number;
  expense_fen: number;
  income_fen: number;
  transfer_fen: number;
  net_fen: number;
}

export interface V3GroupRow {
  key: string;
  value: number;
  transaction_count: number;
}

export interface V3ResultSetDescription extends V3Summary {
  result_set_id: string;
  earliest_date: string | null;
  latest_date: string | null;
  min_amount_fen: number | null;
  max_amount_fen: number | null;
}

export type V3ReadToolResult =
  | { tool: 'find_transactions'; rows: V3TransactionRow[]; total_matching: number; range: V3ResolvedDateRange | null }
  | { tool: 'summarize_transactions'; summary: V3Summary; range: V3ResolvedDateRange | null }
  | { tool: 'group_transactions'; groups: V3GroupRow[]; summary: V3Summary; range: V3ResolvedDateRange | null }
  | { tool: 'get_extrema'; row: V3TransactionRow | null; range: V3ResolvedDateRange | null }
  | { tool: 'compare_periods'; left: V3Summary; right: V3Summary; delta_net_fen: number; left_range: V3ResolvedDateRange; right_range: V3ResolvedDateRange }
  | { tool: 'search_transactions'; rows: V3TransactionRow[]; total_matching: number; range: V3ResolvedDateRange | null }
  | { tool: 'describe_result_set'; description: V3ResultSetDescription }
  | { tool: 'get_transaction'; row: V3TransactionRow | null };

export interface V3AgentContext {
  event_time: string;
  session_key: string;
  active_result_set_id?: string | null;
  previous_result_set_id?: string | null;
}

export type V3AgentDecision =
  | { kind: 'tool_calls'; calls: V3ReadToolCall[] }
  | { kind: 'clarification'; message: string }
  | { kind: 'non_finance' };
