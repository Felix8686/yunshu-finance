-- Finance Orchestrator V2 read-only observation queries.
-- Run against an explicitly selected D1 database; these statements do not mutate state.

-- 1. Runtime control and config epoch.
SELECT control_id, config_epoch, finance_route_mode, receipt_route_mode,
       outbox_mode, shadow_mode, analysis_prose_enabled, updated_at
  FROM finance_runtime_control
 WHERE control_id = 'primary';

-- 2. Active operation leases.
SELECT status, COUNT(*) AS operation_count,
       MIN(lease_expires_at) AS earliest_expiry,
       MAX(lease_expires_at) AS latest_expiry
  FROM finance_operations
 WHERE status IN ('reserved', 'executing')
 GROUP BY status;

-- 3. Expired reclaimable operation leases.
SELECT operation_id, operation_type, status, lease_owner, lease_epoch,
       route_epoch, lease_expires_at, updated_at
  FROM finance_operations
 WHERE status = 'executing'
   AND lease_expires_at IS NOT NULL
   AND julianday(lease_expires_at) < julianday('now')
 ORDER BY lease_expires_at, operation_id;

-- 4. Outbox backlog grouped by status and age.
SELECT status, COUNT(*) AS row_count,
       MIN(created_at) AS oldest_created_at,
       MIN(next_attempt_at) AS next_attempt_at
  FROM finance_outbox
 GROUP BY status
 ORDER BY status;

-- 5. Delivery history for one result. Bind :result_id before execution.
SELECT outbox_id, result_id, delivery_request_id, part_index, status,
       route_epoch, attempt_count, telegram_message_id, last_error_code,
       created_at, accepted_at, next_attempt_at
  FROM finance_outbox
 WHERE result_id = :result_id
 ORDER BY delivery_request_id, part_index, created_at, outbox_id;

-- 6. Receipt jobs by status and active lease.
SELECT status, COUNT(*) AS job_count,
       SUM(CASE WHEN lease_owner IS NOT NULL AND lease_expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS active_lease_count,
       MIN(lease_expires_at) AS earliest_lease_expiry
  FROM finance_receipt_jobs
 GROUP BY status
 ORDER BY status;

-- 7. Provider attempts by status.
SELECT provider, status, COUNT(*) AS attempt_count,
       MIN(started_at) AS earliest_started_at,
       MAX(finished_at) AS latest_finished_at
  FROM finance_receipt_provider_attempts
 GROUP BY provider, status
 ORDER BY provider, status;

-- 8. Sessions interrupted by compatibility routing.
SELECT COUNT(*) AS compatibility_interrupted_sessions
  FROM finance_sessions
 WHERE compatibility_interrupted = 1;

-- Queue backlog/retry/dead-letter evidence is provider-side and must be captured
-- with the selected Wrangler Queue inspection command for the actual queue name.
