# Finance Orchestrator V2 Rev4 独立架构复审

复审日期：2026-09-07（Asia/Singapore）
复审分支：`codex/finance-orchestrator-v2-rev4-closeout`
复审基线：`origin/refactor/finance-orchestrator-v2-blueprint` @ `3e277e4fd077b054655a8427bc811881d73f6415`
生产基线：`main` / `origin/main` @ `b707ddb8a5c627ceb0677c1677e9c4b59005fe19`

## 结论

**BLUEPRINT_READY**。

本轮没有发现仍然阻断架构冻结的 CRITICAL/HIGH 问题。Rev4 的三个原阻断面已在规范、协议 Schema 和迁移 Runbook 中同步闭合：当前运行时 epoch/mode 围栏、显式重放投递身份、以及 D1 容量前置条件。

这个结论只表示“可以进入后续 Phase 1 实现评审”，不表示 V2 产品代码已经实现，也不表示 0008/0009 已在生产执行或线上 V2 已可用。按照交接边界，本轮在架构复审通过后停止，不修改 `main`、不部署、不写远程 D1/R2/Queue。

## 后续实现状态更正（2026-09-08）

上面的结论是 2026-09-07 架构复审时的历史状态。复审通过后，隔离分支 `codex/finance-orchestrator-v2-rev4-closeout` 已完成本地实现检查点 `06faf21`：

- 0008/0009 已纳入分支并通过本地 D1 migrations 验证；
- FinanceTurn、FinancePlan/PlanPatch、统一 Orchestrator、fenced Executor、ResultSet/分页、FinanceResult、Renderer、Outbox 和 receipt V3 已接入 `src/app.ts`；
- API structured 路径已通过本地 HTTP 验证，Telegram webhook 的 owner 鉴权、倒序 update 拒绝和 168 小时 epoch reset 已通过本地验证；
- `npm run typecheck`、`npm test`、本地迁移检查和 `wrangler deploy --dry-run` 已通过；
- 以上均是隔离、本地或 dry-run 证据，不代表生产已迁移、部署或切换。

## 已闭合问题

### 1. 当前运行时 route fence

- 每个受保护的 mutation、receipt artifact/provider completion、outbox claim/terminal update 都必须读取当前 `finance_runtime_control`，同时满足 operation/outbox lease、存储的 route epoch、当前 `config_epoch` 和操作类型允许的 route mode。
- 进入 `draining_*` 会递增 `config_epoch`；旧 Worker 的 side-effect 与 terminal update 都是 typed stale fence / rollout interrupted no-op。
- 可重试的旧 outbox 行只有在 `enabled|draining` 下重新 claim 时才会原子重绑到当前 epoch；旧 epoch 的 in-flight sender 仍然被围栏，`unknown` 不会自动重发。

### 2. 显式 replay 与 outbox 身份

- `delivery_request_id` 将一次用户可见投递与不可变 `FinanceResult` 分离。
- 初始投递和显式 replay 使用不同的确定性 request ID；唯一性改为 `(ledger_scope_id, delivery_request_id, part_index)`。
- 重复同一 replay turn/idempotency key 解析到原 request，不新增行；历史 `accepted`/`unknown` 不被编辑或删除。
- outbox 不再接受 `provider_response_json` 或第二份消息正文，只保留类型化投递证据。

### 3. 协议与 ResultSet 不变量

- `FinanceSuccessResult` 使用两个完整 `oneOf` 分支：mutation 必须是 `commit_status=committed`，read operation 必须是 `commit_status=not_required`。
- `resultset-canonical-v1` 明确由运行时统一计算 UTF-8 row/snapshot bytes、row count 和 1..N ordinals；Schema 的声明值不可信，重算不一致即拒绝。
- 0009 保留 `original_transaction_id`，同时以可空 live `transaction_id` 支持删除后的 FK 证据保留。

### 4. D1 容量门禁

Rev4 明确要求部署账户为 **Workers Paid**。Cloudflare 官方文档当前记载 D1 每次 Worker invocation 为 Paid 1000 条查询、Free 50 条；Free 不能承载本设计声明的最坏原子边界。Runbook 要求预检读取并记录账户方案，非 Paid 直接 fail closed，不得在部署时静默降低产品边界。

## 独立验证证据

只读/隔离验证脚本：
`D:\Codex Projects\Files\wanxiang-rev4-closeout-evidence\contract_closeout_experiment.py`

本地结果摘要：

- stale mutation：`0` 行；fresh mutation：`1` 行；
- stale outbox terminal：`0` 行；post-transition pending claim：`1` 行并重绑到 epoch `2`；
- initial/replay 重复插入均被拒绝；同一 result 的历史 request 行数为 `2`；
- mutation/read 的 FinanceSuccessResult 合法组合分别为 `committed` / `not_required`；交叉组合拒绝；
- forged UTF-8 bytes 不接受；实际样例 `40` bytes，伪造值 `41`；
- 0008 SQL block 可在 SQLite 隔离库执行，outbox 含 `delivery_request_id`/`route_epoch` 且不含 raw provider response；
- 0009 SQL block 可执行；删除 transaction 后 `original_transaction_id='tx-delete-1'` 保留，live `transaction_id=NULL`。

文档门禁：

- Protocol Schema JSON parse：PASS；
- JSON Schema Draft 2020-12 meta-schema check：PASS；
- `git diff --check`：PASS（仅有 Git 的 LF/CRLF 提示）；
- 本分支只修改/新增架构文档，不包含产品代码、生产配置或密钥。

## 尚未完成、因此不能宣称“生产整个系统已可用”

1. 当前生产基线和远程资源仍未切换；0008/0009 尚未写入生产 D1，V2 Worker 尚未部署。
2. Workers Paid 账户、远程 D1/R2/Queue 绑定、生产 secret、实际 Telegram 用户可见消息和 receipt provider E2E 尚未验证。
3. 完整对话矩阵、并发/故障注入、shadow structural comparison、canary/cutover、rollback/re-enable 证据尚未完成。
4. legacy finance semantic paths 仍保留为 compatibility 路径，尚未达到删除或永久隔离的 cutover gate。

可执行的本地/上线前步骤见 `docs/FINANCE_ORCHESTRATOR_V2_IMPLEMENTATION_RUNBOOK_20260907.md`；生产迁移和切换仍须遵守 `docs/FINANCE_ORCHESTRATOR_V2_MIGRATION_RUNBOOK_REV4.md`。

## 官方容量/语义来源

- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)

联网核验的独立 HTML 记录：
`D:\Codex Projects\Files\wanxiang-cloudflare-capacity-verification-20260907.html`
