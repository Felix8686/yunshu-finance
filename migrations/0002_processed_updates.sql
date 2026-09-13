CREATE TABLE IF NOT EXISTS processed_updates (
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_chat_id, telegram_message_id)
);
