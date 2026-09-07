# Finance Orchestrator V2 — Revision 4 Migration / Cutover / Rollback Runbook

Status: architecture-only normative runbook. The SQL below defines the intended 0008/0009 migration family but is not yet authorized for production execution.

Production baseline at architecture freeze: `main` = `b707ddb8a5c627ceb0677c1677e9c4b59005fe19`.

## 1. Non-negotiable rollout rules

1. Existing ledger tables (`transactions`, `transaction_items`, accounts/categories) are not destructively rewritten for V2.
2. V2 state is additive in 0008.
3. 0009 only repairs the historical recovery-log FK/evidence model required before V2 destructive delete.
4. Once V2 write canary begins, a pre-V2 binary that cannot read runtime control/fencing is not a normal rollback target.
5. Rollback means route-state rollback inside a V2-capable binary; committed V2 ledger mutations remain valid history.
6. Queue/outbox/provider external side effects are never treated as part of a D1 transaction.
7. Every runtime state transition increments `config_epoch`.
8. Every V2 mutation stores that epoch as `route_epoch`; every protected side-effect statement and terminal update must fence operation `lease_epoch` **and** the current runtime-control `config_epoch` plus the operation-specific allowed route mode.
9. V2's declared atomic bounds require a Workers Paid deployment. A Free-plan account is not an acceptable fallback target because its D1 per-invocation query limit is 50, below the worst-case V2 operation budget.

The rollout preflight must record the Cloudflare account plan and fail closed unless it is Workers Paid. It must not claim that the `MAX_D1_BATCH_STATEMENTS = 256` contract works on Free, and it must not silently lower product bounds during deployment.

## 2. Proposed 0008 — V2 state/control tables

The implementation migration may change comments/formatting, but table/constraint semantics require architecture re-review if changed.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS finance_runtime_control (
  control_id TEXT PRIMARY KEY CHECK (control_id = 'primary'),
  config_epoch INTEGER NOT NULL CHECK (config_epoch >= 1),
  finance_route_mode TEXT NOT NULL CHECK (finance_route_mode IN (
    'primary_v1','shadow_v2','canary_v2','draining_v2','primary_v2'
  )),
  receipt_route_mode TEXT NOT NULL CHECK (receipt_route_mode IN (
    'v1','draining_v1','v2','draining_v2'
  )),
  outbox_mode TEXT NOT NULL CHECK (outbox_mode IN ('paused','enabled','draining')),
  shadow_mode TEXT NOT NULL CHECK (shadow_mode IN ('off','interpretation_only')),
  analysis_prose_enabled INTEGER NOT NULL CHECK (analysis_prose_enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO finance_runtime_control (
  control_id, config_epoch, finance_route_mode, receipt_route_mode,
  outbox_mode, shadow_mode, analysis_prose_enabled
) VALUES ('primary', 1, 'primary_v1', 'v1', 'paused', 'off', 0);

CREATE TABLE IF NOT EXISTS finance_channel_cursors (
  ledger_scope_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  cursor_epoch INTEGER NOT NULL DEFAULT 0 CHECK (cursor_epoch >= 0),
  last_order_key INTEGER,
  last_received_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ledger_scope_id, channel)
);

CREATE TABLE IF NOT EXISTS finance_turns (
  turn_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  ordering_epoch INTEGER,
  ordering_key INTEGER,
  event_time TEXT NOT NULL,
  received_time TEXT NOT NULL,
  base_session_version INTEGER,
  context_snapshot_json TEXT,
  context_snapshot_hash TEXT,
  interpretation_json TEXT,
  interpretation_status TEXT,
  plan_id TEXT,
  result_id TEXT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE (ledger_scope_id, channel, channel_event_id)
);

CREATE INDEX IF NOT EXISTS idx_finance_turns_session_created
  ON finance_turns(ledger_scope_id, session_key, created_at);

CREATE TABLE IF NOT EXISTS finance_sessions (
  ledger_scope_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0),
  active_plan_id TEXT,
  active_plan_version INTEGER,
  active_result_set_id TEXT,
  active_window_start_ordinal INTEGER,
  active_window_end_ordinal INTEGER,
  previous_window_start_ordinal INTEGER,
  previous_window_end_ordinal INTEGER,
  last_turn_id TEXT,
  compatibility_interrupted INTEGER NOT NULL DEFAULT 0 CHECK (compatibility_interrupted IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  PRIMARY KEY (ledger_scope_id, session_key)
);

CREATE TABLE IF NOT EXISTS finance_plans (
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  ledger_scope_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id, plan_version)
);

