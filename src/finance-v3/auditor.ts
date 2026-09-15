import type { V3ReadToolCall } from './protocol';

export class V3ReadAuditError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'V3ReadAuditError';
  }
}

function assertSource(call: V3ReadToolCall): void {
  if (!('source' in call)) return;
  const source = call.source;
  if (source.kind === 'result_set' && !source.result_set_id.trim()) {
    throw new V3ReadAuditError('RESULT_SET_REQUIRED', 'result_set source requires result_set_id');
  }
  if ((source.kind === 'active_result_set' || source.kind === 'previous_result_set') && !source.session_key.trim()) {
    throw new V3ReadAuditError('SESSION_KEY_REQUIRED', `${source.kind} requires session_key`);
  }
}

function assertFilters(call: V3ReadToolCall): void {
  if (!('filters' in call) || !call.filters) return;
  const { amount_min_fen: min, amount_max_fen: max } = call.filters;
  if (typeof min === 'number' && min < 0) throw new V3ReadAuditError('INVALID_AMOUNT_RANGE', 'amount_min_fen must be non-negative');
  if (typeof max === 'number' && max < 0) throw new V3ReadAuditError('INVALID_AMOUNT_RANGE', 'amount_max_fen must be non-negative');
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    throw new V3ReadAuditError('INVALID_AMOUNT_RANGE', 'amount_min_fen exceeds amount_max_fen');
  }
}

function assertLimit(call: V3ReadToolCall): void {
  if (!('limit' in call) || call.limit === undefined) return;
  if (!Number.isInteger(call.limit) || call.limit < 1 || call.limit > 100) {
    throw new V3ReadAuditError('INVALID_LIMIT', 'limit must be an integer between 1 and 100');
  }
}

export function auditV3ReadToolCall(call: V3ReadToolCall): void {
  assertSource(call);
  assertFilters(call);
  assertLimit(call);

  if (call.tool === 'search_transactions') {
    if (call.explicit_search !== true) {
      throw new V3ReadAuditError('EXPLICIT_SEARCH_REQUIRED', 'full-text search requires explicit_search=true');
    }
    if (!call.query.trim()) {
      throw new V3ReadAuditError('SEARCH_QUERY_REQUIRED', 'search query cannot be empty');
    }
    if (call.query.trim().length > 128) {
      throw new V3ReadAuditError('SEARCH_QUERY_TOO_LONG', 'search query is too long');
    }
  }

  if (call.tool === 'compare_periods' && call.source.kind !== 'ledger') {
    throw new V3ReadAuditError('COMPARE_LEDGER_ONLY', 'compare_periods currently operates on the ledger only');
  }

  if (call.tool === 'describe_result_set' && call.source.kind === 'result_set' && !call.source.result_set_id.trim()) {
    throw new V3ReadAuditError('RESULT_SET_REQUIRED', 'describe_result_set requires a concrete result set');
  }
}
