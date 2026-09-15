# Finance V3 Read Agent

## Purpose

Finance V3 replaces the fragile read-side pattern of “LLM emits one large FinancePlan and the executor tries to interpret it” with a constrained read agent that selects deterministic finance tools.

The production V2 write path remains unchanged. V3 is read-only until it passes shadow benchmarks against direct SQL truth.

## Design sources

The design follows patterns used by mature personal-finance products and assistants:

- LLM for intent/tool selection, deterministic code for filters, dates, aggregation and arithmetic.
- Explicit result-set context for follow-up phrases such as “这些记录 / 刚才那些”.
- Read and write capabilities separated; writes remain behind the existing audited V2 mutation path.
- Explicit search is a dedicated tool rather than an accidental text filter.
- Ambiguous requests should clarify instead of inventing missing facts.

## Architecture

```text
Natural language
    ↓
Finance V3 Read Agent (semantic authority)
    ↓
ReadToolCall[]
    ↓
Schema validation + Read Tool Auditor
    ↓
Deterministic read tools
    ↓
D1 ledger / explicit result set
    ↓
Structured facts
    ↓
Renderer / answer layer
```

The model never computes dates, totals, shares, extrema or SQL. It selects a tool and supplies semantic arguments such as `last_month`, `expense`, `category`, `active_result_set`.

## Initial tool set

1. `find_transactions` — deterministic filtering, ordering and bounded detail retrieval.
2. `summarize_transactions` — full-set count/expense/income/net aggregation.
3. `group_transactions` — group by category/date/account/merchant with deterministic aggregation.
4. `get_extrema` — earliest/latest or minimum/maximum amount.
5. `compare_periods` — deterministic period-vs-period summaries and deltas.
6. `search_transactions` — explicit keyword search only; requires `explicit_search=true`.
7. `describe_result_set` — facts about a previous result set: count, earliest/latest date, totals, min/max amount.
8. `get_transaction` — one transaction by id.

## Context model

The agent receives explicit context:

- `event_time`
- `session_key`
- `active_result_set_id`
- `previous_result_set_id` when available

For “这些记录开始日期是几号”, the expected call is conceptually:

```json
{
  "tool": "describe_result_set",
  "source": { "kind": "active_result_set" }
}
```

The deterministic tool returns `earliest_date`; no LLM date sorting is allowed.

## Relative time

The agent may select only stable presets:

- `today`
- `yesterday`
- `this_month`
- `this_month_to_date`
- `last_month`
- `this_year`
- `last_year`

Code resolves presets from the message `event_time` in Asia/Shanghai. The model does not generate calendar boundaries for these presets.

## Search separation

Ordinary semantic words such as “消费”, “支出”, “收入”, “哪一类” can never become a full-text predicate.

Only `search_transactions` may issue text `LIKE` matching, and the auditor requires:

```text
explicit_search = true
query != empty
```

This prevents the V2 failure where `semantic_text="消费支出"` filtered a valid month to zero rows.

## Aggregate separation

Detail limits never control aggregate truth.

- detail retrieval is bounded for presentation;
- summaries/groups/comparisons query the full matching ledger set;
- result-set operations use the exact persisted result-set membership.

This prevents the prior 200-row truncation class of bugs.

## Rollout

### Phase A — branch-only kernel

Implement protocol, deterministic tools, auditor and benchmark tests. No production routing changes.

### Phase B — benchmark

Run V2 and V3 against direct SQL truth on generated and curated cases:

- relative dates and cross-year boundaries;
- summaries and grouping;
- earliest/latest/min/max;
- explicit keyword search vs ordinary intent words;
- >200 ledger rows;
- active-result-set follow-ups;
- paraphrase equivalence;
- multi-turn reference chains.

### Phase C — shadow

Execute V3 read decisions without user-visible delivery. Compare structured facts with V2 and SQL truth.

### Phase D — canary

Route a small read-only share to V3. All mutations remain V2.

### Phase E — read cutover

Only after benchmark and shadow acceptance. V2 mutation architecture remains authoritative for create/update/delete/restore/receipt.

## Acceptance gates

V3 must not be promoted merely because one screenshot is fixed. Required gates:

- all deterministic unit/property matrices pass;
- no aggregate derives from a presentation limit;
- explicit-search gate cannot be bypassed;
- result-set follow-up tests cover earliest/latest/max/min and re-ordering;
- cross-year date boundaries pass;
- benchmark compares V3 facts to direct SQL truth;
- no production transaction mutations occur during read benchmarks;
- production routing remains unchanged until explicit approval.