CREATE TABLE IF NOT EXISTS finance_result_sets (
  result_set_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  result_set_version INTEGER NOT NULL DEFAULT 1 CHECK (result_set_version >= 1),
  row_count INTEGER NOT NULL CHECK (row_count >= 0 AND row_count <= 200),
  page_size INTEGER NOT NULL CHECK (page_size >= 1 AND page_size <= 20),
  sort_filter_fingerprint TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0 AND snapshot_bytes <= 262144),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_result_set_items (
  result_set_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 200),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_fingerprint TEXT NOT NULL,
  row_snapshot_json TEXT NOT NULL,
  row_snapshot_bytes INTEGER NOT NULL CHECK (row_snapshot_bytes >= 2 AND row_snapshot_bytes <= 8192),
  PRIMARY KEY (result_set_id, ordinal),
  FOREIGN KEY (result_set_id) REFERENCES finance_result_sets(result_set_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_finance_resultsets_expiry
  ON finance_result_sets(ledger_scope_id, expires_at);

CREATE TABLE IF NOT EXISTS finance_results (
  result_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  operation_id TEXT,
  schema_version INTEGER NOT NULL,
  operation_type TEXT NOT NULL,
  result_json TEXT NOT NULL,
  render_payload_json TEXT NOT NULL,
  render_hash TEXT NOT NULL,
  result_set_id TEXT,
  result_json_bytes INTEGER NOT NULL CHECK (result_json_bytes >= 0 AND result_json_bytes <= 131072),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  FOREIGN KEY (result_set_id) REFERENCES finance_result_sets(result_set_id)
);

CREATE TABLE IF NOT EXISTS finance_operations (
  operation_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'reserved','executing','committed','rejected','failed_terminal'
  )),
  plan_id TEXT,
  plan_version INTEGER,
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
  route_epoch INTEGER NOT NULL CHECK (route_epoch >= 1),
  result_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  committed_at TEXT,
  UNIQUE (ledger_scope_id, idempotency_key),
  FOREIGN KEY (result_id) REFERENCES finance_results(result_id)
);

CREATE INDEX IF NOT EXISTS idx_finance_operations_reclaim
  ON finance_operations(ledger_scope_id, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS finance_audit_snapshots (
  audit_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  child_set_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (operation_id) REFERENCES finance_operations(operation_id)
);

CREATE TABLE IF NOT EXISTS finance_session_references (
  reference_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  reference_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  source_result_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_finance_session_refs
  ON finance_session_references(ledger_scope_id, session_key, created_at);

CREATE TABLE IF NOT EXISTS finance_outbox (
  outbox_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  delivery_request_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK (part_index >= 0 AND part_index < 16),
  render_hash TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type = 'telegram_owner'),
  destination_id TEXT NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending','sending','accepted','failed_retryable','failed_terminal','unknown'
  )),
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at TEXT,
  route_epoch INTEGER NOT NULL CHECK (route_epoch >= 1),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  last_attempt_started_at TEXT,
  telegram_message_id INTEGER,
  last_error_code TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT,
  UNIQUE (ledger_scope_id, delivery_request_id, part_index),
  FOREIGN KEY (result_id) REFERENCES finance_results(result_id)
);

CREATE INDEX IF NOT EXISTS idx_finance_outbox_due
  ON finance_outbox(ledger_scope_id, status, next_attempt_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS finance_receipt_jobs (
  job_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  attachment_ref TEXT NOT NULL,
  caption TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued','processing','artifact_ready','committed','rejected','failed_terminal'
  )),
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
  route_epoch INTEGER NOT NULL CHECK (route_epoch >= 1),
  receipt_artifact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE (ledger_scope_id, source_event_id, attachment_ref)
);

CREATE INDEX IF NOT EXISTS idx_finance_receipt_jobs_reclaim
  ON finance_receipt_jobs(ledger_scope_id, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS finance_receipt_provider_attempts (
  provider_attempt_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  job_lease_epoch INTEGER NOT NULL CHECK (job_lease_epoch >= 0),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1 AND attempt_number <= 3),
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','unknown')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  FOREIGN KEY (job_id) REFERENCES finance_receipt_jobs(job_id)
);

