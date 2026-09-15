# Finance V3 Phase B Benchmark

## Purpose

Phase B tests whether the Finance V3 read-agent architecture actually improves natural-language finance querying before any production routing changes.

It deliberately separates three layers:

1. **LLM planning** — can the model choose the correct deterministic read tool and semantic arguments?
2. **Deterministic execution** — does the selected tool return the same facts as direct SQL / stored result-set truth?
3. **V2 baseline** — how often does the current V2 planner express the same intended query correctly on cases that V2 can represent?

The V2 score is informational. V3 is not allowed to ship merely because it beats V2; V3 must meet its own absolute quality gates.

## Corpus

The benchmark corpus covers more than 30 scenarios across:

- last month / month-to-date / yesterday / explicit month boundaries
- total expense summaries
- category grouping and top-category questions
- detail queries
- earliest/latest/largest/smallest-style extrema
- active-result-set follow-ups such as “这些记录开始日期是几号”
- sorting a prior result set
- summarizing and grouping a prior result set
- explicit keyword search
- preventing ordinary intent words such as “消费支出” from turning into full-text search
- period comparison
- clarification when a reference is missing
- non-finance rejection

The fixture intentionally contains more than 200 August expense rows so aggregate truth cannot accidentally depend on presentation limits.

## Real model

`npm run benchmark:finance-v3` uses the same Cloudflare Workers AI model family as the application by default:

`@cf/meta/llama-3.3-70b-instruct-fp8-fast`

It obtains the current Wrangler auth token through `wrangler auth token --json` and calls Workers AI only for semantic planning. The benchmark ledger itself is an in-memory SQLite fixture; production D1 is never queried or modified.

Environment overrides:

- `YUNSHU_BENCHMARK_MODEL`
- `YUNSHU_BENCHMARK_PROXY`
- `CLOUDFLARE_ACCOUNT_ID`
- `YUNSHU_BENCHMARK_OUTPUT` for a JSON report path

No bot token, webhook secret, production D1 write, or production routing change is required.

## Gate

Phase B passes only when all of the following hold in one benchmark run:

- V3 planning accuracy >= 95%
- deterministic V3 result vs SQL/result-set truth = 100%
- all critical regressions pass
- all active-result-set follow-up cases pass
- accidental `search_transactions` calls outside explicit-search cases = 0

The benchmark also reports the V2 planning baseline for representable cases, but V2 performance does not lower the V3 gate.

## Safety boundary

Phase B must not:

- edit `src/app.ts` production routing
- change `finance_runtime_control`
- deploy a Worker
- run migrations
- modify production transactions
- add V3 mutation tools
- replace the V2 write path

Only after the benchmark gate is stable should a later phase add shadow routing and production replay comparisons.
