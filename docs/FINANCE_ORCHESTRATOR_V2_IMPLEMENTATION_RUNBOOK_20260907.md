# Finance Orchestrator V2 实现运行手册（2026-09-07）

本文件描述当前隔离分支的实现、验证和上线前门槛。它不是生产切换授权，也不替代 `FINANCE_ORCHESTRATOR_V2_MIGRATION_RUNBOOK_REV4.md`。

## 当前实现边界

- V2 入口：`src/app.ts` 的 Telegram webhook、`/v2/finance` API 和 receipt Queue consumer。
- 统一写入核心：`src/finance-v2/executor.ts`；receipt V3 只负责提取、校验和构造 `receipt_create` 计划。
- 持久化：0008 创建 V2 状态表，0009 保留 fidelity recovery 的原始交易身份。
- 投递：FinanceResult 先提交，Telegram 发送由 `finance_outbox` 和现有 `RECEIPT_QUEUE` 上的 `finance_outbox_dispatch` 投递泵独立完成；当前账户的 Cron 配额不可用，不得把 Cron 当作投递证据。
- 当前代码已部署到 `wanxiang-cloud-dev`，运行控制已进入 owner-only 的 `shadow_v2 / interpretation_only`；尚未进入 V2 mutation canary 或 `primary_v2`。
- `shadow_v2` 的结构差异只能写入独立 `SHADOW_DB`；没有该绑定时不得把 shadow telemetry 写入主 `DB`。
- 独立 shadow 数据库使用 `shadow-migrations/0001_shadow_comparisons.sql`，只保存哈希、操作类别、时间范围类别、presentation 类别、差异码、调用次数和延迟。

## 2026-09-08 远程复核记录

以下是本轮复核时的只读/受控证据；时间均为 UTC，不能把部署版本、路由启用和端到端成功混为一谈：

- 本地 `npm run check`：PASS；包含 typecheck、架构守卫、legacy 测试和完整 Finance V2 测试。
- 主 D1 `wanxiang-cloud-dev`：`d1_migrations` 已读回 0001-0009，0008/0009 无待应用；本轮复核未向主库写入业务数据。
- Shadow D1：`finance_shadow_comparisons` 表及索引存在；远程 `d1_migrations` 行数为 0，说明该库的 0001 是以直接 SQL 方式落地，不能据此宣称 Wrangler migration ledger 完整。
- Shadow 阶段 runtime control 曾为 `config_epoch=2`、`finance_route_mode=shadow_v2`、`shadow_mode=interpretation_only`、`receipt_route_mode=v1`、`outbox_mode=paused`；通过新的 shadow 样本后，已按 CAS 进入当前 `config_epoch=3` 的 `canary_v2 / shadow_mode=off / receipt=v1 / outbox=enabled`。
- Worker：原始 shadow 运行版本为 `61cf6c48-d765-460d-b4f6-fab008d8349d`；本轮修复后代码部署版本为 `b8854a3e-d2a4-4c93-815b-41902fa23696`。此前的 Secret Change 版本不计作代码部署。
- `/health`：HTTP 200，版本 0.7.0，D1/R2/Queue/Veryfi 绑定和 Veryfi 配置均报告可用；Queue provider 读回 `wanxiang-receipt-dev` 有 1 个 producer 和 1 个 consumer，均属于该 Worker。
- 用户只读查询样本（`2026-09-08T11:21:11.199Z`）：V1 实际路由为 `command/query`；V2 只完成一次解释尝试，但结果为 `error/schema_invalid`，差异码为 `operation_class_mismatch` 与 `v2_schema_invalid`，调用次数 1、延迟约 12 秒。SHADOW_DB 只保存了这些脱敏结构字段，没有保存文本、金额或账目身份。
- 该样本对应的主库最近 30 分钟 `finance_turns`、`finance_operations`、`finance_outbox`、`finance_receipt_jobs`、`finance_receipt_provider_attempts` 和 `transactions` 均为 0；当前账本总行数为 4497。它证明了 V1 查询没有新增账目，也不构成 V2 shadow acceptance。
- 针对失败原因，Worker 已改为向真实模型提交 plan-only JSON Schema，并收紧 temporal/filter/presentation/reference 结构，同时把 Telegram `event_time` 的本地日期明确注入提示；本地全套检查和不写库的真实模型探针均通过。修复版本的新 owner 只读查询已确认 shadow structural comparison 通过。

