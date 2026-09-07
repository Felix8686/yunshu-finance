# Finance Orchestrator V2 Blueprint

Status: architecture blueprint only. No production code change in this branch yet.

## 0. Non-negotiable architecture rule

The system must follow one rule everywhere:

**The model is the only natural-language understanding layer. Code is the only fact, execution, persistence, safety, and audit layer.**

This means:

- The model owns intent understanding, contextual interpretation, ellipsis, pronouns, natural date language, user preferences, and conversation continuity.
- Code owns database reads/writes, exact arithmetic, ID resolution, ambiguity checks, authorization, idempotency, atomicity, ordering, pagination boundaries, audit, and rollback.
- Regex/keyword parsers may exist only as optional deterministic fast paths or input sanitation. They must never create a second semantic authority or a parallel fallback intent system.
- A mutation may never fall through from one AI interpretation layer into another AI interpretation layer after failure.

Any future change that creates another parallel intent parser must be treated as an architecture regression unless this document is explicitly revised first.

---

## 1. Why V2 is required

The current production system has several independent finance language paths:

1. Finance Command Layer
2. Finance Conversation Layer
3. deterministic `parseFinanceTextQuery`
4. legacy intake parsing / handler fallbacks

This has produced a class of failures where each component understands part of the user's language, but no component owns the full conversation state.

Observed example:

- Turn 1: `把上周六到今天的财务支出给我详细列出来`
- Turn 2: `要求带日期，支出项`

Turn 1 can be answered, but the semantic state required by turn 2 is not represented as a single persistent task. The second turn therefore loses the active query context.

The problem is architectural, not a lack of model capability.

---

## 2. Target architecture

```text
Telegram / API / Receipt / Future channels
                |
                v
          Finance Ingress
                |
                v
     Finance Dialogue Orchestrator
        (single LLM authority)
                |
                v
          FinancePlan / Patch
                |
       +--------+---------+
       |                  |
       v                  v
 Session / Reference   Safety Policy
       |                  |
       +--------+---------+
                |
                v
    Deterministic Finance Executor
                |
                v
          FinanceResult
                |
                v
            Renderer
                |
                v
        Telegram / API response
```

There must be only one natural-language route into finance behavior.

---

## 3. Core protocol: FinancePlan

`FinancePlan` is the contract between model understanding and deterministic code.

The model may create a new plan or patch an existing one. It must not directly emit SQL, transaction IDs that it invented, or mutation results.

Suggested logical shape:

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

