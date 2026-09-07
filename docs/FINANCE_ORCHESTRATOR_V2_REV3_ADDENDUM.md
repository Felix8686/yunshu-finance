# Finance Orchestrator V2 — Revision 3 Normative Closure

Status: architecture-only. No product-code implementation is authorized by this document.

This document is normative and supersedes any conflicting Revision 2 wording in `FINANCE_ORCHESTRATOR_V2_BLUEPRINT.md`.

It closes the independent re-audit blockers B1-B11 before implementation. The permanent rule is unchanged:

- LLM is the only natural-language understanding authority.
- Code is the only fact/execution/safety/persistence/audit authority.
- No second semantic parser/fallback is allowed.
- All finance writes, including receipt-created writes, use one executor.

Revision 3 intentionally narrows unnecessary generality for the current product:

- single-owner personal ledger;
- one ledger scope: `personal:primary`;
- currency: `CNY`;
- timezone: `Asia/Shanghai`;
- no claim of bank-grade or user-visible exactly-once Telegram delivery.

## R3.1 Canonical protocol bundle

The machine-readable contract is `docs/FINANCE_ORCHESTRATOR_V2_PROTOCOL_SCHEMA.json`.

Implementation must validate all orchestrator outputs and persisted result/receipt payloads against that bundle. Unknown fields are rejected where `additionalProperties:false`. No module may invent a local alternative shape for FinanceTurn, FinancePlan, PlanPatch, ReferenceSpec, FinanceResult, receipt item/reconciliation, clarification, or errors.

Protocol changes that alter persisted or wire semantics require schema-version increments.

## R3.2 Trusted actor and ledger scope

Current V2 is single-owner.

Canonical scope:

`personal:primary`

All sessions, turns, plans, operations, results, ResultSets, references, outbox rows, and receipt artifacts carry this scope. Every lookup requires scope equality.

Telegram transport authenticity and user authorization are separate checks. V2 requires configured owner identity (`OWNER_TELEGRAM_USER_ID`, `OWNER_TELEGRAM_CHAT_ID`). Accepted Telegram finance traffic maps to subject `telegram:<OWNER_TELEGRAM_USER_ID>`.

Natural-language/mutation API calls map the authenticated owner credential to `api:owner`. API and Telegram may share the ledger but do not silently share conversational sessions.

Idempotency uniqueness is `(ledger_scope_id, idempotency_key)`, not a global key.

## R3.3 FinanceTurn ordering and concurrency

Revision 3 removes the rule that a CAS loser may be reinterpreted against newer context.

Telegram canonical ordering key is integer `update_id`. Same event ID + same payload hash is duplicate/replay; same event ID + different hash is conflict. A non-duplicate turn with `ordering_key <= session.last_committed_ordering_key` is stale.

API conversational calls must provide `base_session_version`; conflict returns typed `ordering_conflict`. There is no automatic second LLM interpretation for the same event after a session conflict.

Before interpretation, code builds an immutable bounded `TurnContextSnapshot` containing turn identity, actor/scope, base session version, active plan, active/previous ResultSet references, bounded recent finance-turn summaries, relevant catalog snapshot, event time and timezone. Its canonical hash is stored with the turn.

If a concurrent turn commits first, the losing turn becomes clarification/ordering-conflict. It is never silently rebased and reinterpreted.

Receipt completion is asynchronous. If the session advanced after photo intake, receipt completion may append receipt references/result metadata but must not overwrite the newer active conversational plan.

`finance_turns` must durably store at least: turn_id, scope, channel, channel_event_id, session_key, ordering_key, payload_hash, event_time, received_time, base_session_version, context_snapshot_hash/json, interpretation_json/status, plan_id, result_id, created_at, completed_at.

## R3.4 Bounded immutable ResultSet

Revision 3 chooses bounded materialization, not unlimited snapshots.

Initial limits:

- `MAX_RESULT_SET_ROWS = 200`
- `DEFAULT_TELEGRAM_PAGE_SIZE = 10`
- `MAX_RENDER_PAGE_SIZE = 20`

If a detail operation needing ordinal/result continuity exceeds 200 rows, return typed `result_too_large` and ask the user to narrow scope. Aggregate queries may summarize more rows because they do not require row-by-row materialization.