CREATE TABLE IF NOT EXISTS finance_receipt_artifacts (
  receipt_artifact_id TEXT PRIMARY KEY,
  ledger_scope_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  attachment_ref TEXT NOT NULL,
  provider_attempt_id TEXT NOT NULL,
  job_lease_epoch INTEGER NOT NULL CHECK (job_lease_epoch >= 0),
  schema_version INTEGER NOT NULL,
  artifact_json TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ledger_scope_id, job_id),
  FOREIGN KEY (job_id) REFERENCES finance_receipt_jobs(job_id),
  FOREIGN KEY (provider_attempt_id) REFERENCES finance_receipt_provider_attempts(provider_attempt_id)
);
```

### 2.1 0008 acceptance before remote use

Must pass:

- fresh DB apply 0001-0008;
- existing 0001-0007 DB apply 0008;
- all indexes/constraints introspected after apply;
- duplicate scoped idempotency rejected;
- duplicate `(delivery_request_id, part_index)` rejected;
- the same immutable `result_id` can create a second outbox delivery request only with a different explicit replay identity;
- repeating the same replay turn/idempotency key resolves to the existing delivery request and creates no additional rows;
- a post-transition claim rebinds an eligible pending/retryable outbox row to the current route epoch, while an in-flight old-epoch sender remains fenced;
- raw provider response bodies cannot be persisted in outbox delivery metadata;
- operation lease epoch CAS/reclaim isolated tests;
- `finance_result_sets.snapshot_bytes > 262144` rejected;
- `row_snapshot_bytes > 8192` rejected;
- result-set writers recompute canonical UTF-8 row/snapshot bytes, row count, and ordinals instead of trusting caller-declared values;
- runtime-control invalid enum combinations rejected by application state transition validator;
- runtime route witness rejects stale `config_epoch` and disallowed route mode for operation, receipt, and outbox terminal statements;
- `git diff --check`, typecheck, dry-run.

## 3. Proposed 0009 — preserve immutable recovery identity

Current 0005 uses `transaction_id TEXT NOT NULL` as both historical identity and live FK. `ON DELETE SET NULL` by itself would erase that historical identity. Revision 4 splits them.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE finance_fidelity_recovery_log_new (
  run_id TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  transaction_id TEXT,
  old_category_id TEXT,
  old_account_id TEXT,
  target_category_name TEXT,
  target_account_name TEXT,
  category_changed INTEGER NOT NULL DEFAULT 0 CHECK (category_changed IN (0,1)),
  account_changed INTEGER NOT NULL DEFAULT 0 CHECK (account_changed IN (0,1)),
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, original_transaction_id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

INSERT INTO finance_fidelity_recovery_log_new (
  run_id, original_transaction_id, transaction_id,
  old_category_id, old_account_id,
  target_category_name, target_account_name,
  category_changed, account_changed, evidence_json, created_at
)
SELECT
  run_id, transaction_id, transaction_id,
  old_category_id, old_account_id,
  target_category_name, target_account_name,
  category_changed, account_changed, evidence_json, created_at
FROM finance_fidelity_recovery_log;

DROP TABLE finance_fidelity_recovery_log;
ALTER TABLE finance_fidelity_recovery_log_new RENAME TO finance_fidelity_recovery_log;

CREATE INDEX idx_finance_fidelity_recovery_run
  ON finance_fidelity_recovery_log(run_id);
CREATE INDEX idx_finance_fidelity_recovery_live_tx
  ON finance_fidelity_recovery_log(transaction_id);
```

After hard delete, `original_transaction_id` remains immutable evidence while live `transaction_id` becomes NULL.

### 3.1 0009 acceptance before destructive V2 delete

On fresh and 0001-0007 upgrade fixtures:

1. create transaction + recovery row;
2. verify original/live IDs equal before delete;
3. delete parent transaction;
4. verify delete succeeds;
5. verify recovery `transaction_id IS NULL`;
6. verify `original_transaction_id` is unchanged;
7. verify evidence columns are unchanged;
8. verify unrelated recovery rows unchanged;
9. verify receipt `transaction_items` cascade remains expected;
10. verify V2 delete audit snapshot contains the exact pre-delete parent + ordered child set.

Until this passes on a production-sized isolated copy, V2 destructive delete of rows referenced by recovery evidence is disabled.

## 4. Runtime state-transition rules

All transitions are conditional updates on the single `finance_runtime_control` row and increment `config_epoch` by exactly one.

