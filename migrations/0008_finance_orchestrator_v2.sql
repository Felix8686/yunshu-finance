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