Physical logical tables:

`finance_result_sets`: result_set_id, ledger_scope_id, source_result_id, plan_id/version, session_key, result_set_version, fingerprint, row_count, page_size, sort/filter spec JSON, created_at, expires_at.

`finance_result_set_items`: result_set_id, ordinal, entity_type, entity_id, entity_fingerprint, row_snapshot_json; primary key `(result_set_id, ordinal)`.

`row_snapshot_json` is the authoritative historical row for presentation/reference replay. `entity_fingerprint` is SHA-256 over canonical mutation-relevant fields.

Revision 3 does not require a global ledger revision or new transaction version column. Before mutation from a ResultSet, code re-reads the current entity, recomputes its fingerprint, and rejects with `stale_reference` if it differs from the snapshot.

Page tokens are opaque/signed handles containing result_set_id, next ordinal, and result_set_version. Pagination never reuses live SQL offset against changed ledger rows.

Default ResultSet TTL is 24 hours. Expired ordinal references return `expired_reference`; the same historical reference is never silently reconstructed from live ledger.

## R3.5 Durable FinanceResult

A durable authoritative result record is mandatory.

Logical table `finance_results` contains: result_id, ledger_scope_id, turn_id, operation_id nullable, schema_version, operation_type, result_json, render_payload_json, result_set_id nullable, payload_hash, created_at, expires_at nullable.

Rules:

1. `result_json` validates as FinanceResult.
2. `render_payload_json` is the deterministic replay/render artifact.
3. Mutation FinanceResult is constructed from real resolved IDs and deterministic before/after state before commit.
4. Pure deterministic rendering runs before a mutation commit. Render failure means no mutation commit.
5. One D1 atomic batch stores ledger changes + operation terminal state + audit + FinanceResult + session/reference changes + ResultSet rows if needed + outbox row.
6. After commit, renderer never re-queries live ledger to reconstruct the committed result.
7. Duplicate committed operations return the stored FinanceResult.

Hard bound: `MAX_FINANCE_RESULT_JSON_BYTES = 128 KiB`. Large row snapshots live in ResultSet rows rather than one result JSON.

## R3.6 Operation/idempotency lease state machine

`finance_operations` must contain: operation_id, ledger_scope_id, idempotency_key, payload_hash, turn_id, session_key, operation_type, status, plan_id/version, lease_owner, lease_expires_at, attempt_count, result_id, error_code, created_at, updated_at, committed_at; unique `(ledger_scope_id,idempotency_key)`.

Persisted statuses are exactly:

- reserved
- executing
- committed
- rejected
- failed_terminal

Reservation rules:

- first delivery inserts reserved;
- same scope/key + same payload hash: terminal state replays result; active lease returns in_progress; expired lease may CAS reclaim;
- same scope/key + different payload hash returns idempotency_conflict.

Claim is CAS from reserved/expired executing to executing and sets lease_owner/lease_expires_at/attempt_count. Initial lease is 60 seconds. Only the current owner may extend it.

If Worker crashes before the D1 mutation batch, no ledger mutation exists and the operation can be reclaimed after lease expiry. If the D1 batch commits, operation becomes committed in the same batch as ledger/result/outbox, so a duplicate never runs mutation SQL again.

Policy rejection becomes rejected. Unrecoverable precommit internal failure after retry budget becomes failed_terminal. Both store a replayable FinanceResult/Error.

## R3.7 Atomic commit, render, and Telegram outbox

Revision 3 does not promise visible exactly-once Telegram delivery.

It promises exactly-once ledger mutation per scoped idempotency key and explicit delivery uncertainty.

Mutation flow:

interpret -> resolve -> safety -> deterministic before/after -> FinanceResult -> deterministic render artifact -> one D1 atomic batch -> external outbox send.

`finance_outbox` contains: outbox_id, ledger_scope_id, result_id, destination_type/id, thread_id, payload_hash/json, status, lease_owner/expires_at, attempt_count, last_attempt_started_at, telegram_message_id, provider_response_json, last_error_code, next_attempt_at, created_at, sent_at.

Statuses are:

- pending
- sending
- accepted
- failed_retryable
- failed_terminal
- unknown

