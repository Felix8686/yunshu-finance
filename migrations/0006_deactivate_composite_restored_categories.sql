-- Deactivate composite categories from historical restoration that contain commas
-- These categories cause confusion for AI parsing and pollute current transaction categorisation.
-- Historical transactions keep their original category_id (no deletion or update to transactions).

UPDATE categories
SET is_active = 0
WHERE type = 'expense'
  AND is_active = 1
  AND id LIKE 'restored-cat-expense-%'
  AND (name LIKE '%,%' OR name LIKE '%，%');