Illegal transitions are rejected by application code and architecture tests.

### 4.1 Finance route

```text
primary_v1
  -> shadow_v2
  -> canary_v2
  -> primary_v2

canary_v2 | primary_v2
  -> draining_v2
  -> primary_v1
```

`draining_v2` accepts no new V2 mutation reservations.

Because entering `draining_v2` increments `config_epoch`, an operation reserved under the previous epoch cannot complete a ledger mutation: every side-effect statement and its terminal update must observe the current epoch and an allowed `canary_v2|primary_v2` mode. The same rule applies when the route is already `primary_v1`.

### 4.2 Receipt route

```text
v1 -> draining_v1 -> v2
v2 -> draining_v2 -> v1
```

`draining_*` accepts no new receipt enqueue for the route being drained.

Receipt artifact/provider completion is also fenced by the current control epoch and `receipt_route_mode = 'v2'`; a stale V2 job cannot publish after `draining_v2` or `v1` becomes current.

### 4.3 Outbox route

```text
paused <-> enabled

enabled -> draining -> paused
```

`draining` creates no new explicit replay requests. It may claim already committed `pending`/`failed_retryable` rows under the new current route epoch; the claim must atomically read the current control row, increment `lease_epoch`, and rebind `finance_outbox.route_epoch` to that current `config_epoch`. Their terminal update must observe `config_epoch = finance_outbox.route_epoch` plus `outbox_mode IN ('enabled','draining')`. A sender claimed before a transition is fenced when the epoch changes, while `unknown` is never implicitly re-bound or resent.

### 4.4 Shadow

`off <-> interpretation_only` only.

## 5. First V2-capable deployment sequence

1. Confirm production main/DB backup evidence and current migrations 0001-0007.
2. Apply 0008/0009 only after all isolated migration tests pass.
3. Deploy a V2-capable binary while runtime control remains `primary_v1 / receipt=v1 / outbox=paused / shadow=off`.
4. Verify V1 behavior is unchanged and V2 primary route is unreachable.
5. Verify the V2-capable binary reads `finance_runtime_control` and owner settings.
6. Verify the Cloudflare account is Workers Paid and record the plan evidence alongside the capacity gate.
7. Verify pre-V2 binaries are no longer part of the normal rollback procedure.
8. Only then enable `shadow_v2` if shadow acceptance has passed.

No V2 mutation canary is allowed before steps 1-8 pass.

## 6. V1 -> V2 finance cutover

1. `primary_v1 -> shadow_v2`; collect interpretation-only evidence.
2. Architecture guard, schema, migration, crash/fence, ResultSet, receipt and outbox tests must all be green.
3. `shadow_v2 -> canary_v2`; increment config epoch.
4. Canary is capability-scoped, not random per-turn traffic splitting.
5. A capability routed to V2 has no automatic semantic fallback to V1.
6. Before each V2 mutation reservation, read current config epoch/mode.
7. Every mutation statement and final operation update is fenced by operation lease epoch + stored route epoch + current control config epoch + operation-specific allowed mode.
8. After canary evidence window, `canary_v2 -> primary_v2`.

## 7. Finance semantic rollback

Use this when interpretation/executor/session/reference behavior is defective but committed outbox delivery itself is healthy.

1. transition `canary_v2|primary_v2 -> draining_v2`; increment config epoch;
2. stop new V2 mutation reservations immediately;
3. wait at least one operation lease horizon;
4. any old Worker completion with stale `route_epoch`, `lease_epoch`, current `config_epoch`, or route mode becomes a fenced no-op;
5. reclaim expired uncommitted operations only for terminal settlement; do not execute a new mutation during rollback drain;
6. mark unrecoverable uncommitted operations `failed_terminal` with `rollout_interrupted` result;
7. require query evidence: zero `reserved/executing` operations with an active lease;
8. keep outbox `enabled` or set `draining` so already committed V2 results can still be delivered;
9. transition finance route to `primary_v1`; increment config epoch;
10. mark V2 sessions touched by V1 compatibility as `compatibility_interrupted=1`;
11. do not delete V2 result/operation/audit/reference history.

Rollback success signal:

```text
finance_route_mode = primary_v1
zero active V2 mutation leases
no stale-epoch V2 commit accepted
V1 compatibility path healthy
all committed V2 FinanceResults still queryable
```

## 8. Delivery-specific rollback

