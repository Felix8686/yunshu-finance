# Finance Orchestrator V2 — Revision 4 Normative Closure

Status: architecture-only. No product-code implementation is authorized by this document.

This document is normative and supersedes conflicting wording in Revision 2 and Revision 3. The permanent rule remains unchanged:

- LLM is the only authority for understanding user natural language.
- Code is the only authority for facts, authorization, execution, persistence, safety, exact calculation, idempotency, ordering, audit, and delivery state.
- No second semantic parser/fallback is allowed.
- All finance writes, including receipt-created writes, use one executor.

Revision 4 addresses the Revision 3 re-audit closure blockers NB-01 through NB-10 while keeping the product intentionally small: one owner, one personal ledger, Cloudflare Workers + D1 + Queues, and bounded conversation/result state.

## R4.1 Normative document order

For implementation and re-audit, precedence is:

1. `FINANCE_ORCHESTRATOR_V2_REV4_ADDENDUM.md`
2. `FINANCE_ORCHESTRATOR_V2_PROTOCOL_SCHEMA.json`
3. `FINANCE_ORCHESTRATOR_V2_MIGRATION_RUNBOOK_REV4.md`
4. Revision 3 Addendum
5. Revision 2 Blueprint

Conflicting older text is non-normative.

The protocol schema must have root validation entrypoints and must reject `{}` and unknown envelope shapes. No module may invent a local alternative shape for FinanceTurn, OrchestratorOutput, FinancePlan, PlanPatch, FinanceResult, ResultSet snapshot/window, ReceiptJob/Artifact/Envelope, Operation, Outbox, TurnContextSnapshot, or RuntimeControl.

## R4.2 Single-owner authorization contract

Canonical ledger scope remains:

`personal:primary`

There is no multi-tenant system in V2.

### Telegram ingress

A Telegram finance event is authorized only when all are true:

- webhook secret is valid;
- `message.from.id == OWNER_TELEGRAM_USER_ID`;
- `message.chat.id == OWNER_TELEGRAM_CHAT_ID`;
- chat type is the configured owner chat type; default deployment is private chat;
- if thread/topic routing is enabled later, the thread/topic must be in an explicit configured allowlist.

Authorized Telegram subject is exactly `telegram:owner`.

### API ingress

A valid owner bearer credential maps to subject `api:owner`. An API caller cannot supply or override `ledger_scope_id`, actor subject, or outbox destination.

### Executor re-check

Authorization is checked twice:

1. adapter before FinanceTurn creation;
2. executor/operation boundary before any D1 fact read or write that is scoped to the ledger.

Every session, turn, plan, result, ResultSet, reference, operation, audit, outbox, and receipt lookup includes `ledger_scope_id = 'personal:primary'`.

Outbox destination is code-issued from configured owner settings. The LLM/plan cannot choose a Telegram chat ID.

## R4.3 Channel ordering without long-idle corruption

Raw Telegram `update_id` is not a lifetime-global session ordering key because Telegram may choose a random next identifier after at least one week without updates.

V2 uses a Telegram stream ordering cursor:

```text
(epoch, update_id)
```

D1 keeps one `finance_channel_cursors` row for the owner Telegram bot:

```text
channel = telegram
cursor_epoch
last_update_id
last_received_at
```

Rules:

1. same `channel_event_id` + same payload hash -> duplicate/replay;
2. same event ID + different hash -> protocol conflict;
3. within one epoch, `update_id > last_update_id` advances the cursor;
4. `update_id <= last_update_id` is stale/conflict unless the bot-wide stream has been idle for at least the configured reset interval (`TELEGRAM_ORDER_EPOCH_RESET_AFTER_HOURS = 168`), in which case code increments `cursor_epoch` and accepts the new update as the first event of a new epoch;
5. comparison is lexicographic `(epoch, update_id)` and never compares raw update IDs across epochs;
6. the cursor update itself uses D1 CAS/conditional update;
7. if cursor/session CAS loses, the already interpreted event is not reinterpreted against newer context. It becomes typed ordering conflict/clarification.

