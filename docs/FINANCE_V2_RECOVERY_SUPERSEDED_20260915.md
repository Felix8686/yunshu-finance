# Finance V2 Recovery Supersession Notice

Effective date: 2026-09-15
Status: SUPERSEDED

## Superseded work

The previously unfinished Finance V2 recovery task is no longer an active development task. It included continuing the V2 read-side recovery/acceptance path around the original zero-result failure, Telegram end-to-end acceptance, and further V2 query hardening.

Do not resume that task automatically.

The following work is explicitly stopped unless the user later re-authorizes it:

- additional Finance V2 read-side prompt/plan patches for ordinary query understanding;
- further one-off fixes for V2 follow-up/reference questions;
- continuing the original “0 yuan” query recovery task as a blocking project;
- adding more V2 special-case query rules merely to close individual screenshots;
- D1 display-name cleanup, R2/Queue renaming, or unrelated historical-ledger audits as part of that recovery task.

## Why it is superseded

The project has moved to Finance V3 Read Agent. V3 uses an LLM for semantic/tool selection and deterministic read tools for date resolution, filtering, aggregation, grouping, extrema, result-set follow-ups, and explicit keyword search. The V2 mutation path remains authoritative for writes.

Active development now lives on:

- branch: `feat/finance-v3-read-agent`
- Draft PR: #7
- design: `docs/FINANCE_V3_READ_AGENT.md`
- benchmark gate: `docs/FINANCE_V3_BENCHMARK.md`

## What is preserved

This supersession does not roll back or invalidate completed production work. Preserve the current production Worker, existing D1 resources and UUIDs, merged PRs, deployed Finance V2 state, and historical transactions.

Do not modify production data merely to make V2 acceptance fixtures match.

## Telegram infrastructure

The Yunshu Telegram Bot token/webhook issue is not discarded; it is reclassified as shared production infrastructure rather than a Finance V2 recovery task.

Do not continue token/webhook recovery now as part of the old task. Resume it only when Finance V3 reaches the production-integration gate and explicit authorization is given. At that time, reuse the existing Yunshu Bot; do not create another Bot unless the user explicitly requests it.

Hermes Bot polling remains separate and must not be modified as part of this supersession.

## Agent handoff rule

If Codex, Hermes, or another agent encounters an older handoff/runbook that asks it to continue the superseded Finance V2 recovery task, it must stop that task and treat this notice plus PR #7 as the current source of direction.

Do not merge PR #7 or deploy Finance V3 without an explicit later instruction.
