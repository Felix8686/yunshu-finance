export type BenchmarkFamily =
  | 'summary'
  | 'group'
  | 'details'
  | 'extrema'
  | 'result_set'
  | 'search'
  | 'compare'
  | 'clarification'
  | 'non_finance';

export interface ExpectedToolShape {
  tool: string;
  source_kind?: 'ledger' | 'active_result_set' | 'previous_result_set';
  preset?: string;
  explicit_from_prefix?: string;
  explicit_to_prefix?: string;
  types?: Array<'expense' | 'income' | 'transfer'>;
  dimension?: string;
  metric?: string;
  field?: string;
  direction?: string;
  order_field?: string;
  order_direction?: string;
  explicit_search?: boolean;
  query?: string;
}

export type TruthExpectation =
  | { kind: 'summary'; transaction_count: number; expense_fen: number; income_fen: number }
  | { kind: 'group_top'; key: string; value: number; transaction_count: number; expense_fen: number }
  | { kind: 'result_set_description'; transaction_count: number; earliest_date: string; latest_date: string; min_amount_fen: number; max_amount_fen: number }
  | { kind: 'extrema'; transaction_id: string; amount_fen: number; date: string }
  | { kind: 'search_count'; total_matching: number }
  | { kind: 'details_count'; total_matching: number };

export interface FinanceV3BenchmarkCase {
  id: string;
  family: BenchmarkFamily;
  text: string;
  critical?: boolean;
  context?: 'ledger' | 'active_result_set' | 'previous_result_set';
  expected_kind: 'tool_calls' | 'clarification' | 'non_finance';
  expected_tool?: ExpectedToolShape;
  truth?: TruthExpectation;
  v2_comparable?: boolean;
}

const summaryVariants = [
  '上个月支出多少',
  '上月一共花了多少',
  '我上个月的总支出是多少',
  '上个月消费总额',
  '前一个月一共支出了多少',
  '上个月我花了多少钱'
];

const groupVariants = [
  '上个月哪一类花得最多',
  '上月支出最高的分类是什么',
  '上个月各类支出怎么分布，最多的是哪类',
  '我上个月的消费支出一共是多少，哪一类占比较大',
  '上月总支出和最大支出分类一起告诉我'
];

const activeStartVariants = [
  '这些记录开始日期是几号',
  '这些记录最早是哪天',
  '刚才这些里面第一天是哪一天',
  '上面这批账最早一笔是哪天',
  '这批记录是从哪天开始的'
];

const activeMaxVariants = [
  '这些里面最大一笔多少钱',
  '刚才那些记录里金额最高的是哪笔',
  '上面这批账最大的一笔是多少'
];

