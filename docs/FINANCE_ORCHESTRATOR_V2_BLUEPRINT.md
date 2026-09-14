# Finance Orchestrator V2 Blueprint

Status: **architecture-only, revision 2 after architecture audit. No product-code implementation is authorized by this document.**

Baseline at architecture freeze:

- repository: `Felix8686/wanxiang-cloud`
- production `main`: `b707ddb8a5c627ceb0677c1677e9c4b59005fe19`
- architecture branch: `refactor/finance-orchestrator-v2-blueprint`
- audit result that triggered this revision: `NEEDS_REVISION`

This revision replaces the original V2 logical sketch with explicit protocol, state, idempotency, result-set, receipt, outbox, migration, cutover, rollback, observability, and acceptance contracts.

---

## 0. Non-negotiable architecture rule

The system has one permanent division of responsibility:

**LLM = the only authority for understanding user natural language.  
Code = the only authority for facts, database state, authorization, execution, persistence, safety, exact calculation, idempotency, ordering, audit, and delivery state.**

Consequences:

1. User-language intent, ellipsis, pronouns, natural dates, topic continuation, presentation preferences, and clarification are interpreted only by the Finance Dialogue Orchestrator.
2. Regex/keyword logic may only perform:
   - transport/input sanitation;
   - schema/format validation;
   - deterministic normalization of already structured fields;
   - non-semantic protocol checks.
3. Regex/keyword logic must not decide:
   - finance operation;
   - time-range meaning from user prose;
   - target/reference meaning;
   - whether a follow-up inherits a prior query;
   - presentation intent;
   - destructive-action authorization.
4. There is no automatic second NLP parser after the orchestrator.
5. A mutation interpretation failure is fail-closed.
6. No adapter, renderer, receipt provider, legacy helper, or analysis prose generator may directly mutate the ledger.
7. The model may describe what the user means; it may never claim a DB fact or mutation result without code execution.
8. Any future proposal that introduces a second natural-language semantic authority is an architecture regression and requires an explicit blueprint revision before implementation.

The receipt extraction pipeline is a narrow exception only in this sense: OCR/receipt field extraction and bounded item-taxonomy classification may use specialized models/providers, but those components do **not** interpret user finance intent and do **not** decide ledger side effects.

---

## 1. Current route inventory and why V2 is required

The current production system has multiple finance language authorities and multiple write paths.

### 1.1 Telegram text

Current effective route:

```text
Telegram message.text
  -> src/app.ts
      -> Finance Command AI
      -> if null/passthrough: Finance Conversation AI / regex gates
      -> if still unresolved: parseFinanceTextQuery
      -> if still unresolved: src/index.ts legacy webhook
           -> /v1/intake
           -> parseIntake AI
```

Problems:

- one user turn may be interpreted by more than one semantic system;
- command success does not establish the same durable conversation state used by conversation/query paths;
- classification failure can fall through to another model;
- mutation and read paths have different context and audit semantics;
- model-call count is not a stable contract.

### 1.2 Natural-language `/v1/intake`

Current route:

```text
POST /v1/intake
  -> deterministic parseFinanceTextQuery for some reads
  -> otherwise legacy parseIntake AI for create/spending_today/unknown
```

Problems:

- API and Telegram can interpret the same words differently;
- relative time semantics differ;
- API natural-language create bypasses the intended V2 dialogue core;
- retries without durable caller idempotency can become new operations.

### 1.3 Structured finance read APIs

Current structured GET APIs are deterministic and do not require LLM interpretation. They are not a problem by themselves, but they use a separate query/result contract.

V2 rule: structured APIs may bypass the LLM **only because the caller already supplied structured semantics**. They still use the same deterministic query executor and FinanceResult model.

### 1.4 Receipt

Current active receipt path is approximately:

```text
Telegram photo
  -> queue
  -> Veryfi/provider extraction
  -> optional item classification AI
  -> direct transactions + transaction_items writes
  -> Telegram reply
```

A second legacy receipt implementation remains executable in the repository.

Problems:

- receipt creation bypasses the unified finance executor;
- receipt operations do not produce the same operation/audit/session/reference/result artifacts;
- the created receipt and items are not first-class follow-up references;
- queue retry and Telegram send state are not unified with operation idempotency/outbox.

### 1.5 Final disposition of current paths

| Current component | Final V2 disposition |
|---|---|
| `src/app.ts` transport/adapters | ADAPT |
| Command NLP authority | REMOVE AFTER CUTOVER |
| Conversation NLP authority and semantic regex gates | REMOVE AFTER CUTOVER |
| `parseFinanceTextQuery` as natural-language authority | COMPATIBILITY ONLY, then remove from default path |
| `parseIntake` natural-language authority | COMPATIBILITY ONLY, then remove |
| legacy Telegram finance fallback | REMOVE AFTER CUTOVER |
| deterministic SQL/read helpers | ADAPT/REUSE |
| category/account DB lookup | ADAPT/REUSE |
| receipt OCR/resolver/reconciliation | ADAPT/REUSE |
| old receipt processor | VERSIONED COMPATIBILITY ONLY, then remove |
| transaction and item ledger data | REUSE |
| existing `ledger_operations` evidence | MIGRATE/ADAPT |

There must be no hidden or automatic legacy fallback once an event is routed to V2.

---

## 2. Target architecture

```text
Channels
Telegram text / Telegram photo / Structured API / Natural-language API / Queue
                                  |
                                  v
                         Channel Adapters
                    auth + event extraction only
                                  |
                                  v
                         FinanceTurn Intake
                identity + ordering + idempotency reservation
                                  |
                   +--------------+--------------+
                   |                             |
          natural-language turn            structured/machine turn
                   |                             |
                   v                             |
          Dialogue Orchestrator                 |
        (single user-language LLM)              |
                   |                             |
                   +-------------+---------------+
                                 v
                     Versioned FinancePlan
                           or PlanPatch
                                 |
                                 v
                  Deterministic Reference Resolver
                                 |
                                 v
                    Deterministic Safety Policy
                                 |
                                 v
                     Deterministic Executor
                                 |
                                 v
      atomic commit: ledger + operation + audit + session/result + outbox
                                 |
                                 v
                         Typed FinanceResult
                          /               \
                         v                 v
                 Telegram Renderer     API Renderer
                         |                 |
                         v                 v
                     Outbox Send      HTTP response/replay
```

Receipt extraction is upstream of a structured/machine-origin finance turn:

