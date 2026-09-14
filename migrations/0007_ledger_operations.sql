PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ledger_operations (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('update', 'delete', 'restore')),
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  command_json TEXT NOT NULL,
  target_ids_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('applied', 'rejected', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ledger_operations_source_created_at
  ON ledger_operations(source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_operations_action_created_at
  ON ledger_operations(action, created_at DESC);