Sender claims pending/failed_retryable by CAS with a 60-second lease.

If Telegram returns confirmed success, status becomes accepted and returned message_id is stored. Confirmed retryable/terminal errors become corresponding states. If network/Worker failure makes it impossible to know whether Telegram accepted the message, status becomes unknown.

`unknown` is not automatically resent because Telegram sendMessage has no application idempotency key and automatic retry could duplicate a message already visible to the user. Ledger correctness is preferred over duplicate-free notification perfection. A later user request can replay the stored FinanceResult.

Outbox reliability must not depend on HTTP `waitUntil()`. Preferred accelerator is a `FINANCE_OUTBOX_QUEUE`, but D1 outbox remains source of truth. A 1-minute Cron fallback scans due pending/failed_retryable rows. Queue signal and Cron races are resolved by D1 sender lease/CAS.

## R3.8 Receipt artifact and machine-origin envelope

Receipt is not a second intent engine.

Required logical stores:

- `finance_receipt_jobs`: job/scope/turn/source_event/attachment/caption/status/lease/attempt timestamps;
- `finance_receipt_artifacts`: receipt_artifact_id/scope/job/turn/source_event/attachment/schema_version/artifact_json/hash/created_at;
- `finance_receipt_provider_attempts`: provider_attempt_id/job/provider/status/timestamps/error.

Receipt consumer claims the job with the same lease/CAS pattern before external provider calls. Provider calls may be duplicated after an external-network unknown crash; that may duplicate cost but cannot duplicate ledger mutation because the finance operation is idempotent.

Validated extraction is persisted as ReceiptArtifact. OCR/provider text is untrusted data.

With caption, FinanceTurn.text is the human caption and structured context contains receipt_artifact_id. The single Dialogue Orchestrator interprets only the human caption while receipt fields are data.

Without caption, code may construct a machine-origin CreatePlan from the validated artifact. This is not a second natural-language authority because no human language is being inferred; it still passes the exact same schema validator, safety, executor, operation, result, session-reference and outbox path.

Item mutation invariants:

- editing item category/name does not change parent amount;
- editing quantity/line amount requires item-total reconciliation;
- if item totals no longer reconcile to parent total, reject unless the same plan explicitly changes the parent amount consistently;
- delete/restore of a receipt parent snapshots/restores the exact ordered child-item set.

Receipt cutover uses drain, not dual semantic processing: disable new receipt intake; wait for old queue backlog/active attempts to reach zero for two observation intervals longer than retry horizon; enable V2 producer/consumer; then re-enable intake. Old receipt processor is not callable from primary_v2.

## R3.9 Concrete migration/cutover/rollback family

0008 creates V2 control/state tables only, without altering existing transactions/items: finance_runtime_flags, finance_turns, finance_sessions, finance_plans, finance_results, finance_result_sets/items, finance_operations, finance_audit_snapshots, finance_outbox, finance_receipt_jobs/artifacts/provider_attempts.

0009 handles the 0005 recovery-log FK before V2 destructive delete is enabled. It must rebuild the recovery-log table so historical transaction identity remains immutable evidence while the live FK may become nullable/ON DELETE SET NULL. Exact SQLite/D1 table-copy SQL must pass fresh DB, 0001-0007 upgrade DB, and production-sized isolated-copy tests before remote use. Until 0009 passes, V2 destructive delete for a row referenced by 0005 is disabled.

Existing 0007 ledger_operations remains immutable legacy evidence. V2 uses new finance_operations + finance_audit_snapshots and does not pretend old rows were V2 lifecycle records.

0006 inactive historical categories remain displayable but cannot be silently selected as active mutation/create targets.

Runtime flags live in `finance_runtime_flags` and are read by the V2-capable Worker:

- finance_route_mode = primary_v1 | shadow_v2 | canary_v2 | primary_v2
- natural_language_v1_compat_enabled
- receipt_intake_enabled
- receipt_v2_enabled
- outbox_delivery_enabled
- analysis_prose_enabled
- shadow_enabled

Normal rollback is a flag change inside the V2-capable binary, not blind redeployment of a pre-V2 Worker.

