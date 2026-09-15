import type { Env } from '../types';
import { auditV3ReadToolCall } from './auditor';
import type {
  V3AgentContext,
  V3AgentDecision,
  V3ReadFilters,
  V3ReadSource,
  V3ReadToolCall,
  V3TimeScope
} from './protocol';

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}

function numberValue(value: unknown, code: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function sourceValue(value: unknown, context: V3AgentContext): V3ReadSource {
  const source = objectValue(value, 'INVALID_V3_SOURCE');
  const kind = stringValue(source.kind, 'INVALID_V3_SOURCE');
  if (kind === 'ledger') return { kind: 'ledger' };
  if (kind === 'active_result_set') return { kind: 'active_result_set', session_key: context.session_key };
  if (kind === 'previous_result_set') return { kind: 'previous_result_set', session_key: context.session_key };
  throw new Error('INVALID_V3_SOURCE');
}

function scopeValue(value: unknown): V3TimeScope | null {
  if (value === undefined || value === null) return null;
  const scope = objectValue(value, 'INVALID_V3_SCOPE');
  const kind = stringValue(scope.kind, 'INVALID_V3_SCOPE');
  if (kind === 'preset') {
    const preset = stringValue(scope.preset, 'INVALID_V3_PRESET');
    if (!['today', 'yesterday', 'this_month', 'this_month_to_date', 'last_month', 'this_year', 'last_year'].includes(preset)) {
      throw new Error('INVALID_V3_PRESET');
    }
    return { kind: 'preset', preset: preset as Extract<V3TimeScope, { kind: 'preset' }>['preset'] };
  }
  if (kind === 'explicit') {
    return { kind: 'explicit', from: stringValue(scope.from, 'INVALID_V3_FROM'), to: stringValue(scope.to, 'INVALID_V3_TO') };
  }
  throw new Error('INVALID_V3_SCOPE');
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('INVALID_V3_STRING_ARRAY');
  return value.map((item) => stringValue(item, 'INVALID_V3_STRING_ARRAY'));
}

function filtersValue(value: unknown): V3ReadFilters | undefined {
  if (value === undefined || value === null) return undefined;
  const filters = objectValue(value, 'INVALID_V3_FILTERS');
  const typesRaw = strings(filters.types);
  if (typesRaw?.some((type) => !['expense', 'income', 'transfer'].includes(type))) throw new Error('INVALID_V3_TYPES');
  return {
    ...(typesRaw ? { types: typesRaw as V3ReadFilters['types'] } : {}),
    ...(filters.categories !== undefined ? { categories: strings(filters.categories) } : {}),
    ...(filters.accounts !== undefined ? { accounts: strings(filters.accounts) } : {}),
    ...(filters.merchant !== undefined ? { merchant: filters.merchant === null ? null : stringValue(filters.merchant, 'INVALID_V3_MERCHANT') } : {}),
    ...(filters.amount_min_fen !== undefined && filters.amount_min_fen !== null ? { amount_min_fen: numberValue(filters.amount_min_fen, 'INVALID_V3_AMOUNT') } : {}),
    ...(filters.amount_max_fen !== undefined && filters.amount_max_fen !== null ? { amount_max_fen: numberValue(filters.amount_max_fen, 'INVALID_V3_AMOUNT') } : {})
  };
}

function optionalLimit(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : numberValue(value, 'INVALID_V3_LIMIT');
}

export function validateV3ReadToolCall(value: unknown, context: V3AgentContext): V3ReadToolCall {
  const input = objectValue(value, 'INVALID_V3_TOOL_CALL');
  const tool = stringValue(input.tool, 'INVALID_V3_TOOL');

  if (tool === 'get_transaction') {
    const call: V3ReadToolCall = { tool, transaction_id: stringValue(input.transaction_id, 'INVALID_V3_TRANSACTION_ID') };
    auditV3ReadToolCall(call);
    return call;
  }

  const source = sourceValue(input.source, context);
  if (tool === 'describe_result_set') {
    if (source.kind === 'ledger') throw new Error('RESULT_SET_SOURCE_REQUIRED');
    const call: V3ReadToolCall = { tool, source };
    auditV3ReadToolCall(call);
    return call;
  }

  const scope = scopeValue(input.scope);
  const filters = filtersValue(input.filters);

  let call: V3ReadToolCall;
  if (tool === 'find_transactions') {
    let order: Extract<V3ReadToolCall, { tool: 'find_transactions' }>['order_by'];
    if (input.order_by) {
      const orderInput = objectValue(input.order_by, 'INVALID_V3_ORDER');
      const field = stringValue(orderInput.field, 'INVALID_V3_ORDER_FIELD');
      const direction = stringValue(orderInput.direction, 'INVALID_V3_ORDER_DIRECTION');
      if (!['occurred_at', 'amount_fen'].includes(field) || !['asc', 'desc'].includes(direction)) throw new Error('INVALID_V3_ORDER');
      order = { field: field as 'occurred_at' | 'amount_fen', direction: direction as 'asc' | 'desc' };
    }
    call = { tool, source, scope, filters, ...(order ? { order_by: order } : {}), ...(input.limit !== undefined ? { limit: optionalLimit(input.limit) } : {}) };
  } else if (tool === 'summarize_transactions') {
    call = { tool, source, scope, filters };
  } else if (tool === 'group_transactions') {
    const dimension = stringValue(input.dimension, 'INVALID_V3_DIMENSION');
    const metric = stringValue(input.metric, 'INVALID_V3_METRIC');
    if (!['category', 'date', 'account', 'merchant'].includes(dimension)) throw new Error('INVALID_V3_DIMENSION');
    if (!['amount', 'count', 'net'].includes(metric)) throw new Error('INVALID_V3_METRIC');
    call = { tool, source, scope, filters, dimension: dimension as never, metric: metric as never, ...(input.limit !== undefined ? { limit: optionalLimit(input.limit) } : {}) };
  } else if (tool === 'get_extrema') {
    const field = stringValue(input.field, 'INVALID_V3_EXTREMA_FIELD');
    const direction = stringValue(input.direction, 'INVALID_V3_EXTREMA_DIRECTION');
    if (!['occurred_at', 'amount_fen'].includes(field) || !['min', 'max'].includes(direction)) throw new Error('INVALID_V3_EXTREMA');
    call = { tool, source, scope, filters, field: field as never, direction: direction as never };
  } else if (tool === 'search_transactions') {
    call = {
      tool,
      source,
      scope,
      filters,
      explicit_search: input.explicit_search === true,
      query: stringValue(input.query, 'INVALID_V3_SEARCH_QUERY'),
      ...(input.limit !== undefined ? { limit: optionalLimit(input.limit) } : {})
    } as V3ReadToolCall;
  } else if (tool === 'compare_periods') {
    if (source.kind !== 'ledger') throw new Error('COMPARE_LEDGER_ONLY');
    const left = scopeValue(input.left);
    const right = scopeValue(input.right);
    if (!left || !right) throw new Error('COMPARE_SCOPE_REQUIRED');
    call = { tool, source, left, right, filters };
  } else {
    throw new Error('INVALID_V3_TOOL');
  }

  auditV3ReadToolCall(call);
  return call;
}

function responseSchema(): Record<string, unknown> {
  const source = {
    type: 'object', additionalProperties: false, required: ['kind'],
    properties: { kind: { type: 'string', enum: ['ledger', 'active_result_set', 'previous_result_set'] } }
  };
  const scope = {
    anyOf: [
      { type: 'null' },
      {
        type: 'object', additionalProperties: false, required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['preset'] },
          preset: { type: 'string', enum: ['today', 'yesterday', 'this_month', 'this_month_to_date', 'last_month', 'this_year', 'last_year'] }
        }
      },
      {
        type: 'object', additionalProperties: false, required: ['kind', 'from', 'to'],
        properties: { kind: { type: 'string', enum: ['explicit'] }, from: { type: 'string' }, to: { type: 'string' } }
      }
    ]
  };
  const filters = {
    type: ['object', 'null'], additionalProperties: false,
    properties: {
      types: { type: 'array', items: { type: 'string', enum: ['expense', 'income', 'transfer'] } },
      categories: { type: 'array', items: { type: 'string' } },
      accounts: { type: 'array', items: { type: 'string' } },
      merchant: { type: ['string', 'null'] },
      amount_min_fen: { type: ['integer', 'null'], minimum: 0 },
      amount_max_fen: { type: ['integer', 'null'], minimum: 0 }
    }
  };
  const call = {
    type: 'object',
    additionalProperties: false,
    required: ['tool'],
    properties: {
      tool: { type: 'string', enum: ['find_transactions', 'summarize_transactions', 'group_transactions', 'get_extrema', 'compare_periods', 'search_transactions', 'describe_result_set', 'get_transaction'] },
      source,
      scope,
      filters,
      order_by: {
        type: ['object', 'null'], additionalProperties: false,
        properties: { field: { type: 'string', enum: ['occurred_at', 'amount_fen'] }, direction: { type: 'string', enum: ['asc', 'desc'] } },
        required: ['field', 'direction']
      },
      limit: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
      dimension: { type: 'string', enum: ['category', 'date', 'account', 'merchant'] },
      metric: { type: 'string', enum: ['amount', 'count', 'net'] },
      field: { type: 'string', enum: ['occurred_at', 'amount_fen'] },
      direction: { type: 'string', enum: ['min', 'max'] },
      left: scope,
      right: scope,
      explicit_search: { type: 'boolean' },
      query: { type: 'string' },
      transaction_id: { type: 'string' }
    }
  };
  return {
    name: 'finance_v3_read_agent',
    strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['tool_calls', 'clarification', 'non_finance'] },
        calls: { type: 'array', maxItems: 3, items: call },
        message: { type: ['string', 'null'] }
      }
    }
  };
}