```text
Telegram photo
  -> versioned Receipt Job
  -> provider/OCR/resolver/reconciliation
  -> ReceiptResolvedInput
  -> optional caption through same Dialogue Orchestrator
  -> structured CreatePlan
  -> same Reference/Safety/Executor/Operation/Result/Outbox core
```

---

## 3. Core invariants

These are implementation-blocking invariants.

### 3.1 One semantic authority

For one natural-language finance turn:

- at most one Finance Dialogue Orchestrator interpretation path;
- retries may retry the **same orchestrator contract** after a transient technical failure or CAS reload;
- retries may not call a different parser/schema to reinterpret the user.

### 3.2 One write authority

All finance writes go through the V2 deterministic executor:

- create;
- update;
- delete;
- restore;
- receipt parent creation;
- receipt item creation/update/delete/restore where supported.

### 3.3 One operation identity

Every side-effecting finance turn owns a durable `operation_id` and `idempotency_key`.

Re-delivery must replay the original terminal result instead of executing again.

### 3.4 One fact boundary

All amounts, counts, transaction IDs, item IDs, categories, accounts, result membership, and mutation success come from code + D1, never from model memory.

### 3.5 One result contract

Telegram, API, analysis, and follow-up references consume the same typed `FinanceResult` / immutable ResultSet artifacts.

### 3.6 Delivery is not commit

A committed finance operation and a delivered Telegram message are separate lifecycle states.

`HTTP 200`, Queue ack, D1 commit, Telegram API success, and actual user-visible delivery must not be conflated.

---

## 4. FinanceTurn protocol

Every finance-capable event is normalized before interpretation/execution.

```ts
type FinanceChannel =
  | 'telegram'
  | 'api_natural_language'
  | 'api_structured'
  | 'receipt_queue'
  | 'internal';

interface FinanceActor {
  tenant_id: string;
  subject_id: string;
  channel_user_id?: string;
  permissions: string[];
}

interface FinanceTurn {
  schema_version: 1;
  turn_id: string;

  channel: FinanceChannel;
  channel_event_id: string;
  idempotency_key: string;
  payload_hash: string;

  actor: FinanceActor;

  session_key: string;
  chat_id?: string;
  thread_id?: string;
  topic_id?: string;

  ordering_key: string;
  event_time: string;
  received_time: string;
  timezone: string;

  text?: string;
  attachment_refs: string[];

  correlation_id: string;
  causation_turn_id?: string;
}
```

### 4.1 Session-key rule

Telegram session identity must not be only `chat_id`.

At minimum it is derived from:

```text
tenant + channel + chat + thread/topic + actor scope
```

so separate Telegram forum topics do not share mutable dialogue state accidentally.

### 4.2 Actor/data scope

Every read/write plan is executed under an authenticated actor scope.

Even if the current deployment is effectively single-user, V2 must not encode “global ledger access” as an implicit invariant.

### 4.3 Event time vs processing time

Store both:

- `event_time`: when the source event occurred;
- `received_time`: when V2 received it.

Natural date language is resolved against `event_time + timezone`, not Worker processing time.

DB/audit metadata may also record commit time separately.

### 4.4 Ordering

Each adapter defines a stable `ordering_key`.

For Telegram, message/update identifiers are retained in addition to timestamps.

Rules:

1. duplicate `channel_event_id` + same payload hash -> replay prior result;
2. same event ID + different payload hash -> protocol conflict, no execution;
3. stale event older than the session's last committed ordering point:
   - never silently overwrite session state;
   - never perform a mutation against newer context;
   - return/replay a typed stale/clarification result according to policy;
4. concurrent turns use session-version CAS;
5. a CAS loser may reload and retry the same orchestrator once if the turn is still semantically valid and no side effect has committed; model-call count is recorded.

---

## 5. Orchestrator output protocol

The Dialogue Orchestrator receives:

- current `FinanceTurn`;
- bounded recent turn summaries;
- active normalized FinancePlan;
- active ResultSet/reference metadata;
- relevant category/account catalog;
- event time/timezone;
- capabilities/policy limits.

It returns exactly one schema-constrained discriminated response:

```ts
type OrchestratorOutput =
  | {
      kind: 'new_plan';
      schema_version: 1;
      plan: FinancePlan;
      field_confidence: Record<string, number>;
    }
  | {
      kind: 'patch_plan';
      schema_version: 1;
      patch: FinancePlanPatch;
      field_confidence: Record<string, number>;
    }
  | {
      kind: 'clarification';
      schema_version: 1;
      reason_code: ClarificationReason;
      question: string;
      unresolved_fields: string[];
    }
  | {
      kind: 'non_finance';
      schema_version: 1;
    };
```

### 5.1 Orchestrator may understand

- create/query/summarize/analyze/compare/update/delete/restore;
- multi-turn inheritance;
- topic switches;
- “这笔/那笔/第二笔/这些/刚才删掉的” reference semantics;
- natural date and time language;
- user-requested output fields;
- grouping/sorting/pagination wording;
- clarification need.

### 5.2 Orchestrator may not do

- invent transaction/item/operation IDs;
- assert candidate uniqueness;
- calculate authoritative totals;
- decide DB authorization;
- execute SQL;
- claim a write succeeded;
- silently downgrade ambiguous fields into default category/account;
- bypass deterministic policy.

### 5.3 Failure contract

If the orchestrator times out or returns invalid schema:

- read-only turn: return typed `interpretation_failed` or retry the same contract according to bounded retry policy;
- mutation turn or mutation-like unresolved turn: fail closed;
- never call Command, Conversation, regex intent, `parseIntake`, or another model schema as semantic fallback.

---

## 6. Versioned FinancePlan protocol

All schemas are versioned and `additionalProperties: false` in the actual JSON schema.

```ts
type FinanceOperation =
  | 'create'
  | 'query'
  | 'summarize'
  | 'analyze'
  | 'compare'
  | 'update'
  | 'delete'
  | 'restore';

interface PlanBase {
  schema_version: 1;
  plan_id: string;
  plan_version: number;
  base_session_version: number;
  source_turn_id: string;
  operation: FinanceOperation;
  timezone: string;
  temporal_scope?: FinanceTemporalScope;
  references: ReferenceSpec[];
  presentation: FinancePresentation;
}
```

The model may emit a temporary client-side `plan_id` token only if the code replaces/validates it; durable IDs are issued by code.

### 6.1 Time scope

Natural-language dates are normalized before execution into explicit boundaries.

