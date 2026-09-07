# Finance Orchestrator V2 实现运行手册（2026-09-07）

本文件描述当前隔离分支的实现、验证和上线前门槛。它不是生产切换授权，也不替代 `FINANCE_ORCHESTRATOR_V2_MIGRATION_RUNBOOK_REV4.md`。

## 当前实现边界

- V2 入口：`src/app.ts` 的 Telegram webhook、`/v2/finance` API 和 receipt Queue consumer。
- 统一写入核心：`src/finance-v2/executor.ts`；receipt V3 只负责提取、校验和构造 `receipt_create` 计划。
- 持久化：0008 创建 V2 状态表，0009 保留 fidelity recovery 的原始交易身份。
- 投递：FinanceResult 先提交，Telegram 发送由 `finance_outbox` 和 cron 独立完成。
- 当前仍是隔离实现验证；没有执行远程 D1/R2/Queue 写入，没有部署生产 Worker。

## 必需配置

Worker 运行前必须提供：

- `TELEGRAM_BOT_TOKEN`：Outbox 发送 Telegram 消息；
- `TELEGRAM_WEBHOOK_SECRET`：Telegram webhook 入口鉴权；
- `TELEGRAM_OWNER_USER_ID`：唯一允许使用 V2 的 Telegram 用户；
- `TELEGRAM_OWNER_CHAT_ID`：唯一允许投递的 Telegram chat；
- `TELEGRAM_OWNER_CHAT_TYPE`：可选，建议个人账本设置为 `private`；
- `API_BEARER_TOKEN` 或 `WANXIANG_API_KEY`：结构化 API 鉴权；
- `FINANCE_PAGE_TOKEN_SECRET`：ResultSet 分页 token 的 HMAC 密钥；
- Veryfi/receipt provider 所需的 provider secret。

`FINANCE_PAGE_TOKEN_SECRET`、Telegram token、webhook secret、API token 和 provider secret 不得写入 `wrangler.jsonc` 或提交到 Git。

## 本地验证顺序

在隔离工作树中执行：

```text
npm ci
npm run typecheck
npm test
npx wrangler d1 migrations apply wanxiang-cloud-dev --local
```

运行本地 Worker 时，为本地进程注入测试用 bearer token、owner 身份和 page-token secret；不要复用生产 secret。然后按顺序验证：

1. `GET /health` 和 `GET /v2/finance/runtime`；
2. API structured create/query/summarize；
3. HMAC page token 的下一页和篡改 token；
4. update/delete/restore 的 ResultSet fingerprint 和 cardinality fence；
5. 同一 request 的 duplicate replay，以及显式 replay 的新 outbox delivery identity；
6. `plan_patch` 的 `replace/clear` 和 stale plan CAS；
7. Telegram webhook owner auth、倒序 update rejection、168 小时 epoch reset；
8. outbox 无 token 的 retryable 状态、cron dispatch 和 Telegram token 配置后的 accepted 状态；
9. receipt provider、artifact、receipt_create、audit、outbox 的完整链路。

## 生产切换前不可跳过的证据

- 在 fresh DB、0001-0007 upgrade DB 和生产规模隔离副本上重新执行 0008/0009 验证；
- 确认 Cloudflare 账户为 Workers Paid，并记录 D1/Queue/R2 绑定和容量预检；
- 先部署带 V2 代码但保持 `primary_v1`、`receipt_route_mode=v1`、`outbox_mode=paused`；
- 只在 runtime control、migration、old Worker/Queue compatibility 和 rollback evidence 全部通过后进入 `shadow_v2`；
- `shadow_v2` 只能解释和记录脱敏结构差异，不能写生产 session、ledger、receipt 或 outbox；
- canary 只开放 owner 身份，验证 D1 commit、ResultSet、Outbox accepted/unknown/retryable 和真实 Telegram 消息；
- 每个阶段保存 control epoch、operation/turn/result/outbox/receipt 状态快照；
- 只有完整对话矩阵、故障注入、回滚/恢复和真实 Telegram E2E 通过后，才允许 `primary_v2`。

## 回滚原则

回滚优先切换 route mode 和递增 `config_epoch`，不反向删除已提交的用户账目。旧 Worker 不得接管 V2 正在执行的操作；必须先观察 stale fence、in-flight operation、pending/unknown outbox 和 receipt job 是否达到 runbook 的成功信号，再决定重试或补偿。