Use this when Telegram/outbox delivery is defective while ledger semantics are healthy.

1. set `outbox_mode = paused`; increment config epoch;
2. no new sender claims are allowed;
3. rows already `sending` are not blindly retried after lease expiry; they transition to `unknown`;
4. pending rows remain durable;
5. accepted/unknown rows are immutable delivery evidence;
6. fix/validate sender;
7. resume `enabled` or `draining` explicitly.

An explicit replay after this rollback creates a new `delivery_request_id` only after `outbox_mode = enabled`; it references the existing immutable `FinanceResult` and never edits/deletes the previous `unknown` row.

Ledger route need not be rolled back solely because Telegram delivery is paused if the product explicitly accepts delayed confirmations during the maintenance window; otherwise finance mutation intake must also be paused by product policy.

## 9. Receipt V1 -> V2 cutover

This is a drain, not dual semantic consumption.

1. deploy V2-capable binary that can obey receipt runtime mode while still running V1 receipt behavior;
2. set `receipt_route_mode = draining_v1`; new photo intake returns a temporary maintenance response and does not enqueue new V1 jobs;
3. observe old Queue backlog = 0;
4. observe old receipt processing locks/active attempts = 0;
5. maintain zero for two observation intervals longer than the configured retry horizon;
6. verify no dead-letter/unacked old job remains;
7. deploy/activate the V2 receipt consumer;
8. set `receipt_route_mode = v2`; increment config epoch;
9. re-enable photo intake;
10. architecture guard proves old processor is unreachable from primary V2.

## 10. Receipt V2 -> V1 rollback

1. set `receipt_route_mode = draining_v2`; stop new V2 receipt intake;
2. wait for V2 jobs/provider attempts to settle or lease-expire;
3. stale provider completions cannot publish artifacts because artifact persistence is fenced by job lease epoch/route epoch plus the current runtime `config_epoch` and `receipt_route_mode`;
4. require zero active V2 receipt job leases;
5. settle committed-result outbox rows according to delivery policy;
6. switch consumer deployment back to V1 compatibility consumer inside the V2-capable binary;
7. set `receipt_route_mode = v1`;
8. re-enable photo intake.

A pre-V2 binary is not required for this rollback.

## 11. Re-enable V2 after rollback

Before returning from `primary_v1` to V2:

1. root cause is fixed and covered by regression test;
2. no active stale V2 leases exist;
3. unknown outbox rows have not been auto-retried;
4. compatibility-interrupted sessions are not presented to the orchestrator as continuous V2 history;
5. current ledger is treated as fact; V1 turns during rollback are not fabricated as V2 operation history;
6. new config epoch is issued;
7. canary is repeated before primary V2.

## 12. Required observation queries / evidence

The implementation must provide read-only operational queries/scripts for at least:

```text
runtime control row + config epoch
Cloudflare account plan evidence = Workers Paid
count active reserved/executing operation leases
count expired reclaimable operation leases
count pending/failed_retryable/sending/unknown outbox by age
delivery request history for one result, including explicit replay attempts
count receipt jobs by status + active lease
count provider attempts by status
old Queue backlog / retry / dead-letter evidence
compatibility_interrupted session count
```

Exact commands depend on final Wrangler/Queue identifiers, but they must be written into the production rollout checklist before remote execution.

## 13. Migration/rollback acceptance gate

Overall migration/rollback is PASS only when all are demonstrated without production mutation:

- fresh 0001-0009 database;
- 0001-0007 -> 0008 -> 0009 upgrade;
- production-sized isolated copy;
- 0005 original identity survives delete;
- receipt child cascade + V2 exact child audit snapshot;
- old schema data readable by V2-capable Worker;
- Workers Paid plan prerequisite verified for the deployed account;
- `primary_v1` mode preserves V1 behavior;
- current runtime config epoch and route mode prevent stale deployment mutation, receipt artifact, and outbox terminal commits;
- operation lease epoch prevents stale owner commit;
- canonical result-set validator rejects forged UTF-8 byte/cardinality declarations;
- explicit replay creates a new delivery request without editing historical `accepted`/`unknown` rows, and replay idempotency prevents duplicates;
- outbox persistence rejects raw provider response bodies;
- pending/unknown outbox survives semantic rollback;
- V1->V2 and V2->V1 receipt drain;
- rollback followed by re-canary/re-enable V2;
- no product-code `main` merge until all architecture/implementation gates are separately satisfied.