```ts
interface FinanceTemporalScope {
  from: string;
  to: string;
  timezone: string;
  basis: 'event_time';
  original_expression?: string;
}
```

Rules:

- end boundary is explicitly exclusive;
- week start definition is configured and supplied to the orchestrator;
- no executor code re-interprets user date prose;
- code only validates normalized dates/bounds.

### 6.2 Money

```ts
interface MoneyValue {
  amount_fen: number;
  currency: string;
}
```

No floating-point authoritative amount is accepted by the executor.

### 6.3 Create plan

```ts
interface CreateEntry {
  client_entry_key: string;
  type: 'expense' | 'income' | 'transfer';
  amount: MoneyValue;
  occurred_at: string;
  merchant?: string | null;
  description?: string | null;
  category_ref?: CatalogReference | null;
  account_ref?: CatalogReference | null;
  items?: CreateItem[];
}

interface CreatePlan extends PlanBase {
  operation: 'create';
  entries: CreateEntry[];
}
```

Multi-create is one logical operation with deterministic entry keys.

### 6.4 Query / summarize

```ts
interface FinanceFilters {
  type?: ('expense' | 'income' | 'transfer')[];
  category_refs?: CatalogReference[];
  account_refs?: CatalogReference[];
  merchants?: string[];
  text_terms?: string[];
  amount_min_fen?: number;
  amount_max_fen?: number;
  include_transaction_ids?: string[];
  exclude_transaction_ids?: string[];
}

interface QueryPlan extends PlanBase {
  operation: 'query' | 'summarize';
  filters: FinanceFilters;
}
```

The LLM may express semantic filters; code resolves catalog/reference fields to real IDs before SQL.

### 6.5 Analyze plan

```ts
interface AnalyzePlan extends PlanBase {
  operation: 'analyze';
  filters: FinanceFilters;
  metrics: FinanceMetric[];
  dimensions: FinanceDimension[];
}
```

Analysis uses deterministic aggregation first.

Optional prose generation is a separate post-execution model call and is **not** another intent interpreter.

### 6.6 Compare plan

```ts
interface CompareSide {
  temporal_scope: FinanceTemporalScope;
  filters: FinanceFilters;
}

interface ComparePlan extends PlanBase {
  operation: 'compare';
  left: CompareSide;
  right: CompareSide;
  metrics: FinanceMetric[];
  dimensions: FinanceDimension[];
}
```

The comparison contract explicitly defines both sides; “previous period” is resolved during interpretation to concrete boundaries.

### 6.7 Mutation selection

```ts
type FinanceSelection =
  | { kind: 'exactly_one' }
  | { kind: 'exact_count'; count: number }
  | { kind: 'all_matching'; max_count: number }
  | { kind: 'result_position'; result_set_id: string; ordinal: number }
  | { kind: 'result_subset'; result_set_id: string; ordinals: number[] }
  | { kind: 'reference'; reference: ReferenceSpec };

interface MutationTarget {
  temporal_scope?: FinanceTemporalScope;
  filters: FinanceFilters;
  selection: FinanceSelection;
}
```

`exact_count: N` means code must resolve **exactly N**, not “up to N”.

### 6.8 Update

```ts
interface FinanceChanges {
  amount?: MoneyValue;
  merchant?: string | null;
  description?: string | null;
  category_ref?: CatalogReference | null;
  account_ref?: CatalogReference | null;
  occurred_at?: string;
}

interface UpdatePlan extends PlanBase {
  operation: 'update';
  target: MutationTarget;
  changes: FinanceChanges;
}
```

Null/clear semantics are explicit in schema and never inferred from omitted fields.

### 6.9 Delete

```ts
interface DeletePlan extends PlanBase {
  operation: 'delete';
  target: MutationTarget;
}
```

### 6.10 Restore

```ts
interface RestorePlan extends PlanBase {
  operation: 'restore';
  deleted_operation_ref: ReferenceSpec;
  target_subset?: FinanceSelection;
}
```

Restore resolves an actual prior delete operation/tombstone. “Most recent delete” is valid only if the interpreted ReferenceSpec explicitly says so.

### 6.11 Receipt item patch

Receipt item follow-ups are represented through the same update/delete/restore operation family with typed item references. The target kind distinguishes `transaction`, `transaction_item`, `receipt_parent`, and `operation`.

---

## 7. FinancePlanPatch semantics

Patch behavior is intentionally strict so implementers cannot invent merge semantics.

```ts
interface FinancePlanPatch {
  schema_version: 1;
  base_plan_id: string;
  base_plan_version: number;
  base_session_version: number;

  temporal_scope?: ReplaceOrClear<FinanceTemporalScope>;
  filters?: ReplaceOrClear<FinanceFilters>;
  selection?: ReplaceOrClear<FinanceSelection>;
  changes?: ReplaceOrClear<FinanceChanges>;
  presentation?: ReplaceOrClear<FinancePresentation>;
  references?: ReplaceOrClear<ReferenceSpec[]>;
}
```

Where:

```ts
type ReplaceOrClear<T> =
  | { mode: 'replace'; value: T }
  | { mode: 'clear' };
```

Rules:

1. omitted top-level component = inherit unchanged;
2. supplied component = replace the whole component;
3. lists are replaced, never implicitly appended;
4. `clear` is explicit;
5. no deep implicit merge;
6. every patch carries base plan/session version;
7. version mismatch -> no execution; reload/re-orchestrate or clarification;
8. filter/sort changes reset pagination unless the new presentation explicitly supplies a valid page token;
9. a reference tied to an invalidated ResultSet is rejected, not silently re-queried;
10. code creates the new durable plan version after validation.

This lets `要求带日期，支出项` change presentation without reclassifying the whole conversation through a second parser.

---

## 8. Presentation protocol

Presentation is persistent plan state.

```ts
interface FinancePresentation {
  mode: 'summary' | 'details' | 'analysis' | 'comparison';
  fields: FinanceField[];
  sort: FinanceSort[];
  grouping: FinanceDimension[];
  page_size: number;
  page_token?: string;
  format: 'compact' | 'full';
}

interface FinanceSort {
  field: FinanceField;
  direction: 'asc' | 'desc';
}
```

Rules:

- renderer obeys structured presentation only;
- renderer does not infer missing user intent;
- every sort has a deterministic tie-breaker added by code (`transaction_id` or immutable ordinal);
- pagination uses immutable ResultSet ordinals/page tokens, not live offset re-query;
- changing filters/sort creates a new ResultSet.

---

## 9. Durable session model: turn log + projection + immutable result sets

