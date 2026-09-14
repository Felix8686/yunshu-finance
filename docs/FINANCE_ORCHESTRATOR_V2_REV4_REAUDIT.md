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

## 本地实现收口（2026-09-08）

在上述实现检查点之后，本分支继续完成了本地代码和验收缺口的收口：

- 新增统一容量门禁：create/receipt item、mutation target、D1 batch、ResultSet、FinanceResult、Telegram render payload 和重试次数均 fail closed；
- 补齐 TurnContextSnapshot 的持久化/哈希校验、receipt artifact/envelope 的类型化边界，以及 operation/receipt/outbox 的 route/config/lease fence；
- shadow 只使用独立 `SHADOW_DB`，只记录脱敏 structural telemetry；V2 主路径不再把 shadow 解释失败落回 legacy semantic authority；
- 新增完整 dialogue matrix：create、query、summarize、analyze、compare、update、delete、restore、receipt_create，以及 plan patch、clarification、non-finance 和 receipt operation fidelity；
- 新增 fault-injection 验收：route witness 失效、draining 阻断、render payload 篡改、D1 batch 超限和 runtime config epoch race；
- 新增 SQLite D1 并发验收：同一请求并发只保留一个 turn，重复调用收敛到同一幂等记录，session projection 的 CAS 只允许一个版本推进；
- runtime control 不可读时，Telegram 入口返回维护响应，Queue 消息只 retry、不默认回落到 V1；
- 补齐 V1 compatibility-interrupted 会话隔离：旧语义路径写入标记，V2 恢复时清空旧 plan/ResultSet 窗口，`draining_v2` 对文字请求和 `draining_*` 对新照片入队均 fail closed，不再回落到 legacy semantic path；
- 新增 Node SQLite D1 适配的 migration fresh/upgrade、HTTP 204、structured API、outbox replay、delete/restore evidence 和 draining webhook 端到端验收；
- `npm run typecheck`：PASS；`npm run check:architecture`：PASS；`npm run check`：PASS；`git diff --check`：PASS（仅 Git 的 LF/CRLF 提示）；
- 本地 D1 migration readback：`wanxiang-cloud-dev` 无待应用 migration；本次未执行任何 remote migration/deploy/write。

## 已闭合问题

### 0. Luna 实现追加复核（2026-09-08）

对实现代码逐项复核后发现并修复了四项会影响实际可用性的缺陷：

- D1 batch 原先在提交后才检查零行 CAS，冲突时可能账目已写入却返回失败；现在每条写入后在同一事务内断言，任何 fence/CAS 失败都会回滚整批写入，并有故障注入测试证明账目未残留；
- API payload hash 原先未完整覆盖 structured plan/patch 和 session，复用请求 ID 时可能错误返回旧结果；现在使用规范化完整请求计算哈希，计划、补丁或会话变化都会触发幂等冲突；
- update/delete 原先只依赖 operation/session fence，不足以阻止不同会话同时修改同一账目；现在提交时复核查询阶段看到的交易及商品明细，过期请求不能覆盖较新的写入；
- receipt V3 在账本已提交但 job terminal update 被 route epoch 切换阻断时，可能长期停在 processing；现在重试会从已提交 operation 对账并收口为 committed，旧 epoch 的 processing job 也会安全回到 queued/artifact_ready 后重试。

追加回归测试、`npm run check`、`git diff --check` 和 `wrangler deploy --dry-run` 均通过。上述仍是本地和 dry-run 证据。

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
- 本分支的实现收口包含产品代码和测试变更；不包含生产 secret，也未执行生产配置、迁移或部署写入。

## 2026-09-08 远程部署与运行状态复审

本节覆盖架构复审之后的授权执行，不修改原有 Rev4 结论：

- 主 D1 已读回 0001-0009，0008/0009 无待应用；独立 shadow D1 的比较表和索引存在，已保存 2 条真实脱敏结构比对记录，其中最新一条通过、首条失败。
- Worker 原 shadow 代码版本为 `61cf6c48-d765-460d-b4f6-fab008d8349d`；修复后代码部署版本为 `b8854a3e-d2a4-4c93-815b-41902fa23696`；Secret Change 版本不等同于代码部署。
- `/health` 返回 HTTP 200 / version 0.7.0，并报告 D1、R2、Queue、Veryfi 和 Veryfi 配置可用；真实 Queue `wanxiang-receipt-dev` 读回 1 producer/1 consumer。
- Runtime control 已从 epoch 1 进入 epoch 2 的 shadow 阶段，并在 shadow 通过后经 CAS 进入当前 epoch 3：`canary_v2 / shadow_mode=off`，receipt `v1`，outbox `enabled`。当前没有主库 operation、outbox 或 receipt job 业务行；canary 前账本总行数为 4497。
- 本地 `npm run check` 仍为 PASS；本轮没有提交或合并任何代码。

本轮两条 owner 只读查询的 shadow 结果为：首条 V1=`command/query`、V2=`error`、`schema_valid=0`；第二条 V1=`command/query`、V2=`query`、`schema_valid=1`、时间范围存在、presentation=`details`、差异码为空；模型调用均为 1 次，第二条约 22.2 秒。两条 V1 查询均未新增账目。

## 尚未完成、因此不能宣称“生产整个系统已可用”

1. Shadow structural comparison 已有通过样本；当前需要 owner 发送带明显测试标记的 canary 记账消息，以验证 V2 D1 commit、ResultSet、outbox accepted/retryable/unknown/no-duplicate。
2. 尚无 canary 的真实 D1 commit、ResultSet、outbox accepted/retryable/unknown/no-duplicate 证据；也尚无真实 Telegram 可见的 V2 投递证据。
3. 尚无 receipt V2 的真实 Telegram 图片、Veryfi provider、artifact/envelope、统一 `receipt_create`、outbox 和清理证据，也尚无 V1/V2 receipt drain 的完整双向复核。
4. 尚无一次完整的 semantic rollback、delivery rollback、re-enable 和重复 canary 证据；在这些证据和容量门禁完成前不得切 `primary_v2`。
5. 当前账户为 Workers Free，Cron 配额已耗尽；Queue 投递泵已部署并绑定，但文档要求的 Workers Paid D1 容量门禁仍未满足，长期稳定性不能从当前 canary 推断。
6. legacy finance semantic paths 仍保留为 compatibility 路径；它们不能重新成为 V2 自然语言权威，最终删除/隔离仍是后续 cutover gate。

可执行的本地/上线前步骤见 `docs/FINANCE_ORCHESTRATOR_V2_IMPLEMENTATION_RUNBOOK_20260907.md`；生产迁移和切换仍须遵守 `docs/FINANCE_ORCHESTRATOR_V2_MIGRATION_RUNBOOK_REV4.md`。

## 官方容量/语义来源

- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)

联网核验的独立 HTML 记录：
`D:\Codex Projects\Files\wanxiang-cloudflare-capacity-verification-20260907.html`