API conversation requests do not use Telegram ordering. They require explicit `base_session_version`; conflict is fail-closed and no automatic LLM re-interpretation occurs.

Receipt completion is causally attached to its source photo turn. It does not participate in conversational ordering and never overwrites the current active plan. It only appends durable receipt/result references.

## R4.4 Fenced operation lease

`lease_owner + lease_expires_at` alone is insufficient. Every operation claim has a monotonically increasing integer `lease_epoch` fencing token.

`finance_operations` contains at least:

```text
operation_id
ledger_scope_id
idempotency_key
payload_hash
turn_id
session_key
operation_type
status
lease_owner
lease_epoch
lease_expires_at
attempt_count
route_epoch
result_id
error_code
created_at
updated_at
committed_at
```

Unique key:

`(ledger_scope_id, idempotency_key)`

Claim/reclaim atomically increments `lease_epoch`.

### Final mutation fencing rule

Every ledger/result/audit/session/reference/ResultSet/outbox statement belonging to a mutation must be guarded by the same active operation identity and fencing epoch.

For insert-style statements, use the logical form:

```sql
INSERT INTO target (...)
SELECT ...
WHERE EXISTS (
  SELECT 1 FROM finance_operations
  WHERE operation_id = ?
    AND ledger_scope_id = 'personal:primary'
    AND status = 'executing'
    AND lease_epoch = ?
    AND route_epoch = ?
);
```

For update/delete statements, include the equivalent `EXISTS` predicate.

The terminal operation update is the final statement in the D1 batch and must match the same operation ID + lease epoch + route epoch + `status='executing'`.

The Worker treats a mutation as committed only when the terminal operation update reports exactly one changed row. If the fence is stale, every guarded statement is a no-op and the caller returns/reloads the newer operation state. A stale owner may never convert a no-op batch into success.

This fencing rule is also an architecture-guard target: direct ledger writes without the operation-fence helper are forbidden in primary V2.

## R4.5 Runtime route fencing

Runtime control is a typed state record, not a group of independent booleans.

Single control row:

```text
control_id = primary
config_epoch
finance_route_mode = primary_v1 | shadow_v2 | canary_v2 | draining_v2 | primary_v2
receipt_route_mode = v1 | draining_v1 | v2 | draining_v2
outbox_mode = paused | enabled | draining
shadow_mode = off | interpretation_only
analysis_prose_enabled = 0 | 1
updated_at
```

Every transition increments `config_epoch`.

A V2 mutation reservation stores the current `config_epoch` as `route_epoch`. The final mutation batch is fenced by that route epoch as described in R4.4. Therefore a Worker instance that cached an obsolete rollout state cannot commit a V2 mutation after rollback/cutover changes the epoch.

A pre-V2 binary that does not understand this control row is never a normal rollback target once V2 write canary begins. Rollback uses a V2-capable binary with V1 compatibility paths behind the runtime state machine.

## R4.6 ResultSet is a bounded immutable snapshot with explicit windows

V2 keeps bounded materialization and does not add a global ledger revision.

Hard limits:

- `MAX_RESULT_SET_ROWS = 200`
- `DEFAULT_TELEGRAM_PAGE_SIZE = 10`
- `MAX_RENDER_PAGE_SIZE = 20`
- `MAX_RESULTSET_ROW_SNAPSHOT_BYTES = 8 KiB`
- `MAX_RESULTSET_SNAPSHOT_BYTES = 256 KiB`
- `RESULTSET_TTL_HOURS = 24`

A ResultSet has one immutable ordered full bounded set plus mutable session window pointers.

`finance_result_sets` owns:

```text
result_set_id
ledger_scope_id
plan_id
plan_version
session_key
result_set_version
row_count
page_size
sort_filter_fingerprint
snapshot_bytes
created_at
expires_at
```