function parseAiResponse(result: unknown): unknown {
  const response = (result as { response?: unknown } | null)?.response;
  if (typeof response === 'string') return JSON.parse(response);
  return response;
}

export async function planV3ReadRequest(env: Env, text: string, context: V3AgentContext): Promise<V3AgentDecision> {
  if (!text.trim()) throw new Error('EMPTY_V3_REQUEST');
  const result = await env.AI.run(env.AI_MODEL, {
    messages: [
      {
        role: 'system',
        content: [
          '你是云枢 Finance V3 Read Agent，只负责理解自然语言并选择只读财务工具。',
          '禁止生成 SQL，禁止自行计算日期、金额、比例、最大最小值；这些事实全部由确定性工具计算。',
          '可用工具：find_transactions, summarize_transactions, group_transactions, get_extrema, compare_periods, search_transactions, describe_result_set, get_transaction。',
          '相对日期只选择 preset，不生成 from/to：today/yesterday/this_month/this_month_to_date/last_month/this_year/last_year。',
          '用户说“这些记录/刚才那些/上面这些”时优先 source=active_result_set；说上一批时使用 previous_result_set。',
          '询问这些记录从哪天开始/最早日期时，优先 describe_result_set；询问最早/最晚/最大/最小某一笔可使用 get_extrema。',
          '普通“消费/支出/收入/花了多少/哪一类”等意图词绝不能触发全文搜索。只有用户明确要求“包含某关键词/搜索某词/描述里有某词”时才能使用 search_transactions，并必须 explicit_search=true。',
          '按分类/日期/账户/商户汇总或询问哪一类最多使用 group_transactions。group_transactions 的结果同时包含总 summary，不需要为“总额+最大分类”重复调用 summarize。',
          '只问总支出/收入/结余/笔数使用 summarize_transactions；要明细使用 find_transactions。',
          '如果缺少关键语义且不能安全确定，返回 clarification；非财务问题返回 non_finance。',
          '最多返回 3 个工具调用，不执行写入。',
          `消息 event_time=${context.event_time}，session_key=${context.session_key}。`,
          context.active_result_set_id ? `当前 active_result_set_id 已存在：${context.active_result_set_id}。模型不要复制该 ID，只选择 active_result_set source。` : '当前没有 active result set。',
          context.previous_result_set_id ? `存在 previous_result_set_id：${context.previous_result_set_id}。模型不要复制该 ID，只选择 previous_result_set source。` : ''
        ].filter(Boolean).join('\n')
      },
      { role: 'user', content: text }
    ],
    max_tokens: 800,
    response_format: { type: 'json_schema', json_schema: responseSchema() }
  });

  const parsed = objectValue(parseAiResponse(result), 'INVALID_V3_AGENT_RESPONSE');
  const kind = stringValue(parsed.kind, 'INVALID_V3_AGENT_KIND');
  if (kind === 'clarification') return { kind, message: stringValue(parsed.message, 'INVALID_V3_CLARIFICATION') };
  if (kind === 'non_finance') return { kind };
  if (kind !== 'tool_calls' || !Array.isArray(parsed.calls) || parsed.calls.length < 1 || parsed.calls.length > 3) {
    throw new Error('INVALID_V3_AGENT_CALLS');
  }
  return { kind: 'tool_calls', calls: parsed.calls.map((call) => validateV3ReadToolCall(call, context)) };
}
