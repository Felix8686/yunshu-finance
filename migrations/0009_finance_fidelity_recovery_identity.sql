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