`finance_result_set_items` owns:

```text
result_set_id
ordinal            -- 1-based
entity_type
entity_id
entity_fingerprint
row_snapshot_json
row_snapshot_bytes
```

`FinanceResult -> result_set_id` is the single ownership direction. ResultSet does not point back to FinanceResult.

The session projection owns:

```text
active_result_set_id
active_window_start_ordinal
active_window_end_ordinal
previous_window_start_ordinal
previous_window_end_ordinal
```

Reference semantics are fixed:

- `第二笔` -> 1-based ordinal 2;
- `这些` -> current active window, never the entire bounded set unless the user explicitly says all/全部;
- `上一页这些` -> previous stored window;
- `下一页` -> deterministic next window using the signed page token;
- missing live entity after snapshot -> `stale_reference`;
- changed live entity fingerprint -> `stale_reference`;
- expired set/token -> `expired_reference`;
- none of these silently re-query live ledger to reconstruct historical membership.

### Canonical entity fingerprint

For a normal transaction, fingerprint covers the canonical mutation-relevant parent fields.

For a transaction with receipt children, the parent fingerprint additionally includes a SHA-256 of the ordered canonical child-item set (item ID, name, quantity, unit price, line total, category). Therefore a legacy/V1 child-only mutation invalidates the parent reference as stale.

For a transaction-item reference, fingerprint includes item fields plus parent transaction ID and parent amount.

## R4.7 FinanceResult owns render history; Outbox owns delivery only

`finance_results` is the immutable replay authority.

It stores:

```text
result_id
ledger_scope_id
turn_id
operation_id nullable
schema_version
operation_type
result_json
render_payload_json
render_hash
result_set_id nullable
created_at
expires_at nullable
```

`FinanceResult` does not contain mutable Telegram delivery state or a mutable replay-status field. Delivery state belongs only to outbox rows.

`render_payload_json` is generated deterministically before a mutation commit. It contains zero or more Telegram parts, each already within Telegram's 4096-character text limit. Each part has a deterministic `part_index` and `part_hash`.

After commit:

- renderer is never called again for historical replay;
- live ledger is never queried to reconstruct the committed reply;
- API replay returns the stored FinanceResult;
- Telegram sender reads the stored render part and verifies its hash.

To avoid dual payload ownership, outbox does not store a second full message body.

## R4.8 Outbox fenced delivery and unknown state

`finance_outbox` stores only delivery metadata:

```text
outbox_id
ledger_scope_id
result_id
part_index
render_hash
destination_type
destination_id
thread_id
status
lease_owner
lease_epoch
lease_expires_at
attempt_count
last_attempt_started_at
telegram_message_id
provider_response_json
last_error_code
next_attempt_at
created_at
accepted_at
```

Outbox part identity is deterministic from `(result_id, part_index)`.

Sender claim/reclaim increments `lease_epoch`.

Terminal sender updates (`accepted`, `failed_retryable`, `failed_terminal`, `unknown`) require matching `outbox_id + lease_owner + lease_epoch + status='sending'`.

Rules:

1. `pending/failed_retryable` may be claimed when due;
2. confirmed Telegram success -> `accepted` + message ID;
3. confirmed provider error may become retryable/terminal only from an explicit error allowlist;
4. network timeout, ambiguous transport failure, Worker crash after request start, or an expired `sending` lease -> `unknown`;
5. `unknown` is never automatically changed back to pending and is never automatically resent;
6. a user can explicitly request a replay later, which creates a new notification attempt referencing the same stored FinanceResult;
7. Queue and Cron may race, but only one sender lease epoch can write a terminal state;
8. the sender verifies `render_hash == stored FinanceResult part hash` before calling Telegram;
9. Telegram destination must equal the configured owner destination.