export const financeV3BenchmarkCases: FinanceV3BenchmarkCase[] = [
  ...summaryVariants.map((text, index) => ({
    id: `summary-last-month-${index + 1}`,
    family: 'summary' as const,
    text,
    critical: index === 0,
    context: 'ledger' as const,
    expected_kind: 'tool_calls' as const,
    expected_tool: {
      tool: 'summarize_transactions',
      source_kind: 'ledger' as const,
      preset: 'last_month',
      types: ['expense'] as Array<'expense'>
    },
    truth: { kind: 'summary' as const, transaction_count: 230, expense_fen: 23000, income_fen: 0 },
    v2_comparable: true
  })),
  {
    id: 'summary-this-month-to-date',
    family: 'summary',
    text: '本月到今天为止已经消费了多少',
    critical: true,
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'summarize_transactions', source_kind: 'ledger', preset: 'this_month_to_date', types: ['expense'] },
    truth: { kind: 'summary', transaction_count: 5, expense_fen: 21080, income_fen: 0 },
    v2_comparable: true
  },
  {
    id: 'summary-yesterday',
    family: 'summary',
    text: '昨天花了多少',
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'summarize_transactions', source_kind: 'ledger', preset: 'yesterday', types: ['expense'] },
    truth: { kind: 'summary', transaction_count: 3, expense_fen: 18380, income_fen: 0 },
    v2_comparable: true
  },
  {
    id: 'summary-explicit-august',
    family: 'summary',
    text: '2026年8月支出多少',
    critical: true,
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: {
      tool: 'summarize_transactions', source_kind: 'ledger', types: ['expense'],
      explicit_from_prefix: '2026-08-01', explicit_to_prefix: '2026-09-01'
    },
    truth: { kind: 'summary', transaction_count: 230, expense_fen: 23000, income_fen: 0 },
    v2_comparable: true
  },
  ...groupVariants.map((text, index) => ({
    id: `group-last-month-${index + 1}`,
    family: 'group' as const,
    text,
    critical: index === 3,
    context: 'ledger' as const,
    expected_kind: 'tool_calls' as const,
    expected_tool: {
      tool: 'group_transactions', source_kind: 'ledger' as const, preset: 'last_month', types: ['expense'] as Array<'expense'>,
      dimension: 'category', metric: 'amount'
    },
    truth: { kind: 'group_top' as const, key: '外食', value: 15000, transaction_count: 150, expense_fen: 23000 },
    v2_comparable: true
  })),
  {
    id: 'details-this-month',
    family: 'details',
    text: '把本月到今天的支出记录列出来',
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'find_transactions', source_kind: 'ledger', preset: 'this_month_to_date', types: ['expense'] },
    truth: { kind: 'details_count', total_matching: 5 },
    v2_comparable: true
  },
  {
    id: 'extrema-largest-last-month',
    family: 'extrema',
    text: '上个月最大一笔支出是哪笔',
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'get_extrema', source_kind: 'ledger', preset: 'last_month', types: ['expense'], field: 'amount_fen', direction: 'max' },
    truth: { kind: 'extrema', transaction_id: 'aug-exp-0', amount_fen: 100, date: '2026-08-01' },
    v2_comparable: false
  },
  {
    id: 'extrema-earliest-last-month',
    family: 'extrema',
    text: '上个月最早一笔支出是哪天',
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'get_extrema', source_kind: 'ledger', preset: 'last_month', types: ['expense'], field: 'occurred_at', direction: 'min' },
    truth: { kind: 'extrema', transaction_id: 'aug-exp-0', amount_fen: 100, date: '2026-08-01' },
    v2_comparable: false
  },
  ...activeStartVariants.map((text, index) => ({
    id: `result-set-start-${index + 1}`,
    family: 'result_set' as const,
    text,
    critical: index === 0,
    context: 'active_result_set' as const,
    expected_kind: 'tool_calls' as const,
    expected_tool: { tool: 'describe_result_set', source_kind: 'active_result_set' as const },
    truth: {
      kind: 'result_set_description' as const,
      transaction_count: 5,
      earliest_date: '2026-09-03',
      latest_date: '2026-09-14',
      min_amount_fen: 1200,
      max_amount_fen: 11390
    },
    v2_comparable: false
  })),
  ...activeMaxVariants.map((text, index) => ({
    id: `result-set-max-${index + 1}`,
    family: 'result_set' as const,
    text,
    context: 'active_result_set' as const,
    expected_kind: 'tool_calls' as const,
    expected_tool: { tool: 'get_extrema', source_kind: 'active_result_set' as const, field: 'amount_fen', direction: 'max' },
    truth: { kind: 'extrema' as const, transaction_id: 'sep-5', amount_fen: 11390, date: '2026-09-14' },
    v2_comparable: false
  })),
  {
    id: 'result-set-summary',
    family: 'result_set',
    text: '这些记录一共花了多少',
    context: 'active_result_set',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'summarize_transactions', source_kind: 'active_result_set', types: ['expense'] },
    truth: { kind: 'summary', transaction_count: 5, expense_fen: 21080, income_fen: 0 },
    v2_comparable: false
  },
  {
    id: 'result-set-sort-desc',
    family: 'result_set',
    text: '把刚才这些按金额从高到低排',
    context: 'active_result_set',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'find_transactions', source_kind: 'active_result_set', order_field: 'amount_fen', order_direction: 'desc' },
    truth: { kind: 'details_count', total_matching: 5 },
    v2_comparable: false
  },
  {
    id: 'result-set-group',
    family: 'result_set',
    text: '这些支出里哪一类最多',
    context: 'active_result_set',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'group_transactions', source_kind: 'active_result_set', dimension: 'category', metric: 'amount' },
    truth: { kind: 'group_top', key: '外食', value: 21080, transaction_count: 5, expense_fen: 21080 },
    v2_comparable: false
  },
  {
    id: 'explicit-search',
    family: 'search',
    text: '查找本月包含“外食”的账目',
    critical: true,
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'search_transactions', source_kind: 'ledger', preset: 'this_month', explicit_search: true, query: '外食' },
    truth: { kind: 'search_count', total_matching: 5 },
    v2_comparable: true
  },
  {
    id: 'explicit-search-description',
    family: 'search',
    text: '搜索描述里有 sep-3 的记录',
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'search_transactions', source_kind: 'ledger', explicit_search: true, query: 'sep-3' },
    truth: { kind: 'search_count', total_matching: 1 },
    v2_comparable: true
  },
  {
    id: 'ordinary-intent-must-not-search-1',
    family: 'summary',
    text: '本月消费支出多少',
    critical: true,
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'summarize_transactions', source_kind: 'ledger', preset: 'this_month', types: ['expense'] },
    truth: { kind: 'summary', transaction_count: 5, expense_fen: 21080, income_fen: 0 },
    v2_comparable: true
  },
  {
    id: 'ordinary-intent-must-not-search-2',
    family: 'group',
    text: '本月哪一类消费最多',
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'group_transactions', source_kind: 'ledger', preset: 'this_month', types: ['expense'], dimension: 'category', metric: 'amount' },
    truth: { kind: 'group_top', key: '外食', value: 21080, transaction_count: 5, expense_fen: 21080 },
    v2_comparable: true
  },
  {
    id: 'compare-this-vs-last-month',
    family: 'compare',
    text: '本月和上个月的支出对比一下',
    context: 'ledger',
    expected_kind: 'tool_calls',
    expected_tool: { tool: 'compare_periods', source_kind: 'ledger', types: ['expense'] },
    v2_comparable: true
  },
  {
    id: 'clarification-no-result-reference',
    family: 'clarification',
    text: '这些里面最大一笔呢',
    context: 'ledger',
    expected_kind: 'clarification',
    v2_comparable: false
  },
  {
    id: 'non-finance-weather',
    family: 'non_finance',
    text: '今天东京天气怎么样',
    context: 'ledger',
    expected_kind: 'non_finance',
    v2_comparable: false
  }
];

export const FINANCE_V3_BENCHMARK_EVENT_TIME = '2026-09-15T08:20:00+08:00';
export const FINANCE_V3_BENCHMARK_SESSION_KEY = 'telegram:benchmark:topic:0';
export const FINANCE_V3_ACTIVE_RESULT_SET_ID = 'rs-september-active';
