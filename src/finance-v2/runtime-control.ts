import { ProtocolValidationError, type FinanceOperationType, type RuntimeControl } from './protocol';

export type RuntimeControlPatch = Partial<Pick<RuntimeControl, 'finance_route_mode' | 'receipt_route_mode' | 'outbox_mode' | 'shadow_mode' | 'analysis_prose_enabled'>>;

const FINANCE_TRANSITIONS: Record<RuntimeControl['finance_route_mode'], RuntimeControl['finance_route_mode'][]> = {
  primary_v1: ['shadow_v2'],
  shadow_v2: ['canary_v2', 'primary_v1'],
  canary_v2: ['primary_v2', 'draining_v2'],
  primary_v2: ['draining_v2'],
  draining_v2: ['primary_v1']
};

const RECEIPT_TRANSITIONS: Record<RuntimeControl['receipt_route_mode'], RuntimeControl['receipt_route_mode'][]> = {
  v1: ['draining_v1'],
  draining_v1: ['v2'],
  v2: ['draining_v2'],
  draining_v2: ['v1']
};

const OUTBOX_TRANSITIONS: Record<RuntimeControl['outbox_mode'], RuntimeControl['outbox_mode'][]> = {
  paused: ['enabled'],
  enabled: ['paused', 'draining'],
  draining: ['paused', 'enabled']
};

const SHADOW_TRANSITIONS: Record<RuntimeControl['shadow_mode'], RuntimeControl['shadow_mode'][]> = {
  off: ['interpretation_only'],
  interpretation_only: ['off']
};

const RUNTIME_PATCH_KEYS = new Set<keyof RuntimeControlPatch>([
  'finance_route_mode',
  'receipt_route_mode',
  'outbox_mode',
  'shadow_mode',
  'analysis_prose_enabled'
]);

function assertRuntimePatchShape(patch: RuntimeControlPatch): void {
  for (const key of Object.keys(patch) as Array<keyof RuntimeControlPatch>) {
    if (!RUNTIME_PATCH_KEYS.has(key)) {
      throw new ProtocolValidationError('invalid_runtime_control', `unknown runtime control field: ${String(key)}`);
    }
  }
  if (patch.finance_route_mode !== undefined && !Object.hasOwn(FINANCE_TRANSITIONS, patch.finance_route_mode)) {
    throw new ProtocolValidationError('invalid_runtime_control', 'invalid finance route mode');
  }
  if (patch.receipt_route_mode !== undefined && !Object.hasOwn(RECEIPT_TRANSITIONS, patch.receipt_route_mode)) {
    throw new ProtocolValidationError('invalid_runtime_control', 'invalid receipt route mode');
  }
  if (patch.outbox_mode !== undefined && !Object.hasOwn(OUTBOX_TRANSITIONS, patch.outbox_mode)) {
    throw new ProtocolValidationError('invalid_runtime_control', 'invalid outbox mode');
  }
  if (patch.shadow_mode !== undefined && !Object.hasOwn(SHADOW_TRANSITIONS, patch.shadow_mode)) {
    throw new ProtocolValidationError('invalid_runtime_control', 'invalid shadow mode');
  }
}

function transitionAllowed<T extends string>(
  field: string,
  current: T,
  next: T,
  transitions: Record<T, T[]>
): void {
  if (current === next) return;
  if (!transitions[current].includes(next)) {
    throw new ProtocolValidationError('illegal_runtime_transition', `${field} cannot transition from ${current} to ${next}`);
  }
}

export function planRuntimeControlTransition(current: RuntimeControl, patch: RuntimeControlPatch): RuntimeControl {
  assertRuntimePatchShape(patch);
  const next: RuntimeControl = {
    ...current,
    ...patch,
    config_epoch: current.config_epoch,
    updated_at: current.updated_at
  };
  if (next.finance_route_mode === 'shadow_v2' && patch.shadow_mode === undefined) next.shadow_mode = 'interpretation_only';
  if (current.finance_route_mode === 'shadow_v2' && next.finance_route_mode !== 'shadow_v2' && patch.shadow_mode === undefined) next.shadow_mode = 'off';
  transitionAllowed('finance_route_mode', current.finance_route_mode, next.finance_route_mode, FINANCE_TRANSITIONS);
  transitionAllowed('receipt_route_mode', current.receipt_route_mode, next.receipt_route_mode, RECEIPT_TRANSITIONS);
  transitionAllowed('outbox_mode', current.outbox_mode, next.outbox_mode, OUTBOX_TRANSITIONS);
  transitionAllowed('shadow_mode', current.shadow_mode, next.shadow_mode, SHADOW_TRANSITIONS);
  if (next.finance_route_mode === 'shadow_v2' && next.shadow_mode !== 'interpretation_only') {
    throw new ProtocolValidationError('invalid_shadow_route_pair', 'shadow_v2 requires interpretation_only shadow mode');
  }
  if (next.finance_route_mode !== 'shadow_v2' && next.shadow_mode === 'interpretation_only') {
    throw new ProtocolValidationError('invalid_shadow_route_pair', 'interpretation_only shadow mode requires shadow_v2 route');
  }
  if (next.analysis_prose_enabled !== 0 && next.analysis_prose_enabled !== 1) {
    throw new ProtocolValidationError('invalid_runtime_control', 'analysis prose flag must be 0 or 1');
  }
  const changed = current.finance_route_mode !== next.finance_route_mode
    || current.receipt_route_mode !== next.receipt_route_mode
    || current.outbox_mode !== next.outbox_mode
    || current.shadow_mode !== next.shadow_mode
    || current.analysis_prose_enabled !== next.analysis_prose_enabled;
  if (!changed) return current;
  return { ...next, config_epoch: current.config_epoch + 1, updated_at: new Date().toISOString() };
}

export function routeAllowsOperation(control: RuntimeControl, operation: FinanceOperationType | 'outbox'): boolean {
  if (operation === 'outbox') return control.outbox_mode === 'enabled' || control.outbox_mode === 'draining';
  if (operation === 'receipt_create') return control.receipt_route_mode === 'v2';
  return control.finance_route_mode === 'canary_v2' || control.finance_route_mode === 'primary_v2';
}