D1 outbox is source of truth. `FINANCE_OUTBOX_QUEUE` is an accelerator. A 1-minute Cron fallback scans due rows. `waitUntil()` is not the delivery reliability mechanism.

## R4.9 Receipt envelope is typed and fenced

Receipt processing remains a specialized extraction pipeline, not a second finance-intent system.

Machine-readable contracts must include:

- `ReceiptJob`
- `ReceiptProviderAttempt`
- `ReceiptArtifact`
- `ReceiptEnvelope`

`ReceiptEnvelope` ties together:

```text
job
artifact
source FinanceTurn
source TurnContextSnapshot
caption
```

Receipt job claims also use `lease_epoch` fencing. Provider calls can still be duplicated after an externally ambiguous crash, but artifact persistence is accepted only from the current job lease epoch. A late provider response from an older epoch cannot publish/replace the canonical artifact.

Provider category text is not a ledger category. Receipt item mapping is versioned (`receipt-item-v1`) into the fixed receipt item taxonomy. An unrecognized provider category that cannot be deterministically mapped is fail-closed; it is not silently converted to a different ledger/category meaning.

With caption, only the human caption goes through the single Dialogue Orchestrator; the artifact is structured data in the same envelope.

Without caption, code may build a machine-origin CreatePlan from the validated artifact. This is structured adaptation, not natural-language interpretation. It still uses the same plan validator, safety, executor, operation fence, FinanceResult, session reference, and outbox.

Receipt completion appends a row to `finance_session_references` and never overwrites `active_plan_json`. If a guarded session metadata update is needed, it uses session version CAS; a conflict leaves the append-only reference intact and does not rewrite the current plan.

Receipt parent delete/restore audit snapshot includes the exact ordered child set. Parent/item reconciliation is checked before commit.

## R4.10 Atomic capacity budget

Revision 4 corrects an important terminology issue from the re-audit: Cloudflare's approximately 5,000 "bindings per Workers script" refers to resource bindings, not SQL bound parameters. It is not an SQL batch-parameter budget.

Relevant D1 bounds remain per-query maximum 100 bound parameters, per-statement maximum 100 KB SQL text, and maximum 30 seconds for the whole batch call.

V2 therefore uses explicit product-level bounds:

- `MAX_CREATE_ENTRIES = 20`
- `MAX_RECEIPT_ITEMS = 64`
- `MAX_TOTAL_CREATE_ITEMS = 100`
- `MAX_MUTATION_TARGETS = 50`
- `MAX_D1_BATCH_STATEMENTS = 256`
- `MAX_RESULT_SET_ROWS = 200`
- `MAX_RESULTSET_ROW_SNAPSHOT_BYTES = 8 KiB`
- `MAX_RESULTSET_SNAPSHOT_BYTES = 256 KiB`
- `MAX_FINANCE_RESULT_JSON_BYTES = 128 KiB`
- `MAX_TELEGRAM_RENDER_PARTS = 16`
- `MAX_OPERATION_ATTEMPTS = 3`
- `MAX_OUTBOX_ATTEMPTS = 5` for confirmed retryable delivery errors only

Before executor commit, code computes entry count, total receipt/item count, estimated statement count, canonical snapshot bytes, render bytes/parts, and per-statement parameter count. If any bound would be exceeded, return typed `operation_too_large` / `result_too_large` before any mutation.

An operation is never split into multiple non-atomic D1 batches while claiming to be one atomic mutation.

## R4.11 Shadow comparison is structural only

Online shadow is not allowed to claim data-level equivalence between V1 and V2.

At ingress, before V1 execution, code captures the immutable bounded V2 context snapshot. V2 shadow performs exactly one orchestrator interpretation + schema validation against that snapshot.

V1 instrumentation records the semantic route artifact actually selected by V1 before its ledger read/write result is rendered: operation class, interpreted time-scope class where available, and whether V1 requested clarification/passthrough. It does not add another V1 model call.

