CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '未指定',
  occurred_at TEXT NOT NULL,
  source_group TEXT NOT NULL,
  source_item_index INTEGER NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (telegram_chat_id, telegram_message_id, source_item_index)
);

CREATE INDEX IF NOT EXISTS idx_transactions_occurred_at
ON transactions(occurred_at);

CREATE INDEX IF NOT EXISTS idx_transactions_category
ON transactions(category);

CREATE INDEX IF NOT EXISTS idx_transactions_source_group
ON transactions(source_group);