当前阶段的安全边界：canary 只开放 owner 身份；所有账目测试必须使用明显的测试标记，随后按 transaction、item、operation、result、turn、session、outbox 和 receipt 关系逐项读回并清理。当前 canary 前基线为 operations=0、outbox=0、账本总行数=4497。

## 必需配置

Worker 运行前必须提供：

- `TELEGRAM_BOT_TOKEN`：Outbox 发送 Telegram 消息；
- `TELEGRAM_WEBHOOK_SECRET`：Telegram webhook 入口鉴权；
- `TELEGRAM_OWNER_USER_ID`：唯一允许使用 V2 的 Telegram 用户；
- `TELEGRAM_OWNER_CHAT_ID`：唯一允许投递的 Telegram chat；
- `TELEGRAM_OWNER_CHAT_TYPE`：可选，建议个人账本设置为 `private`；
- `API_BEARER_TOKEN` 或 `WANXIANG_API_KEY`：结构化 API 鉴权；
- `FINANCE_RUNTIME_CONTROL_TOKEN`：runtime route transition 管理接口鉴权；
- `FINANCE_PAGE_TOKEN_SECRET`：ResultSet 分页 token 的 HMAC 密钥；
- Veryfi/receipt provider 所需的 provider secret。

`FINANCE_RUNTIME_CONTROL_TOKEN`、`FINANCE_PAGE_TOKEN_SECRET`、Telegram token、webhook secret、API token 和 provider secret 不得写入 `wrangler.jsonc` 或提交到 Git。

## 本地验证顺序

在隔离工作树中执行：

```text
npm ci
npm run typecheck
npm run check:architecture
npm test
npx wrangler d1 migrations apply wanxiang-cloud-dev --local
```

当前分支的本地收口验收还包括 `npm run test:finance-v2`；其中包含完整 dialogue matrix、并发/CAS、fault-injection、migration fresh/upgrade 和 Node SQLite D1 in-memory E2E 测试。`npm run check` 是提交前的合并门禁。

运行本地 Worker 时，为本地进程注入测试用 bearer token、owner 身份和 page-token secret；不要复用生产 secret。然后按顺序验证：

1. `GET /health` 和 `GET /v2/finance/runtime`；
2. API structured create/query/summarize；
3. HMAC page token 的下一页和篡改 token；
4. update/delete/restore 的 ResultSet fingerprint 和 cardinality fence；
5. 同一 request 的 duplicate replay，以及显式 replay 的新 outbox delivery identity；
6. `plan_patch` 的 `replace/clear` 和 stale plan CAS；
7. Telegram webhook owner auth、倒序 update rejection、168 小时 epoch reset；
8. outbox 无 token 的 retryable 状态、cron dispatch 和 Telegram token 配置后的 accepted 状态；
9. `draining_v1|draining_v2` 下新文字请求和新照片入队均返回维护响应，不进入旧处理器或新处理器；
10. receipt provider、artifact、receipt_create、audit、outbox 的完整链路。

## 生产切换前不可跳过的证据

- 在 fresh DB、0001-0007 upgrade DB 和生产规模隔离副本上重新执行 0008/0009 验证；
- 确认 Cloudflare 账户为 Workers Paid，并记录 D1/Queue/R2 绑定和容量预检；
- 先部署带 V2 代码但保持 `primary_v1`、`receipt_route_mode=v1`、`outbox_mode=paused`；
- 只在 runtime control、migration、old Worker/Queue compatibility 和 rollback evidence 全部通过后进入 `shadow_v2`；
- `shadow_v2` 只能解释和记录脱敏结构差异，不能写生产 session、ledger、receipt 或 outbox；
- canary 只开放 owner 身份，验证 D1 commit、ResultSet、Outbox accepted/unknown/retryable 和真实 Telegram 消息；
- 每个阶段保存 control epoch、operation/turn/result/outbox/receipt 状态快照；
- 只有完整对话矩阵、故障注入、回滚/恢复、真实 Telegram E2E、Queue 投递证据和账户容量门禁通过后，才允许 `primary_v2`；当前 Workers Free/Cron 配额限制仍未满足文档要求的 Paid 容量门禁。

## 回滚原则

回滚优先切换 route mode 和递增 `config_epoch`，不反向删除已提交的用户账目。旧 Worker 不得接管 V2 正在执行的操作；必须先观察 stale fence、in-flight operation、pending/unknown outbox 和 receipt job 是否达到 runbook 的成功信号，再决定重试或补偿。
