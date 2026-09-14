PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS finance_shadow_comparisons (
  sample_id TEXT PRIMARY KEY,
  turn_id_hash TEXT NOT NULL,
  v1_route TEXT NOT NULL,
  v1_operation_class TEXT NOT NULL,
  v1_time_scope_class TEXT NOT NULL,
  v1_clarification INTEGER NOT NULL CHECK (v1_clarification IN (0,1)),
  v1_passthrough INTEGER NOT NULL CHECK (v1_passthrough IN (0,1)),
  v2_operation_class TEXT NOT NULL,
  v2_schema_valid INTEGER NOT NULL CHECK (v2_schema_valid IN (0,1)),
  v2_has_temporal_scope INTEGER NOT NULL CHECK (v2_has_temporal_scope IN (0,1)),
  v2_has_reference INTEGER NOT NULL CHECK (v2_has_reference IN (0,1)),
  v2_presentation_mode TEXT NOT NULL,
  v2_confidence_bucket TEXT NOT NULL,
  divergence_codes_json TEXT NOT NULL,
  model_call_count INTEGER NOT NULL CHECK (model_call_count >= 0 AND model_call_count <= 4),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0 AND latency_ms <= 600000),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_finance_shadow_created
  ON finance_shadow_comparisons(created_at);