interface FinancePlan {
  version: 2;
  operation: FinanceOperation;
  scope: FinanceScope;
  filters: FinanceFilters;
  selection: FinanceSelection;
  changes?: FinanceChanges;
  presentation: FinancePresentation;
  references: FinanceReferences;
  source_turn_id: string;
  confidence: number;
}
```

### 3.1 FinanceScope

Must support at least:

- absolute date range
- relative period resolved against event time
- current result set
- explicit recent-N
- explicit current/previous period

Natural expressions such as `上周六到今天`, `刚才`, `之前那些`, `本月`, `上一页这些` are interpreted by the model, but relative time is converted into explicit absolute boundaries before execution.

### 3.2 FinanceFilters

Must be composable, not sentence-specific:

- transaction type
- category
- account
- merchant
- amount / amount range
- semantic text condition
- exact IDs resolved by code
- inclusion/exclusion filters

### 3.3 FinanceSelection

Represents how a mutation chooses records:

- all matching
- exactly one matching
- first/last/Nth in current result
- explicit count
- selected result IDs from current session

The model describes selection semantics. Code resolves real rows and IDs.

### 3.4 FinancePresentation

Presentation is first-class conversation state, not hard-coded renderer behavior.

Must support:

- mode: summary/details/analysis/comparison
- fields: date/item/amount/category/account/merchant/type/time
- sort field and direction
- page/page size
- grouping
- compact/full formatting

This is required so a follow-up such as `要求带日期，支出项` becomes a plan patch rather than a new intent classification problem.

### 3.5 FinanceReferences

Must support explicit references to prior conversational state:

- active plan
- last result set
- last mutation
- result position (`第二笔`)
- recent created transactions (`刚才两笔`)
- recent deleted transactions
- receipt-created transaction and items

The model resolves language to reference semantics. Code resolves those semantics to durable IDs.

---

## 4. PlanPatch and multi-turn behavior

Every finance turn is interpreted with:

1. current user message
2. active session state
3. recent finance turns
4. current plan
5. current result metadata
6. reference catalog (valid categories/accounts)
7. event time and timezone

The model returns one of:

- `new_plan`
- `patch_plan`
- `clarification_needed`
- `non_finance`

Example:

Turn 1:

`把上周六到今天的财务支出详细列出来`

Plan:

```json
{
  "operation": "query",
  "scope": {"from": "2026-09-05", "to": "2026-09-07"},
  "filters": {"type": "expense"},
  "presentation": {"mode": "details", "page": 1}
}
```

Turn 2:

`要求带日期，支出项`

Patch:

```json
{
  "presentation": {
    "fields": ["date", "item", "amount"]
  }
}
```

Turn 3:

`只看餐饮`

Patch:

```json
{
  "filters": {"category": "餐饮"},
  "presentation": {"page": 1}
}
```

Turn 4:

`金额最大的放前面`

Patch:

```json
{
  "presentation": {
    "sort": {"field": "amount", "direction": "desc"}
  }
}
```

Turn 5:

`这些一共多少钱`

This may be represented as a new summarize plan referencing the active filtered result set rather than re-parsing the original period from scratch.

---

## 5. Session state model

The existing `finance_chat_context` is insufficient because it only stores range, label, mode, and last user text.

V2 requires durable structured session state.

Recommended new table (logical design; final migration can refine names):

```text
finance_sessions
- chat_id / session_key PRIMARY KEY
- version INTEGER
- active_plan_json TEXT
- active_result_json TEXT
- recent_references_json TEXT
- last_turn_id TEXT
- last_event_time TEXT
- updated_at TEXT
- expires_at TEXT
```

### 5.1 active_plan_json

Stores the normalized plan after every successful finance turn.

### 5.2 active_result_json

Must not blindly store large full result rows.

Store bounded metadata sufficient for references:

- query fingerprint
- ordered result IDs for the visible page / bounded recent set
- total count
- page/page size
- executed filter fingerprint
- renderer metadata

For large queries, code must be able to reproduce the result set deterministically from the plan rather than storing every row.

### 5.3 recent_references_json

Bounded, typed references such as:

- last_created_ids
- last_updated_ids
- last_deleted_ids
- last_restored_ids
- last_receipt_transaction_id
- previous_active_plan (optional bounded history)

### 5.4 version and ordering

Every update must use optimistic version checks so delayed or concurrent messages cannot silently overwrite newer state.

Telegram event timestamp and update/message IDs must be part of turn metadata.

---

## 6. Unified turn model

Every incoming finance-capable message becomes a `FinanceTurn` before model interpretation.

```ts
interface FinanceTurn {
  turn_id: string;
  channel: 'telegram' | 'api' | 'receipt' | string;
  channel_event_id: string;
  chat_or_session_id: string;
  text?: string;
  event_time: string;
  received_time: string;
  timezone: string;
  attachment_refs?: string[];
}
```

This gives one idempotency and ordering model across channels.

---

## 7. One LLM orchestration contract

There must be one finance orchestration prompt/schema, not independent command and conversation schemas.

The model input must contain only bounded, relevant structured context.

The model output must be schema-constrained.

The orchestrator is allowed to understand:

- create/query/summarize/analyze/compare/update/delete/restore
- context inheritance
- reference language
- presentation changes
- topic switches
- natural date language
- clarification requirements

The orchestrator is not allowed to:

- invent DB IDs
- claim a mutation succeeded
- directly decide that multiple real DB candidates are unique
- compute financial totals from memory when DB execution is available
- bypass executor safety

If orchestration fails or returns invalid output:

- non-destructive request may return a safe retry/fallback message
- mutation request must fail closed
- mutation request must never fall into a second AI parser that might execute a different interpretation

---

## 8. Deterministic executor

The executor must be model-agnostic.

Responsibilities:

- resolve plan filters against D1
- resolve real transaction IDs
- validate categories/accounts
- exact money math in fen
- enforce requested scope and count
- execute create/update/delete/restore atomically
- read receipt items
- calculate summaries/analysis inputs
- stable sorting and pagination
- emit typed `FinanceResult`

The executor must be callable from Telegram, API, tests, and future clients without any channel-specific business logic.

---

## 9. Safety policy

Safety is a dedicated deterministic policy layer, not scattered branches.

### 9.1 Mutations

For update/delete:

- if user semantics require one record but code resolves >1 candidate: reject and ask for clarification
- if explicit multi-selection is present: enforce exact bounded selection
- never let the model's confidence override real candidate ambiguity
- never infer a destructive target solely because it is the latest DB row unless the interpreted plan explicitly references latest/recent semantics

### 9.2 Restore

Restore must reference real prior delete audit/history. It must not recreate a guessed transaction.

### 9.3 Atomicity

All multi-row mutations and audit writes must be all-or-nothing.

### 9.4 Idempotency

All externally delivered turns must have a durable idempotency key, not only create requests.

A replayed update/delete/restore turn must not apply the same mutation twice.

### 9.5 Fail closed

If model, DB, or policy validation fails during a mutation, no mutation is applied and no secondary parser is attempted.

---

## 10. Unified result model

Executor output should be typed before rendering.

```ts
interface FinanceResult {
  operation: FinanceOperation;
  status: 'applied' | 'rejected' | 'clarification' | 'no_match' | 'success';
  transaction_ids: string[];
  rows?: FinanceResultRow[];
  summary?: FinanceSummary;
  pagination?: FinancePagination;
  analysis_input?: FinanceAnalysisData;
  audit_ids?: string[];
  state_patch?: SessionStatePatch;
}
```

The renderer must not re-query or reinterpret user intent.

---

## 11. Rendering strategy

Rendering should be deterministic by default for factual outputs.

Examples:

- ledger rows
- totals
- before/after mutation confirmations
- pagination
- dates

An LLM may generate prose for analysis/recommendations only from structured `FinanceResult` data. It must never invent amounts or causes.

Presentation fields from `FinancePlan` must map directly to renderer output.

---

## 12. Receipt integration

Receipt processing must join the same reference model after OCR/provider resolution.

After receipt creation:

- created parent transaction ID is written to session references
- item IDs are referenceable
- follow-ups such as `第二项改成日用品`, `这张小票撤销`, `刚才超市那笔金额不对` must use the same orchestrator + executor path

Receipt extraction itself can remain a specialized pipeline; post-extraction finance semantics must not remain a separate conversational island.

---

## 13. API and Telegram adapters

Adapters may handle:

- authentication
- webhook validation
- message extraction
- Telegram sending
- HTTP response encoding

Adapters must not contain finance intent logic.

Both must call the same finance core.

---

## 14. Existing code disposition

This blueprint does not require deleting old files on day one. It defines the final ownership model.

### Keep / evolve

- finance reference catalog and category/account resolvers
- transaction D1 schema
- transaction_items
- ledger_operations, possibly extended
- Telegram event-time utilities
- receipt extraction/resolution pipeline
- deterministic DB query helpers where reusable

### Replace / absorb into V2

- Finance Command Layer as an independent NLP authority
- Finance Conversation Layer as an independent NLP authority
- deterministic `parseFinanceTextQuery` as a semantic authority
- legacy Telegram finance interpretation fallback

### Temporary compatibility only

Old parsers may exist behind a compatibility adapter during migration, but production finance traffic must have one clearly measurable primary path and no mutation fall-through.

---

## 15. Migration strategy

Do not big-bang replace production.

### Phase A - Architecture freeze

- finalize this blueprint
- no product code changes
- enumerate every current finance entry path
- map current tests to V2 behavior

### Phase B - V2 core in isolated branch

Implement:

- FinanceTurn
- FinancePlan / PlanPatch schema
- Orchestrator
- session store
- reference resolver
- safety policy
- executor
- result model
- renderer

No production route switch yet.

### Phase C - Compatibility tests

Run existing create/query/conversation/receipt behavior through V2 and compare with current production semantics.

### Phase D - Shadow mode

For production Telegram text requests:

- V1 continues to answer/execute
- V2 interprets read-only in shadow mode
- no V2 mutation
- compare route/plan/result metadata
- redact sensitive values from logs

Mutation shadow mode may interpret and resolve candidates but must not write.

### Phase E - Canary

Enable V2 for a controlled finance subset / user scope.

### Phase F - full cutover

V2 becomes the only finance natural-language path.

### Phase G - remove semantic duplicates

Delete or demote legacy NLP paths only after cutover evidence.

---

## 16. Rollback design

Rollback must be possible without reversing ledger data.

- V2 schema migrations should be additive before cutover.
- V1 data tables remain readable during migration.
- feature flag / route flag can return finance traffic to V1 before V1 semantic code is removed.
- no migration should destructively rewrite transactions just to support V2.

---

## 17. Required acceptance matrix

V2 is not complete when a list of isolated sentences passes. It is complete only after full dialogue scenarios pass.

### 17.1 Single-turn baseline

- create one
- create multiple
- query
- summary
- analysis
- compare
- update
- delete
- restore
- receipt creation

### 17.2 Multi-turn query refinement

Required scenario:

```text
把上周六到今天的财务支出详细列出来
→ 要求带日期，支出项
→ 只看餐饮
→ 金额大的放前面
→ 下一页
→ 这些一共多少
```

Must retain one coherent task state.

### 17.3 Cross-operation continuity

```text
本月支出明细
→ 只看烟酒
→ 第二笔改成支付宝
→ 撤销刚才这个修改
```

### 17.4 Topic switch and return

```text
本月支出明细
→ 只看烟酒
→ 午饭25元
→ 那刚才烟酒一共多少
```

The system must distinguish a new create operation from the previously active query and still preserve an appropriate reference to the prior query.

### 17.5 Reference language

Cover at least:

- 这笔
- 那笔
- 上一笔
- 刚才两笔
- 第二笔
- 这些
- 上面那些
- 刚才删掉的
- 这张小票
- 第二项

### 17.6 Ambiguity

- multiple historical matches
- model says singular but DB finds multiple
- explicit two-record mutation
- latest unrelated record must never be selected as an accidental fallback

### 17.7 Presentation

- date on/off
- selected fields
- sort ascending/descending
- page next/previous/specific
- grouped result
- compact/full

### 17.8 Idempotency and ordering

- duplicated Telegram update for every mutation type
- delayed older turn arriving after newer turn
- concurrent messages
- retry after timeout

### 17.9 Failure injection

- LLM timeout
- malformed model JSON
- D1 read failure
- D1 write failure
- second statement in batch failure
- audit insert failure
- renderer failure after successful mutation

Mutation state must remain correct and observable.

### 17.10 Time semantics

- Telegram delayed delivery
- midnight boundary
- timezone
- relative date phrases
- explicit historical date

### 17.11 Large result behavior

- >10 rows
- >100 rows summary
- stable pagination
- follow-up against current page vs full filtered set must be semantically explicit

### 17.12 Receipt follow-up

```text
[receipt]
→ 第二项改成日用品
→ 这张小票一共多少
→ 撤销这张小票
→ 恢复刚才那张
```

---

## 18. Test architecture

Add dedicated V2 suites instead of relying only on old isolated tests.

Recommended groups:

- `finance-orchestrator-schema.test.ts`
- `finance-session.test.ts`
- `finance-reference-resolution.test.ts`
- `finance-safety-policy.test.ts`
- `finance-executor.test.ts`
- `finance-dialogue-e2e.test.ts`
- `finance-telegram-e2e.test.ts`
- `finance-shadow-comparison.test.ts`

The dialogue E2E suite must run whole conversations with shared session state, not reset state between each sentence.

Real Workers AI acceptance must include dialogue sequences, not only route matrices.

---

## 19. Architecture guard tests

Add tests/lint-like checks that make architectural regression visible.

At minimum:

- production Telegram finance path invokes one orchestrator only
- no destructive finance path invokes a second AI parser after orchestration
- adapters contain no regex intent routing
- all mutation execution goes through one safety policy
- all finance mutations use common idempotency handling

These tests protect the architecture itself, not only feature output.

---

## 20. Observability

Need structured, privacy-conscious trace metadata:

- turn_id
- orchestrator action
- new_plan vs patch_plan
- session version before/after
- result status
- resolved target count
- mutation count
- audit IDs
- model call count
- fallback/failure reason

Do not log raw secrets. Avoid logging full sensitive finance text unless explicitly needed for temporary controlled debugging.

Model call count should be measurable so regressions such as duplicate parsing are detectable in production.

---

## 21. Performance and cost

The architecture should prefer one orchestration model call per text turn.

Possible exceptions:

- analysis prose generation after deterministic statistics
- receipt extraction remains specialized

Do not call multiple LLM routers sequentially.

Context passed to the model must be bounded and structured rather than dumping long conversation transcripts.

---

## 22. Definition of done

V2 cannot be called complete until all are true:

1. One LLM natural-language authority in production finance path.
2. One structured plan protocol.
3. Durable multi-turn session state.
4. Deterministic executor and centralized safety policy.
5. Unified idempotency across create/update/delete/restore.
6. Receipt follow-ups use same reference model.
7. Old semantic routers are removed from production path or explicitly compatibility-only with no authority.
8. Whole-dialogue acceptance matrix passes with real Workers AI + isolated D1.
9. Shadow comparison has no unexplained high-risk divergence.
10. Production canary passes.
11. Real Telegram multi-turn scenarios pass.
12. Rollback path is verified.
13. Architecture guard tests pass.

Passing single-sentence tests is explicitly insufficient.

---

## 23. Scope discipline after V2

After V2 cutover, normal feature additions should fit one of these extension points:

- add fields/operators to FinancePlan
- add deterministic executor capability
- add renderer capability
- add analysis capability based on FinanceResult
- add adapter/channel

A request that appears to require a new parallel NLP layer is a signal to stop and review the architecture, not to immediately add one.

---

## 24. Immediate next step

Before any implementation:

1. Hermes audits current `main` against this blueprint.
2. Produce a path-by-path inventory of all finance entry points and fallbacks.
3. Mark every current component as `reuse`, `adapt`, `compatibility-only`, or `remove-after-cutover`.
4. Identify migration constraints and production rollout risks.
5. Return contradictions or missing cases to ChatGPT.
6. No product code changes during this audit.

Only after this architecture audit is accepted should implementation begin.