The old single-row `finance_chat_context` is compatibility-only.

V2 uses three distinct concepts.

### 9.1 Append-only `finance_turns`

Logical columns:

```text
turn_id PRIMARY KEY
schema_version
tenant_id
subject_id
channel
channel_event_id
idempotency_key
payload_hash
session_key
chat_id
thread_id
topic_id
ordering_key
event_time
received_time
timezone
correlation_id
causation_turn_id
interpretation_status
policy_status
execution_status
result_id
operation_id
model_call_count
created_at
```

`channel_event_id` + actor/channel scope has a uniqueness contract.

Turn payload retention must follow privacy policy; raw text is not required indefinitely.

### 9.2 Mutable `finance_sessions` projection

Logical columns:

```text
session_key PRIMARY KEY
version
active_plan_id
active_plan_version
active_result_set_id
active_topic
last_committed_turn_id
last_ordering_key
reference_index_version
updated_at
expires_at
```

All updates use CAS on `version`.

The projection can be rebuilt from durable turns/plans/results if required.

### 9.3 Versioned plan store

```text
finance_plans
- plan_id
- plan_version
- session_key
- source_turn_id
- schema_version
- plan_json
- created_at
PRIMARY KEY(plan_id, plan_version)
```

Plans are immutable versions.

### 9.4 Immutable ResultSet

A query result used by conversation references is materialized as a stable handle.

```text
finance_result_sets
- result_set_id PRIMARY KEY
- session_key
- source_turn_id
- plan_id
- plan_version
- query_fingerprint
- ledger_snapshot_token
- total_count
- created_at
- expires_at

finance_result_set_items
- result_set_id
- ordinal
- entity_type
- entity_id
- entity_version
PRIMARY KEY(result_set_id, ordinal)
```

This solves:

- `第二笔`;
- `这些`;
- `上一页这些`;
- stable pagination;
- later inserts changing page membership.

The implementation must not use “re-run the old query and hope ordering is unchanged” as the primary reference strategy.

### 9.5 Result-set lifetime

ResultSet handles have:

- explicit TTL;
- explicit session/topic scope;
- typed entity membership;
- immutable ordinal;
- stale-row detection via entity version where applicable.

If a referenced row changed after snapshot, policy decides whether to require clarification/reload; code does not silently mutate a different row.

### 9.6 Topic switch

The orchestrator may open a new plan within the same session when the user changes topic.

The session projection keeps only one active pointer, but recent typed references/plans remain addressable within bounded retention.

A new topic must not destroy durable history needed for explicit references such as “回到刚才那组烟酒支出”.

---

## 10. Typed reference protocol

```ts
type ReferenceSpec =
  | { kind: 'active_plan' }
  | { kind: 'result_set'; result_set_id: string }
  | { kind: 'result_position'; result_set_id: string; ordinal: number }
  | { kind: 'transaction'; semantic_key: string }
  | { kind: 'transaction_item'; receipt_ref: string; ordinal?: number; semantic_key?: string }
  | { kind: 'receipt'; semantic_key: string }
  | { kind: 'operation'; operation_kind?: string; recency?: 'latest' | 'previous'; semantic_key?: string }
  | { kind: 'created_by_turn'; turn_id: string }
  | { kind: 'deleted_by_operation'; operation_id: string };
```

The JSON schema used by the model must not accept arbitrary DB IDs as if trusted.

### 10.1 Resolver responsibilities

Code resolves references into:

```ts
interface ReferenceResolution {
  status: 'resolved' | 'no_match' | 'ambiguous' | 'expired' | 'stale' | 'forbidden';
  entity_type?: string;
  entity_ids: string[];
  candidate_count: number;
  candidate_summaries?: SafeCandidateSummary[];
}
```

### 10.2 Resolution priority

The resolver follows explicit structured reference type, not regex against the original user prose.

Typical priority:

1. explicit ResultSet/ordinal;
2. explicit prior operation/tombstone;
3. current receipt/item reference;
4. session recent-reference index;
5. constrained semantic DB filter from the plan.

### 10.3 Ambiguity

Ambiguity is a code fact.

The LLM may request a clarification, but it may not convert multiple real candidates into one by confidence.

### 10.4 Receipt references

`这张小票` resolves to a durable receipt/parent reference created by the receipt operation, scoped to the same actor/session/topic unless the plan explicitly chooses another scope.

`第二项` resolves using immutable item order stored for that receipt version.

---

## 11. Unified operation, idempotency, and audit contract

All finance writes, including receipt writes, use a unified operation record.

Logical table:

```text
finance_operations
- operation_id PRIMARY KEY
- schema_version
- idempotency_key UNIQUE
- turn_id
- session_key
- actor_subject_id
- operation_type
- status
- plan_id
- plan_version
- target_count
- before_snapshot_ref
- after_snapshot_ref
- result_id
- error_code
- created_at
- committed_at
```

Recommended operation states:

```text
reserved
interpreted
policy_rejected
ready
executing
committed
failed_precommit
```

After `committed`, replay does not execute again.

Delivery status is not stored as operation status.

### 11.1 Idempotency reservation

Before a mutation executes:

1. reserve unique `idempotency_key`;
2. if already terminal, replay stored FinanceResult;
3. if in progress, return typed `in_progress`/retry semantics;
4. do not issue a second mutation.

### 11.2 Key derivation

- Telegram: actor/channel + update/message identity + operation slot;
- API: caller-supplied idempotency key is required for mutation; compatibility routes without one receive a generated key only if retry semantics are explicitly documented;
- Queue receipt: stable receipt source identity + job version.

### 11.3 Create audit

Create is no longer outside the operation model.

Create, update, delete, restore, and receipt creation all produce operation/audit evidence.

### 11.4 Existing `ledger_operations`

Migration design may:

- extend it into the new operation/audit model; or
- preserve it as immutable legacy evidence and introduce new V2 tables.

The implementation must not rewrite or discard historical audit evidence without a separate migration/recovery plan.

---

## 12. Deterministic safety policy

Safety is centralized and channel-independent.

### 12.1 Authorization and scope

Before DB resolution:

- validate actor;
- validate tenant/ledger scope;
- validate session/topic reference scope;
- reject cross-scope references unless explicitly authorized.

### 12.2 Cardinality

- `exactly_one`: candidate count must equal 1;
- `exact_count:N`: candidate count must equal N;
- `all_matching`: candidate count must be <= explicit policy max;
- partial mutation is forbidden when requested cardinality is not satisfied.