`SHADOW_DB` stores only redacted structural comparison fields. No amounts, merchants, OCR text, account names, raw user text, result rows, or candidate IDs are stored.

Shadow can be used as evidence for:

- operation-class agreement;
- schema validity;
- route/fallback elimination;
- latency/model-call budget.

It cannot be used as evidence that V1 and V2 selected the same live rows, calculated the same totals, or would commit the same mutation. Those require isolated replay/E2E tests.

## R4.12 Protocol schema closure requirements

`FINANCE_ORCHESTRATOR_V2_PROTOCOL_SCHEMA.json` Revision 4 must:

- expose non-empty root `oneOf` entrypoints;
- reject `{}`;
- require FinanceTurn idempotency key;
- use typed OrderingCursor rather than one global integer ordering key;
- require deterministic `client_entry_key` and `client_item_key`;
- express exact-count/reference selection with discriminated `oneOf`;
- separate UpdatePlan and DeletePlan so update requires changes and delete cannot carry changes;
- express PlanPatch with explicit `replace`/`clear`, where omission means inherit;
- include OrchestratorOutput;
- include immutable FinanceResult without delivery/replay state;
- include bounded typed ResultSet/window/page-token structures;
- include ReceiptJob/ProviderAttempt/Artifact/Envelope;
- include FinanceOperationRecord with lease epoch/route epoch;
- include FinanceOutboxRecord with sender lease epoch and no duplicated message body;
- include TurnContextSnapshot and RuntimeControl;
- use `additionalProperties:false` for protocol envelopes;
- version persisted/wire contracts.

The schema is an implementation contract, not documentation-only pseudocode.

## R4.13 Migration and rollback are defined in a separate normative runbook

`FINANCE_ORCHESTRATOR_V2_MIGRATION_RUNBOOK_REV4.md` is normative for:

- exact 0008/0009 table/index/FK family;
- immutable original recovery transaction identity;
- V2-capable binary first deployment;
- runtime config epoch/state transitions;
- receipt producer stop/drain/consumer switch;
- active operation fencing/settlement;
- committed pending outbox behavior during semantic rollback;
- delivery-specific rollback;
- rollback success signals;
- re-enable V2 signals.

No production write cutover is authorized until that runbook passes fresh DB, 0001-0007 upgrade DB, production-sized isolated copy, lease/crash, Queue drain, and rollback/re-enable tests.

## R4.14 Architecture guards

Revision 3 guard strategy remains valid and is extended:

- primary V2 ledger mutations must call the fenced operation executor helper;
- raw transaction/item mutation outside the executor allowlist fails CI;
- primary V2 cannot import legacy semantic functions;
- receipt extraction cannot import ledger write primitives;
- outbox sender cannot import renderer or ledger query helpers;
- result replay cannot import live ledger query helpers;
- runtime tests assert one natural-language semantic authority, zero second-parser calls, committed duplicate zero mutation SQL, stale lease owner zero ledger changes, expired sending -> unknown, and receipt late completion does not replace active plan.

The implementation remains lightweight: TypeScript compiler API + normal tests; no separate static-analysis service.

## R4.15 Closure mapping

- NB-01 stale operation owner: R4.4 + R4.5
- NB-02 incomplete protocol schema: R4.12 + protocol JSON
- NB-03 Telegram long-idle ordering: R4.3
- NB-04 ResultSet windows/fingerprints/bytes: R4.6
- NB-05 atomic capacity: R4.10
- NB-06 outbox expiry/payload ownership: R4.7 + R4.8
- NB-07 migration/recovery identity/rollback: R4.5 + R4.13 + migration runbook
- NB-08 receipt typed envelope: R4.9
- NB-09 shadow comparison pollution: R4.11
- NB-10 owner binding: R4.2

Revision 4 still requires independent architecture re-audit. No Phase 1 product implementation is authorized until that re-audit returns `BLUEPRINT_READY`.