Because this is a single-owner conversational product, canary is capability-scoped rather than random per-turn traffic splitting. Once one conversational capability moves to V2, it does not automatically fall back to V1.

Before rolling a write capability back: stop accepting new V2 mutations for that capability; wait one lease horizon; reclaim/settle expired reserved/executing operations; require zero active operation leases; then switch the route flag. Valid V2 ledger mutations remain. V2 audit/result/outbox remain immutable. Defective mutation correction is a new compensating operation, never silent history editing.

If V1 compatibility handles later turns during rollback, V2 conversational session is marked compatibility_interrupted. Returning to V2 starts from current ledger + durable V2 history rather than fabricating continuity through V1 turns.

## R3.10 Shadow proof

Online shadow is interpretation-only.

At Telegram ingress, before V1 interpretation/execution, code captures an immutable bounded pre-state snapshot. V1 then executes unchanged. V2 shadow receives only that pre-state and must not re-read mutable production state for the same sample after V1 execution.

Shadow permits one orchestrator interpretation + schema validation only. No mutation resolver, provider, ResultSet, session, operation, outbox, production Queue/R2/D1 write, or Telegram response.

Use a separate D1 binding/database `SHADOW_DB` for redacted telemetry only. Store sample/hash IDs, V1 outcome class, V2 operation class, structural divergence codes, latency/call count, timestamp. Never store raw finance text, amounts, OCR payload, merchant or account names.

`waitUntil()` is allowed for shadow because lost telemetry is acceptable; it is not allowed as the reliability primitive for finance delivery.

Online shadow proves interpretation compatibility only, not mutation/delivery/receipt correctness.

## R3.11 Executable architecture guards

Implementation must add `npm run check:architecture`, backed by a TypeScript compiler-API script and run in CI/local `npm run check`.

Only V2 executor/store package areas may import ledger-write primitives. Adapters, orchestrator, renderer, receipt extraction/provider, compatibility parser, and analysis prose may not directly mutate transactions/items.

Static guard must detect SQL mutation verbs targeting transactions/transaction_items outside the allowlist.

Primary V2 route may not import/call `classifyFinanceCommand`, `handleFinanceConversationTelegram`, `parseFinanceTextQuery`, or `parseIntake`. Compatibility code may use legacy functions, but primary V2 may not import the compatibility package.

Runtime route tests instrument orchestrator call count, legacy parser call count, executor mutation count, and outbox creation count. Required assertions include: one natural-language turn -> one interpretation authority; invalid orchestrator -> zero second-parser calls; committed duplicate -> zero mutation SQL; receipt adapter -> zero direct ledger writes.

## R3.12 Capacity/time bounds

Initial bounds:

- MAX_CREATE_ENTRIES = 50
- MAX_RECEIPT_ITEMS = 64
- MAX_RESULT_SET_ROWS = 200
- MAX_RENDER_PAGE_SIZE = 20
- MAX_FINANCE_RESULT_JSON_BYTES = 128 KiB
- MAX_OPERATION_ATTEMPTS = 3
- MAX_OUTBOX_ATTEMPTS = 5 for confirmed retryable failures
- OPERATION_LEASE_SECONDS = 60
- OUTBOX_LEASE_SECONDS = 60
- RESULTSET_TTL_HOURS = 24

Before implementation beyond schema/store scaffolding, isolation tests must verify these bounds against D1/Queue limits.

An operation exceeding the atomic bound returns typed operation_too_large/clarification. It is never split across multiple non-atomic batches while pretending to be one operation.

## R3.13 Re-audit blocker mapping

- B1 durable FinanceResult: R3.5
- B2 Telegram unknown delivery: R3.7
- B3 operation crash lease/reclaim: R3.6
- B4 ordering/CAS reinterpretation: R3.3
- B5 ResultSet snapshot/capacity: R3.4 + R3.12
- B6 incomplete schema: R3.1 + protocol schema JSON
- B7 receipt envelope: R3.8
- B8 migration/rollback: R3.9
- B9 actor/tenant trust: R3.2
- B10 executable guards: R3.11
- B11 shadow consistent pre-state: R3.10

Revision 3 still requires independent architecture re-audit. No implementation phase is authorized until the re-audit returns BLUEPRINT_READY.