### 12.3 Row version / CAS

Mutation targets carry/read entity version where possible.

If a target changed after the referenced ResultSet/snapshot, mutation does not silently apply to a newer state.

### 12.4 Money

Validate:

- integer fen;
- positive/allowed bounds;
- supported currency;
- currency consistency for aggregates/compare;
- no floating-point ledger writes.

### 12.5 Category/account

DB resolver must distinguish:

- resolved;
- ambiguous;
- invalid-for-transaction-type;
- inactive/historical-only;
- missing.

Silent semantic downgrade to `其他支出` / unspecified is allowed only under an explicit product policy for that operation, and the downgrade must be represented in the result/audit. It must never masquerade as high-confidence resolution.

### 12.6 Delete/restore

Delete captures enough immutable snapshot data to restore the same entity/items.

Restore requires a real delete/tombstone operation reference and honors current authorization.

### 12.7 Receipt invariants

Before receipt commit:

- provider result validated;
- amount reconciliation policy satisfied;
- parent/item amount invariants satisfied;
- item order stable;
- account/category mappings policy-valid.

### 12.8 Prompt injection / untrusted text

Merchant descriptions, receipt OCR, prior user text, and catalog labels are data, not instructions.

The orchestrator/provider prompts must use schema-constrained outputs and bounded context.

### 12.9 Cost/rate limits

Model and external-provider calls have:

- per-turn budget;
- retry cap;
- timeout;
- observable call count;
- kill switch.

A cost-limit failure before mutation is fail-closed.

### 12.10 Error taxonomy

At minimum:

```text
interpretation_failed
clarification_required
unauthorized
forbidden_scope
no_match
ambiguous_target
expired_reference
stale_reference
stale_turn
cardinality_mismatch
invalid_money
invalid_category
invalid_account
policy_rejected
idempotency_conflict
in_progress
db_read_failed
db_commit_failed
provider_failed
render_failed
delivery_pending
delivery_failed
```

Internal provider/DB details are not returned raw to users.

---

## 13. Deterministic executor

The executor accepts only validated structured plans/resolutions.

It does not read user prose.

Responsibilities:

- deterministic D1 reads;
- stable query ordering;
- immutable ResultSet creation;
- exact aggregates;
- category/account lookup;
- target resolution;
- row/version checks;
- create/update/delete/restore;
- receipt parent/items;
- before/after capture;
- typed FinanceResult.

Channel-specific behavior is forbidden in the executor.

---

## 14. Atomic commit boundary

For a side-effecting finance operation, the durable commit boundary must atomically establish as much as belongs to the finance state transition:

- ledger row/item changes;
- operation terminal state;
- before/after audit evidence;
- plan/session projection advancement;
- resulting references/result handle;
- idempotency terminal result;
- Telegram outbox record when a Telegram response is required.

The exact D1 mechanism may be chosen during implementation, but atomicity must be proven with failure-injection tests.

### 14.1 Renderer/send after commit

Rendering and external send happen after finance commit.

If Telegram send fails:

- ledger operation remains committed;
- outbox remains pending/failed-retryable;
- retry uses the same outbox/message identity;
- no ledger re-execution;
- no duplicate user-visible message where platform idempotency/dedup can prevent it.

### 14.2 Read-only turns

Read-only turn/session/result persistence may use a smaller transaction boundary, but session projection and ResultSet creation must not produce contradictory state.

---

## 15. FinanceResult and lifecycle protocol

Do not overload one `status` field with execution and delivery meanings.

```ts
interface FinanceResult {
  schema_version: 1;
  result_id: string;
  turn_id: string;
  operation_id?: string;
  plan_id: string;
  plan_version: number;

  interpretation_status:
    | 'interpreted'
    | 'clarification'
    | 'failed'
    | 'non_finance';

  policy_status:
    | 'not_required'
    | 'approved'
    | 'rejected';

  execution_status:
    | 'not_started'
    | 'no_match'
    | 'executed'
    | 'failed';

  commit_status:
    | 'not_applicable'
    | 'not_committed'
    | 'committed';

  replay_status:
    | 'original'
    | 'duplicate_replay'
    | 'in_progress';

  rows?: FinanceResultRow[];
  summary?: FinanceSummary;
  analysis_data?: FinanceAnalysisData;
  comparison_data?: FinanceComparisonData;
  result_set_id?: string;
  transaction_ids: string[];
  item_ids: string[];
  audit_ids: string[];
  safe_error?: FinanceError;
}
```

Render and delivery are separate records.

### 15.1 Replay

A duplicate committed mutation returns the original stored FinanceResult with `duplicate_replay`.

It does not re-run target selection against current DB state.

---

## 16. Renderer and outbox

### 16.1 Renderer

Renderer input:

- FinanceResult;
- FinancePresentation;
- safe locale/channel metadata.

Renderer must not:

- call the dialogue orchestrator;
- re-query the ledger to reconstruct facts;
- reinterpret user prose;
- change the target/result set.

### 16.2 Deterministic factual rendering

Dates, rows, amounts, totals, pagination, before/after mutation confirmations are deterministic.

### 16.3 Analysis prose

An optional post-execution LLM may turn structured `analysis_data` into concise prose.

Contract:

- it is not an intent parser;
- it receives no authority to change the plan or result;
- amounts/percentages are supplied from code;
- output is schema-constrained or bounded into known sections;
- call count/cost/failure is observable;
- failure falls back to deterministic analysis rendering, not to another semantic parser.

### 16.4 Outbox

Logical table:

```text
finance_outbox
- outbox_id PRIMARY KEY
- turn_id
- result_id
- channel
- destination_key
- render_version
- payload_hash
- status
- attempt_count
- next_attempt_at
- last_error_code
- created_at
- sent_at
```

Status example:

```text
pending
sending
sent
failed_retryable
failed_terminal
```

A send retry never re-executes finance logic.

---

## 17. API and Telegram behavior contract

### 17.1 Telegram natural language

All finance-capable text enters V2 FinanceTurn -> single orchestrator.

No Command/Conversation/regex/legacy automatic semantic fallback in V2 mode.

### 17.2 Structured read API

Structured read endpoints may construct a structured QueryPlan directly without LLM.

They still use:

- actor scope;
- deterministic executor;
- FinanceResult;
- unified sorting/result semantics.

### 17.3 Natural-language API

Preferred V2 endpoint is a versioned finance-turn contract, e.g. `/v2/finance/turn`.

If `/v1/intake` remains during migration:

- it is explicitly labeled compatibility;
- route mode is observable;
- it never becomes automatic fallback from V2;
- its write permissions can be disabled independently;
- its retirement date/gate is defined.

### 17.4 API idempotency

Mutation API callers must supply a durable idempotency key in V2.

### 17.5 Cross-channel sessions

No implicit cross-channel context sharing.

If Telegram and API should share a session, that mapping must be explicit and actor-authorized.

---

## 18. Analysis and comparison

`analyze` and `compare` are first-class FinancePlan operations, not separate NLP route schemas.

### 18.1 Analyze

Flow:

```text
orchestrator interpretation
  -> deterministic data query/aggregation
  -> FinanceAnalysisData
  -> optional prose model
  -> renderer
```

### 18.2 Compare

Both comparison sides are explicit in the plan.

Code computes:

- expense;
- income;
- transfer if requested;
- net;
- requested dimensions/metrics.

The prose model cannot redefine the comparison period.

### 18.3 Model call budget

Expected baseline:

- ordinary natural-language turn: 1 interpretation model call;
- analysis with prose: 1 interpretation + at most 1 prose-generation call;
- receipt item taxonomy may add the bounded provider/classification call defined in receipt policy.

No second interpretation parser is allowed.

---

## 19. Receipt integration contract

Receipt is a professional extraction adapter feeding the same finance core.

### 19.1 ReceiptTurn / job

Versioned job:

```ts
interface ReceiptJob {
  schema_version: 2;
  job_id: string;
  source_event_id: string;
  idempotency_key: string;
  turn_id: string;
  actor: FinanceActor;
  session_key: string;
  event_time: string;
  timezone: string;
  attachment_ref: string;
  caption?: string;
  attempt: number;
}
```

Old queue jobs retain their old version and use a compatibility decoder/consumer until drained.

### 19.2 Extraction

Provider/OCR produces:

```ts
interface ReceiptResolvedInput {
  schema_version: 1;
  provider: string;
  provider_attempt_id: string;
  merchant?: string;
  total_fen: number;
  currency: string;
  occurred_at?: string;
  payment_hint?: string;
  items: ReceiptResolvedItem[];
  reconciliation: ReceiptReconciliation;
}
```

Provider output is untrusted until code validation/reconciliation passes.

### 19.3 Caption

Caption is user natural language.

If caption contains finance semantics such as “算日用品，用支付宝”:

- the same Dialogue Orchestrator interprets the caption against the bounded `ReceiptResolvedInput`;
- no receipt-specific natural-language parser is added.

If caption is absent, code may construct a deterministic machine-origin CreatePlan from validated extraction to avoid unnecessary dialogue interpretation.

### 19.4 Commit

Receipt creation uses the same executor/operation/idempotency/audit/result/outbox boundary.

It may not directly insert `transactions` from the queue processor.

### 19.5 References

After commit, store typed durable references to:

- receipt/attachment;
- parent transaction;
- ordered item IDs;
- create operation;
- source event.

Then follow-ups such as:

- `第二项改成日用品`;
- `这张小票撤销`;
- `刚才超市那笔金额不对`

use the same orchestrator/reference/safety/executor core.

### 19.6 Provider/classification failures

Policy must explicitly decide:

- fail receipt;
- continue with unresolved category;
- request user clarification.

A classification-model error may not silently masquerade as a high-confidence category.

### 19.7 Queue retry and delivery

Receipt processing is at-least-once, but operation commit is exactly-once by idempotency key.

Telegram final messages use outbox state.

---

## 20. Observability contract

Every production finance event must be traceable by safe identifiers:

- `turn_id`;
- `channel_event_id`;
- `correlation_id`;
- `session_key` hash/safe ID;
- session version;
- plan ID/version;
- operation ID;
- idempotency key hash;
- model call count;
- provider call count;
- reference resolution status;
- target count;
- policy status;
- commit status;
- result ID/result-set ID;
- outbox ID;
- delivery attempt/status;
- Queue job version/attempt.

### 20.1 Privacy

Do not log:

- secrets/tokens;
- raw Authorization;
- full OCR payload by default;
- full raw user finance text in long-retention telemetry;
- full before/after finance snapshots in ordinary logs.

Durable audit data and operational telemetry have separate retention/access policy.

### 20.2 Success meanings

Telemetry and health reporting distinguish:

```text
request accepted
turn interpreted
policy approved
DB committed
Queue acked
outbox sent
Telegram API accepted
delivery terminal/unknown
```

No generic `PASS` may collapse those into one state.

---

## 21. Shadow mode contract

Shadow mode exists only to compare interpretation safely.

### 21.1 Absolute production side-effect prohibition

Shadow V2 may not:

- write production D1;
- write production R2;
- enqueue production Queue messages;
- create/update session projection;
- reserve production idempotency/operation records;
- create production ResultSets;
- create outbox records;
- send Telegram/API responses;
- call Veryfi or another external receipt provider;
- persist attachments;
- invoke mutation executor;
- alter V1 behavior.

### 21.2 Allowed shadow work

For sampled Telegram text turns only:

- construct an in-memory FinanceTurn snapshot;
- load bounded read-only context through an isolated read path;
- call the single V2 interpretation model under a cost budget;
- validate the returned plan in memory;
- compare redacted/structural fields against V1 observed outcome.

Optional shadow telemetry must use a dedicated isolated dataset/namespace and contain only redacted aggregate or hashed metadata, never production session state or raw finance text.

### 21.3 Cost/privacy

Define:

- sampling percentage;
- per-day model-call budget;
- kill switch;
- no analysis prose shadow call unless specifically approved;
- retention of comparison metadata;
- no raw sensitive text.

### 21.4 Proof

Shadow acceptance requires evidence that a shadow divergence cannot affect V1 execution or user-visible response.

---

## 22. Migration and rollback contract

V2 database evolution is forward-compatible and additive until full cutover evidence is complete.

### 22.1 Migration families

New migration(s), expected from 0008 onward, may create:

- finance_turns;
- finance_sessions;
- finance_plans;
- finance_result_sets;
- finance_result_set_items;
- finance_operations / audit extensions;
- finance_outbox;
- receipt attempt/job metadata;
- entity version support if required.

Do not destructively rewrite `transactions` merely to support V2.

### 22.2 Existing 0001-0007 compatibility matrix

Implementation tests must explicitly cover:

1. fresh DB applying 0001 through new V2 migrations;
2. production-like DB already at 0007 upgrading forward;
3. inactive categories introduced by 0006 remain historically readable;
4. 0005 recovery-log FK interaction with delete/restore;
5. legacy 0007 audit rows remain readable/explainable;
6. old transaction source/source_id uniqueness remains valid;
7. transaction_items cascade behavior remains compatible with restore design.

### 22.3 Old Worker / new schema

Before migration:

- prove the current production Worker can continue operating with additive V2 tables present;
- no new NOT NULL/constraint change may break old writes during the compatibility window.

### 22.4 New Worker / old data

V2 must read existing ledger/history without requiring destructive rewrite.

### 22.5 Rollback philosophy

Production rollback is primarily **route rollback/forward-fix**, not reverse-migration of committed ledger data.

If V2 is disabled after legitimate V2 user mutations:

- existing transactions remain visible to V1;
- V2 operation/session/outbox tables may remain;
- do not reverse valid user finance actions merely because code was rolled back.

A defective V2 mutation requires an explicit compensating/recovery procedure with audit evidence, not blanket DB downgrade.

### 22.6 No destructive down migration requirement

Additive tables need not be dropped during emergency route rollback.

Schema rollback that risks data loss is not the primary recovery mechanism.

### 22.7 Queue in-flight versioning

Receipt Queue jobs carry schema version.

Cutover must define:

- last time old-version jobs are accepted;
- old-job drain metric;
- compatibility decoder/consumer lifetime;
- removal gate for old receipt processor.

### 22.8 Feature/cutover flags

Logical route state:

```text
v1
shadow
canary
v2
```

Separate controls exist for:

- text finance route;
- natural-language API;
- receipt job producer;
- receipt consumer version;
- legacy write compatibility.

Flags are observable and reversible before legacy deletion.

---

## 23. Cutover gates and legacy deletion

Legacy semantic code is not deleted merely because V2 unit tests pass.

### 23.1 Required route states

Every current semantic path is labeled in rollout metadata as one of:

```text
primary_v1
shadow_v2
canary_v2
primary_v2
compatibility_only
disabled
removed
```

### 23.2 Hard prohibition

In `primary_v2`:

- mutation failure does not fall into legacy;
- natural-language Telegram does not call Command NLP, Conversation NLP, regex intent, or `parseIntake`;
- legacy `/v1/intake` is only reachable by its explicit compatibility endpoint/mode.

### 23.3 Deletion candidates

After evidence and compatibility window:

- Command NLP classification;
- Conversation route schema/semantic regex gates;
- default `parseFinanceTextQuery` language authority;
- `parseIntake` language authority;
- legacy finance Telegram fallback;
- production test hook `__mockParsedIntake`;
- old receipt processor after job drain.

### 23.4 Minimum deletion evidence

Before removing each path:

- no production traffic uses it for the defined window;
- corresponding V2 E2E suite passes;
- rollback no longer depends on that code;
- receipt old-job backlog is zero for old processor deletion;
- canary/full V2 has no unresolved P0/P1 semantic or mutation defect.

---

## 24. Architecture guard contract

Architecture guards inspect the actual production import/call graph or enforce equivalent static/runtime invariants.

Required assertions:

1. one natural-language text turn can reach only one Dialogue Orchestrator entry;
2. orchestrator error cannot invoke a second semantic parser;
3. all finance writes originate from the V2 executor package;
4. adapter files contain no finance semantic-routing regex/keyword branches;
5. renderer cannot import/write ledger executor;
6. receipt provider/queue adapter cannot directly write transaction tables;
7. compatibility parser cannot be imported by primary V2 route;
8. one channel event maps to one durable turn/idempotency reservation;
9. a committed operation replay cannot execute mutation SQL again;
10. structured API bypass of LLM is explicit and type-level, not based on keyword guessing.

A guard that only checks file names/existence is insufficient.

---

## 25. Test and acceptance contract

V2 cannot be called complete after isolated sentence tests.

### 25.1 Protocol/schema tests

- FinanceTurn;
- every FinancePlan discriminant;
- PlanPatch replace/clear/inherit semantics;
- invalid additional properties;
- money/currency;
- date boundaries/timezone;
- actor scope;
- ReferenceSpec;
- Result lifecycle.

### 25.2 Full app-route tests

Exercise the real `src/app.ts` equivalent V2 entry path for:

- Telegram text;
- Telegram photo/caption;
- natural-language API;
- structured read APIs;
- explicit compatibility route;
- Queue consumer.

### 25.3 Model call-budget tests

Assert:

- ordinary turn: one interpretation authority;
- no second parser on invalid output;
- analysis optional prose is distinguishable from interpretation;
- receipt provider/classifier calls are separately counted.

### 25.4 Required dialogue matrix

#### A. Query refinement

```text
把上周六到今天的财务支出详细列出来
→ 要求带日期，支出项
→ 只看餐饮
→ 金额大的放前面
→ 下一页
→ 这些一共多少
```

One coherent task state and immutable result references.

#### B. Cross-operation continuity

```text
本月支出明细
→ 只看烟酒
→ 第二笔改成支付宝
→ 撤销刚才这个修改
```

#### C. New task then return

```text
本月支出明细
→ 只看烟酒
→ 午饭25元
→ 回到刚才烟酒那些
→ 一共多少
```

#### D. Pronouns/references

Cover:

- 这笔;
- 那笔;
- 上一笔;
- 刚才两笔;
- 第二笔;
- 这些;
- 上面那些;
- 刚才删掉的;
- 这张小票;
- 第二项.

#### E. Presentation

- dates;
- item only;
- amount;
- account/category;
- sort;
- grouping;
- page changes;
- compact/full.

#### F. Topic/thread isolation

Same chat, different Telegram topics must not share mutable context accidentally.

### 25.5 Mutation safety

- zero/one/multiple candidate cases;
- exact_count must match exactly;
- stale ResultSet row;
- row-version conflict;
- update/delete/restore duplicate replay;
- restore exact delete operation;
- no mutation fall-through.

### 25.6 Idempotency/concurrency

- duplicate Telegram update;
- same event concurrent delivery;
- API timeout/retry;
- Queue duplicate;
- stale event;
- session CAS conflict;
- payload-hash conflict.

### 25.7 Stable ResultSet/pagination

- equal timestamps;
- inserts after page 1;
- update after snapshot;
- page token;
- current page vs full result set;
- ordinal reference remains deterministic.

### 25.8 Failure injection

Inject failures at:

- orchestrator timeout/invalid schema;
- reference DB read;
- policy;
- operation reservation;
- ledger write;
- item write;
- audit write;
- session CAS;
- ResultSet creation;
- outbox creation;
- render;
- Telegram send;
- Queue ack/retry;
- receipt provider;
- analysis prose call.

Prove no impossible partial terminal state.

### 25.9 Receipt E2E

- real/isolated provider path as appropriate;
- reconciliation;
- parent/items;
- caption semantics;
- item update;
- receipt delete/restore;
- duplicate Queue job;
- send retry;
- old-job drain compatibility.

### 25.10 Migration/rollback E2E

- fresh install;
- 0007 -> V2 upgrade;
- production-like copied data;
- 0005 FK/hard-delete edge;
- 0006 inactive categories;
- old Worker + new additive schema;
- new Worker + historical data;
- route rollback after V2 committed operations;
- migration failure/forward fix;
- old Queue job during new deployment.

### 25.11 Shadow/canary proof

- shadow writes zero production state;
- shadow sends zero user messages;
- shadow calls no receipt provider;
- V1 behavior unchanged by V2 divergence;
- canary scope cannot leak to non-canary actor/session.

### 25.12 Real external evidence

Before production closeout, evidence distinguishes:

- real Workers AI interpretation;
- real D1;
- real Queue;
- real Telegram API response;
- actual user-visible Telegram reply where required.

Local mocks cannot be reported as those results.

---

## 26. Implementation module boundaries

Final intended module ownership:

```text
1. channel-adapters/
   Telegram/API/Queue transport only.

2. finance-turn/
   turn identity, actor, ordering, idempotency ingress.

3. finance-orchestrator/
   the single natural-language understanding contract.

4. finance-plan/
   versioned Plan/PlanPatch/schema validation.

5. finance-session/
   turn log, plan store, session projection.

6. finance-results/
   immutable ResultSet/reference store.

7. finance-reference/
   deterministic catalog/entity/operation resolution.

8. finance-safety/
   authorization, ambiguity, cardinality, CAS, money/domain policy.

9. finance-executor/
   the only ledger read/write business executor.

10. finance-operations/
    operation identity, audit, idempotency, snapshots.

11. finance-render/
    deterministic renderers and bounded analysis prose adapter.

12. finance-outbox/
    durable delivery state/retry.

13. receipt-extraction/
    provider/OCR/resolver/reconciliation, no ledger writes.

14. compatibility/
    explicit legacy adapters only; never automatic fallback.
```

The physical file layout may vary, but ownership/invariants may not.

---

## 27. Implementation sequence

No implementation phase starts until this revised Blueprint is independently reviewed as `BLUEPRINT_READY`.

### Phase 0 - Architecture re-audit

- audit this revision against current `main`;
- require explicit pass/fail on all prior A-I findings;
- no product-code changes.

### Phase 1 - Protocol freeze

Implement only schema/types/tests/migration design in isolated branch:

- FinanceTurn;
- FinancePlan;
- PlanPatch;
- Reference;
- Result;
- operation/outbox states.

No production route switch.

### Phase 2 - Persistence core

Implement:

- turn log;
- plan store;
- session projection;
- ResultSet store;
- operation/idempotency;
- outbox;
- migrations.

Prove fresh/upgrade/rollback compatibility.

### Phase 3 - Deterministic core

Implement:

- resolver;
- safety;
- executor;
- renderer.

Port reusable SQL/snapshot/reconciliation logic without importing legacy NLP authority.

### Phase 4 - Orchestrator

Implement the one schema-constrained dialogue interpretation layer.

No legacy fallback inside V2.

### Phase 5 - Receipt integration

Version receipt jobs and route validated extraction through V2 executor.

### Phase 6 - Full isolated E2E

Complete dialogue, idempotency, concurrency, failure, migration, receipt suites.

### Phase 7 - Shadow

Strict read-only/sampled interpretation shadow under the shadow contract.

### Phase 8 - Canary

Controlled actor/session scope.

### Phase 9 - Primary V2

V2 is the only default natural-language finance route.

### Phase 10 - Legacy retirement

After evidence window and rollback independence, remove old semantic authorities.

---

## 28. Production rollback runbook requirements

Before canary, a concrete runbook must exist and be tested.

It must specify:

1. exact flag to move `canary/v2 -> v1`;
2. whether new V2 events are accepted during rollback;
3. how pending outbox is handled;
4. how in-progress operations are allowed to settle/replay;
5. how receipt producer/consumer versions are switched;
6. how old Queue jobs are drained;
7. why old Worker remains compatible with additive schema;
8. how valid V2 ledger mutations remain visible;
9. how a proven defective V2 mutation is compensated with audit;
10. who/what determines rollback success.

“Deploy the old Worker” alone is not an acceptable rollback plan.

---

## 29. Definition of BLUEPRINT_READY

Architecture audit may return `BLUEPRINT_READY` only if it finds no unresolved design blocker in these categories:

- single LLM semantic authority;
- FinanceTurn identity/ordering/actor scope;
- complete Plan/PlanPatch semantics;
- long-lived multi-turn session model;
- immutable result/reference model;
- exact mutation cardinality;
- all-operation idempotency;
- receipt through the same write core;
- atomic operation/audit/session/result/outbox boundary;
- delivery retry independent of ledger execution;
- structured API and natural-language API boundary;
- shadow has no production side effects;
- migration/old Worker/Queue compatibility;
- executable route rollback;
- cutover/legacy deletion gates;
- observability;
- realistic full-dialogue/concurrency/failure/E2E acceptance.

`BLUEPRINT_READY` does **not** mean product code is finished. It means implementation can begin without knowingly carrying an architecture-level blocker.

---

## 30. Definition of V2 completion

V2 may be called production-complete only when all are true:

1. primary natural-language finance traffic uses one orchestrator;
2. no automatic semantic fallback to Command/Conversation/regex/legacy;
3. create/query/summarize/analyze/compare/update/delete/restore pass the full route;
4. multi-turn dialogue matrix passes;
5. result references/pagination are stable;
6. all mutations and receipt creation are idempotent;
7. receipt follow-up references work;
8. operation/audit/session/result/outbox states are coherent under failure;
9. migration + rollback evidence passes;
10. shadow/canary/full-cutover evidence passes;
11. actual Telegram user-visible behavior is verified;
12. legacy semantic paths are compatibility-only or removed according to cutover gate;
13. architecture guards prevent reintroduction of a second semantic authority.

This definition intentionally prevents a handful of sentence tests from being reported as “彻底完成”.
