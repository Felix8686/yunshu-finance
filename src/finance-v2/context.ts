import {
  FINANCE_SCHEMA_VERSION,
  LEDGER_SCOPE_ID,
  MAX_RECENT_TURN_SUMMARIES,
  canonicalizeJson,
  sha256Hex,
  type FinancePlan,
  type ResultWindow,
  type TurnContextSnapshot
} from './protocol';
import { MAX_RESULT_SET_ROWS } from './capacity';

function validateHash(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(code);
}

function validateWindow(window: ResultWindow | null): void {
  if (!window) return;
  if (!window.result_set_id || !Number.isInteger(window.result_set_version) || window.result_set_version < 1
    || !Number.isInteger(window.start_ordinal) || window.start_ordinal < 1
    || !Number.isInteger(window.end_ordinal) || window.end_ordinal < window.start_ordinal
    || window.end_ordinal - window.start_ordinal + 1 > MAX_RESULT_SET_ROWS
    || !Number.isInteger(window.page_size) || window.page_size < 1 || window.page_size > 20) {
    throw new Error('INVALID_CONTEXT_RESULT_WINDOW');
  }
}

export async function buildTurnContextSnapshot(input: {
  turnId: string;
  sessionKey: string;
  baseSessionVersion: number;
  activePlan: FinancePlan | null;
  activeResultSetId: string | null;
  activeWindow: ResultWindow | null;
  previousWindow: ResultWindow | null;
  recentTurnSummaries: string[];
  catalogHash: string;
  capturedAt?: string;
}): Promise<TurnContextSnapshot> {
  if (!Number.isInteger(input.baseSessionVersion) || input.baseSessionVersion < 0) throw new Error('INVALID_CONTEXT_BASE_SESSION_VERSION');
  const capturedAt = input.capturedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('INVALID_CONTEXT_CAPTURED_AT');
  validateHash(input.catalogHash, 'INVALID_CONTEXT_CATALOG_HASH');
  validateWindow(input.activeWindow);
  validateWindow(input.previousWindow);
  const snapshotWithoutHash = {
    schema_version: FINANCE_SCHEMA_VERSION,
    snapshot_id: 'pending',
    turn_id: input.turnId,
    ledger_scope_id: LEDGER_SCOPE_ID,
    session_key: input.sessionKey,
    base_session_version: input.baseSessionVersion,
    active_plan: input.activePlan,
    active_result_set_id: input.activeResultSetId,
    active_window: input.activeWindow,
    previous_window: input.previousWindow,
    recent_turn_summaries: input.recentTurnSummaries
      .filter((summary) => typeof summary === 'string' && summary.trim())
      .slice(-MAX_RECENT_TURN_SUMMARIES)
      .map((summary) => summary.slice(0, 512)),
    catalog_hash: input.catalogHash,
    snapshot_hash: '',
    captured_at: capturedAt
  };
  const snapshotId = `snapshot_${await sha256Hex(`${input.turnId}\n${capturedAt}`)}`;
  const withIdentity = { ...snapshotWithoutHash, snapshot_id: snapshotId };
  return { ...withIdentity, snapshot_hash: await sha256Hex(canonicalizeJson(withIdentity)) };
}
