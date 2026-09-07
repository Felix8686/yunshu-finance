# Finance Orchestrator V2 Architecture Audit

审计对象：`Felix8686/wanxiang-cloud`

- 当前基线：`main` / `b707ddb8a5c627ceb0677c1677e9c4b59005fe19`
- Blueprint：`refactor/finance-orchestrator-v2-blueprint` / `02c184ca12da7bb4ba86511f5b5ca1f45986ec4e`
- Draft PR：[#11](https://github.com/Felix8686/wanxiang-cloud/pull/11)
- 审计范围：当前 main 的全部 finance、receipt、intake、Telegram webhook、Finance API、Queue 后续链路、0001-0007 migrations、现有相关测试，以及 Blueprint 全文。
- 本轮边界：未修改任何 product code、`src/`、migrations、tests；未部署、未执行 production migration、未写入 production D1/R2/Queue。

## 1. Overall

# NEEDS_REVISION

Blueprint 的方向正确，且一级原则正确：**LLM 是唯一自然语言理解层；Code 是唯一事实、执行、安全、持久化、审计层。** 但它目前仍是“目标架构说明”，尚未成为可以安全实施和回滚的完整协议。若直接按当前 Blueprint 实现，短期内很可能因为 session、result reference、幂等、receipt、outbox、API/Telegram 边界和 rollback 缺口再次发生架构级重构。

### 结论依据

- 当前生产入口不是单一路径：`src/app.ts` 先走 Finance Command AI，再走 Finance Conversation AI，再走确定性 `parseFinanceTextQuery`，最后还可能落到 `src/index.ts` 的 legacy `/v1/intake` + `parseIntake` AI。
- 当前 command/conversation/intake 使用三套不同的 AI schema，analysis 又有一套无 schema 的生成调用；Blueprint 虽然描述“一个 orchestrator”，但未定义足以替换这些能力的完整协议。
- 当前 `finance_chat_context` 只有最近一次范围和文本，无法保存结果集、字段、排序、分页、引用、topic、turn version 或并发顺序。
- 当前 update/delete/restore 的审计、幂等和 receipt 入账不是统一模型；尤其 restore 不按用户引用选择原删除操作，且所有 mutation 并没有共同的 durable idempotency 机制。
- 当前 Queue receipt 直接写 `transactions + transaction_items`，绕过 FinancePlan、统一 executor、统一 `ledger_operations` 和 session reference。
- 当前没有真正的 feature flag、cutover gate、in-flight Queue 版本协议、旧 Worker 对新 schema 的兼容验证或可执行的 migration rollback 设计。

### 证据等级

- **已执行验证**：当前 main `npm run typecheck` PASS、`npm test` PASS、`npx wrangler deploy --dry-run` PASS；本地 D1 migrations 命令返回 `No migrations to apply!`。
- **代码层证据**：所有路由和调用次数以下均按当前 main 源码静态追踪；这不是 Telegram/Queue/production E2E 证明。
- **未完成的真实模型验证**：`npm run test:real-workers-ai` 未通过测试 harness，在 `tests/real-workers-ai.test.ts:9` 报 Windows `spawnSync npx.cmd EINVAL`，因此不能把它当作真实 Workers AI 成功证据。

## 2. 当前完整架构图

当前部署入口由 `wrangler.jsonc:1-5` 指向 `src/app.ts`，不是 `src/index.ts`。

```text
Cloudflare Worker: src/app.ts
│
├─ GET /health
│    └─ app 自己返回 v0.7.0 / finance flags / receipt flags
│
├─ GET /v1/transactions
├─ GET /v1/stats
├─ GET /v1/summary
│    └─ handleFinanceApiRequest (src/finance.ts)
│         └─ Bearer auth -> D1 read -> JSON response
│
├─ POST /v1/intake
│    ├─ handleFinanceIntakeQuery (src/finance.ts)
│    │    ├─ parseFinanceTextQuery (确定性关键词/日期 parser)
│    │    └─ 命中查询 -> D1 read -> JSON response
│    └─ 未命中查询 -> coreHandler.fetch (src/index.ts)
│         └─ legacy parseIntake (AI) -> ingestion_log -> D1 query/create
│
├─ POST /telegram/webhook
│    ├─ secret validation -> Telegram update parse
│    ├─ message.text
│    │    ├─ Finance Command Layer
│    │    │    └─ FinanceCommand AI schema -> command executor
│    │    ├─ Finance Conversation Layer（仅在前一步 null/passthrough 时）
│    │    │    ├─ 旧 context load
│    │    │    ├─ regex semantic gates
│    │    │    ├─ FinanceConversationRoute AI schema
│    │    │    ├─ D1 summary/details/analysis/comparison
│    │    │    └─ analysis 另有一次无 schema AI prose call
│    │    ├─ parseFinanceTextQuery fallback
│    │    └─ 未命中 -> coreHandler.fetch -> src/index.ts legacy webhook
│    │         └─ /v1/intake -> parseIntake AI -> D1
│    └─ message.photo
│         └─ enqueueReceiptJob -> ingestion_log queued -> Queue
│
└─ Queue consumer
     └─ processReceiptQueueJobV2 (src/receipt-job-v2.ts)
          ├─ D1 processing lock
          ├─ Telegram getFile / download
          ├─ Veryfi OCR + receipt-resolver
          ├─ Workers AI item-category call（通常 1 次）
          ├─ deterministic safety + reconciliation
          ├─ D1 transactions + transaction_items + ingestion_log parsed
          └─ Telegram sendMessage
```

当前仍存在另一条未被 app queue handler 使用、但代码可被旧 deployment/旧引用调用的 receipt 实现：

```text
processReceiptQueueJob (src/receipt-job.ts)
  -> Telegram download
  -> analyzeReceiptImage (src/receipt.ts)
       -> Workers AI Vision 第一次
       -> 若 is_receipt=false，再做第二次 verification pass
  -> D1 transactions + transaction_items
```

因此，“当前线上主路径”与“仓库中仍可执行的备用实现”不是同一条链。

## 3. 当前全部自然语言入口图

```text
Telegram message.text
  -> src/app.ts:113
      -> handleFinanceCommandTelegram
          -> classifyFinanceCommand / FinanceCommand schema
      -> 若 null/passthrough
          -> handleFinanceConversationTelegram
              -> parseFinanceTextQuery + looksLike* regex gates
              -> classifyFinanceConversation / routeSchema
              -> analysis 时再 buildAnalysisReply / 无 schema prose AI
      -> 若仍 null
          -> parseFinanceTextQuery
      -> 若仍 null
          -> src/index.ts legacy Telegram webhook
              -> 内部 POST /v1/intake
                  -> parseIntake / legacy intake schema

POST /v1/intake { text }
  -> src/app.ts:83 handleFinanceIntakeQuery
      -> 命中关键词/日期 -> deterministic query
  -> 未命中
      -> src/index.ts:363
          -> parseIntake AI

src/index.ts 的 POST /telegram/webhook
  -> 作为 app 的 legacy fallback 实际可达
  -> 也保留为独立 legacy handler
  -> 内部转 /v1/intake -> parseIntake AI

Telegram photo + optional caption
  -> 不进入 text orchestrator
  -> caption 当前仅在旧 receipt Vision 代码中作为视觉提示；V2 Veryfi provider 调用不接收 caption
  -> Queue -> Veryfi OCR -> Workers AI 商品分类 -> 直接 D1
```

`GET /v1/transactions`、`GET /v1/stats`、`GET /v1/summary` 是结构化 API，不是自然语言入口；它们绕过 AI，但仍是 finance 行为入口，V2 需要保留其 adapter 语义并统一权限、结果和数据边界。

## 4. 当前全部 fallback 图

### 4.1 Telegram text fallback

```text
Command AI
  ├─ 高置信、非 passthrough
  │    └─ command executor（create/query/summarize/update/delete/restore）
  ├─ null / 低置信 / passthrough
  │    └─ Conversation gate
  │         ├─ 普通明确查询 -> return null
  │         ├─ route AI 成功 -> conversation query/analysis/compare
  │         └─ route null/低置信/passthrough -> return null
  ├─ deterministic parseFinanceTextQuery
  │    └─ 命中 -> D1 query + context upsert
  └─ 全部未命中
       └─ src/index.ts legacy webhook -> parseIntake AI
```

这条链允许一个自然语言 mutation 在 command AI 失败、返回 passthrough 或低置信时继续进入另一套 AI intake 解释层。虽然 legacy `parseIntake` 理论上主要支持 create/spending_today/unknown，但它没有 update/delete/restore 的硬拒绝协议；因此不能保证失败的 mutation 不会被另一模型解释为 create 或其他操作。

相反，如果 command 已经得到 action 但 executor 抛错，`src/app.ts:130-133` 会直接返回 `FINANCE_COMMAND_FAILED`，不会进入后续 parser。这造成两种不一致的失败语义：分类失败可能继续 fallback，执行失败则停止。

### 4.2 `/v1/intake` fallback

```text
POST /v1/intake
  ├─ text 命中 parseFinanceTextQuery
  │    └─ deterministic read-only query；不写 ingestion_log、不保存 context
  └─ text 未命中
       └─ legacy parseIntake AI
            ├─ spending_today -> D1 read，但先写 ingestion_log
            ├─ create_transaction -> D1 batch create
            └─ unknown/低置信 -> 422
```

因此 `/v1/intake` 仍然是绕过 V2 的自然语言 create 入口；只把查询拦到 `handleFinanceIntakeQuery` 并不等于统一入口。

### 4.3 Receipt fallback / alternate implementation

- 当前 app queue 使用 `processReceiptQueueJobV2`，Veryfi 失败会进入 `failed`，商品分类 AI 失败则静默把所有商品分类为 `其他` 后继续。
- 仓库仍保留 `processReceiptQueueJob` + `analyzeReceiptImage`；后者在 `is_receipt=false` 时自动二次 Vision pass，调用次数为 1-2 次。
- V2 provider 本身没有旧 Vision pass 的 fallback；旧 processor 不是当前函数内的 fallback，而是另一个可执行 receipt 语义实现，必须在 cutover/in-flight Queue 计划中处理。

### 4.4 解析/引用层 fallback

- `src/finance-command.ts:329-335` 只读取 AI 返回的 `response`；结构不匹配时返回 null，触发后续链路。
- `src/finance-conversation.ts:347-351` 的 analysis prose 只接受 `response` 字符串，失败后改用 deterministic fallback 文案。
- `src/finance-reference.ts:83-112` 会把无法精确映射的 category/account 静默降级到默认分类/账户。
- `src/ai.ts:82-84` 在 legacy intake 中对解析结果做 reference normalization；它是数据映射 fallback，不应被扩大成新的语义 authority。

## 5. Path-by-path 入口审计

以下调用次数是基于当前 main 的代码路径分析，计数包含实际发起的 `env.AI.run()` 尝试；未把 Veryfi 外部 OCR 当作 Workers AI 调用。

### 5.1 Telegram 文字：主入口

- **输入来源**：`POST /telegram/webhook`，Telegram `message.text`、`chat.id`、`message_id`、`update_id`、`message.date`。
- **当前调用路径**：`src/app.ts:113-168` -> Command -> Conversation -> deterministic query -> legacy `src/index.ts`，按前一层结果短路。
- **是否调用 AI / 几次**：
  - 每个 Telegram `message.text` 都先尝试 1 次 Command AI；若高置信返回 create/query/summarize/update/delete/restore，则直接进入对应 executor，实际为 1 次。
  - “今天支出多少”这类日期查询可能被 Command AI 直接解释为 command query/summarize，也可能返回 passthrough 后命中 deterministic `parseFinanceTextQuery`；前者和后者都不会再增加 AI，但语义 schema 不同。
  - analysis：Command AI 1 + Conversation route AI 1 + analysis prose AI 1 = 最多/通常 3 次。
  - compare 或 Conversation 接管的 summary/details：Command AI 1 + Conversation route AI 1 = 通常 2 次。
  - command null/低置信后，若 Conversation gate 不接管且 deterministic parser 也未命中，最终 legacy intake 为 Command AI 1 + legacy `parseIntake` AI 1 = 2 次；若先进入 Conversation route 但未返回结果，再落 legacy，最多 3 次。
  - command 分类失败本身仍是 1 次失败尝试，随后按上面 fallback 继续。
- **schema/parser**：`FinanceCommand` / `buildCommandSchema`（`finance-command.ts:93-160`）；`FinanceConversationRoute` / `routeSchema`（`finance-conversation.ts:47-58`）；`parseFinanceTextQuery` regex parser（`finance.ts:183-239`）；legacy `ParsedIntake` / `buildSchema`（`ai.ts:10-38`）。analysis prose 无 schema。
- **上下文持久化**：只有 Conversation 成功或 app deterministic query 成功时写 `finance_chat_context`；Command 的 create、query、summarize、update、delete、restore 都不更新 session/reference。
- **是否可能 fallback 到另一套理解层**：是。分类 null/低置信/passthrough 可以继续进入 Conversation、regex parser 和 legacy `parseIntake`；这正是 Blueprint 禁止的 mutation fall-through 风险。
- **可能副作用**：Command create 写 `transactions`；update/delete/restore 写 ledger；Conversation analysis/compare/query 会写旧 context；legacy intake 会写 `ingestion_log` 和/或 `transactions`；最终还会发送 Telegram 消息。
- **当前幂等机制**：create 依赖 `transactions UNIQUE(source, source_id)`，多笔使用 `source_id`、`source_id#2` 等 suffix；update/delete/restore 没有先按 source/source_id 做 durable idempotency reservation。Telegram event ID 仅拼成 source ID，没有单独的 turn/event 表。
- **当前 audit 机制**：Command update/delete/restore 写 `ledger_operations`；Command create、legacy create、Conversation read/analysis、deterministic query 没有同一套 finance audit。拒绝、歧义、no-match 也没有统一 operation record。
- **V2 去向**：Telegram adapter 只生成 `FinanceTurn`；进入唯一 Dialogue Orchestrator；所有 operation 进入同一 Plan/PlanPatch -> Safety -> Executor -> Result -> Renderer/outbox。legacy parser 不得作为自动 fallback。

### 5.2 Telegram 购物小票及 caption

- **输入来源**：`POST /telegram/webhook` 的 `message.photo`，可带 `caption`。
- **当前调用路径**：`src/app.ts:166-196` -> `enqueueReceiptJob`（`receipt-job.ts:41-125`）-> Queue -> `processReceiptQueueJobV2`（`receipt-job-v2.ts:24-165`）。
- **是否调用 AI / 几次**：webhook 入队阶段 0 次；V2 Queue 阶段 Veryfi OCR 不是 `env.AI`，若存在商品行则 `classifyCategoriesSafely` 通常 1 次 Workers AI。旧 `processReceiptQueueJob` 路径会调用 Vision 1 次，首轮拒绝时再调用第 2 次。
- **schema/parser**：V2 使用 Veryfi response -> `resolveVeryfiReceipt`（`receipt-resolver.ts`）-> `categorySchema` 商品分类；旧路径使用 `receiptSchema` Vision JSON schema。两者都不是 FinancePlan。
- **上下文持久化**：只有 `ingestion_log` queued/processing/parsed/rejected/failed；不写 `finance_chat_context`、FinanceTurn、result set 或 recent receipt references。caption 进入 queued/raw_text，但 V2 provider 不把 caption 传入 provider resolver。
- **是否可能 fallback 到另一套理解层**：主流程没有回到 finance text orchestrator；分类 AI 异常会全量降级为“其他”。旧 Vision processor 仍是另一套可执行 receipt 解释层。
- **可能副作用**：Queue 入队、Veryfi 外部 API 调用、Workers AI 调用、D1 transaction + item 入账、Telegram acknowledgment/final message。
- **当前幂等机制**：`receipt_${chatId}_${file_unique_id}`；`ingestion_log UNIQUE(source, source_id)`、processing lock、`transactions UNIQUE(source, source_id)`，并按 at-least-once Queue 设计。但锁获取是多步读后写，且没有统一 operation id/outbox。
- **当前 audit 机制**：仅 `ingestion_log` 状态和 error_message；成功 receipt 不写 `ledger_operations`，也没有 provider attempt、turn、event time、result、send status。
- **V2 去向**：Receipt adapter 保留 OCR/provider 专业能力，但必须产出受信任的 `ReceiptResolvedInput`，经统一 receipt-aware executor 写 parent/items、audit、idempotency、session references 和 Result；receipt extraction 与人类自然语言 orchestrator 要有明确边界。

### 5.3 `POST /v1/intake` 自然语言 API

- **输入来源**：Bearer-authenticated JSON `{ text, source?, source_id?, reference_time? }`。
- **当前调用路径**：app 先调用 `handleFinanceIntakeQuery`；命中 deterministic query 则直接返回；未命中由 `src/index.ts:363-565` 处理。
- **是否调用 AI / 几次**：命中 `parseFinanceTextQuery` 为 0 次；未命中为 legacy `parseIntake` 1 次。
- **schema/parser**：`parseFinanceTextQuery` 或 `ParsedIntake` schema；只支持 `create_transaction`、`spending_today`、`unknown`。
- **上下文持久化**：不写 `finance_chat_context`；legacy 路径写 `ingestion_log`，但不是 session/turn projection。
- **是否可能 fallback 到另一套理解层**：它本身是 app 对 legacy intake 的 fallback；没有 V2 route、没有 mutation fail-closed boundary。`source_id` 缺失时还会随机生成 UUID。另有 `src/index.ts:402-403` 的 `__mockParsedIntake` 测试注入旁路仍编译在 production handler 中，虽不是外部默认入口，却是必须在 cutover 前清理的语义绕过点。
- **可能副作用**：legacy create 批量写 transactions；即使 spending_today 是 read-only，也先写 ingestion_log；unknown 也写 failed ingestion record。
- **当前幂等机制**：有 root `source/source_id` pre-check 和多笔 suffix；无 source_id 时随机 UUID，调用重试会再次产生新语义处理；query 没有 request idempotency。
- **当前 audit 机制**：ingestion_log 记录 intent/status/raw_text；create 不写 `ledger_operations`，也不保存计划、模型调用次数或最终 result。`handleFinanceIntakeQuery` 在解析自然语言 query 时不读取 body 的 `reference_time`，因此会使用 Worker 当前时间；legacy create 才使用调用方提供的 `reference_time`，这是 API 内部的时间语义分叉。
- **V2 去向**：要么将其明确降级为 compatibility-only legacy endpoint，要么定义 API `FinanceTurn`/structured operation contract 并进入同一 core；不得继续作为未标识的自然语言旁路。

### 5.4 `src/index.ts` legacy Telegram webhook

- **输入来源**：`POST /telegram/webhook` 的 text update；在当前部署中由 `src/app.ts:168` 的 `coreHandler.fetch(legacyRequest, env)` 实际可达。
- **当前调用路径**：`src/index.ts:568-628` -> 内部构造 `/v1/intake` Request -> `this.fetch` -> `src/index.ts:363-565` -> `parseIntake`。
- **是否调用 AI / 几次**：通常 1 次 legacy `parseIntake`。
- **schema/parser**：legacy intake schema；不理解 update/delete/restore/analysis/compare 的统一协议。
- **上下文持久化**：无 finance session；只会写 legacy `ingestion_log`。
- **是否可能 fallback 到另一套理解层**：它就是主 app 的最后一层理解 fallback；与 Command/Conversation 形成双语义权威。
- **可能副作用**：可 create；可写 ingestion_log；再调用 Telegram sendMessage。发送 HTTP response 未严格核验成功，仍可能返回 `{ok:true}`。
- **当前幂等机制**：转发时使用 `tg_message_id` 或 `tg_update_id`，依靠 transactions unique；没有统一 update/event 表。
- **当前 audit 机制**：仅 legacy ingestion_log；create 无 ledger operation。
- **V2 去向**：保留 index 中非 finance/sync 能力；finance legacy webhook 仅在明确标记的 compatibility route 中存在，并在 cutover 后禁止自动进入。

### 5.5 Finance read APIs

- **输入来源**：`GET /v1/transactions`、`GET /v1/stats`、`GET /v1/summary`，Bearer token。
- **当前调用路径**：`src/app.ts:80-84` -> `src/finance.ts:390-480` -> D1。
- **是否调用 AI / 几次**：0 次。
- **schema/parser**：URL 参数 `month/date/from/to/type/page/limit` 的确定性 validator；不是自然语言 parser。
- **上下文持久化**：无；不创建 session/result reference。
- **是否可能 fallback 到另一套理解层**：没有 AI fallback；但不是 V2 Dialogue Orchestrator 的统一 result contract。
- **可能副作用**：只读 D1；没有 Telegram side effect。
- **当前幂等机制**：无 request idempotency（read-only 通常不要求），但 offset pagination 没有 snapshot/fingerprint。
- **当前 audit 机制**：无 read audit。
- **V2 去向**：作为受认证的 API adapter，调用同一 deterministic query/executor/result/renderer；保留结构化 API 的显式语义，不应强行通过 LLM。

## 6. 当前状态、fallback、执行链和数据库审计问题

### 6.1 `src/app.ts`

- `wrangler.jsonc:4` 只指定 `src/app.ts`，所以 `src/index.ts` 不是独立 production entry，但通过 `coreHandler.fetch` 仍参与 finance fallback。
- `app.ts:80-84` 在 Telegram webhook 之前拦截 finance APIs 和 `/v1/intake` query，因此 API 与 Telegram 的行为天然分叉。
- `app.ts:113-163` 是串行的多语义路由；它无法表达“本 turn 已经确定是 mutation，失败必须 fail closed”的状态。
- `app.ts:186-209` 直接把 Queue result 发 Telegram；没有 outbox、send attempt、消息顺序或 render state。
- `sendTelegramMessageSafely` 吞掉发送失败（`app.ts:48-54`），因此 HTTP 200/Queue ack 不能证明用户收到回复。

### 6.2 `src/index.ts` / legacy intake

- `src/index.ts:384-397` 只检查 transaction root source/source_id，不检查 ingestion operation 是否已完成，也不处理“root 缺失但 suffix 存在”的部分状态。
- `src/index.ts:399-427` 在 AI 解析之后单独写 ingestion_log；它与 transaction batch 不是一个原子 operation。若后续 `env.DB.batch(statements)` 失败，外层只返回 500，不会把此前写入的 `status='parsed'` 改成 `failed`，所以 ingestion_log 可能出现“parsed 但没有交易”的假终态。
- `src/index.ts:402-403` 读取 `__mockParsedIntake` 作为 AI 替代输入；这是测试钩子混入生产路径，必须明确隔离或删除，不能成为 compatibility fallback。
- `src/index.ts:465-515` 先逐项解析 reference，再 batch insert；创建没有统一 ledger audit。
- `src/index.ts:562-565` 把内部错误 message 放入 API `details`，会把 DB/provider 错误暴露给调用方。
- `src/index.ts:592-624` 的 legacy webhook 不检查 Telegram sendMessage response.ok，且其 route 行为和 app webhook 不同。

### 6.3 `src/finance-command.ts`

这份文件同时承载 AI 解释、目标解析、mutation executor、snapshot、audit、回复渲染，已经是多个边界揉在一起的过渡层。

- `FinanceCommand` 不含 analyze/compare，只能把它们交给另一语义岛（`finance-command.ts:284-335`）。
- `classifyFinanceCommand` 失败返回 null（`finance-command.ts:329-335`），没有“已判定 mutation 但解释失败”的不可穿透状态。
- `normalizeMutationTargetForSafety` 继续根据用户原文中的“今天/昨天/刚才”等 regex 改写模型结果（`finance-command.ts:251-275`），这不是纯输入清洗，而是语义/授权决策。
- `targetWhere` 不能表达 session result set、receipt item、精确时间、currency、source、当前页等（`finance-command.ts:338-386`）。
- `resolveTargets` 的稳定排序与 API 不一致，且只有 LIMIT，没有 snapshot/fingerprint（`finance-command.ts:397-417`）。
- explicit `count=N` 时没有验证真实候选数是否恰好满足 N；`rows.slice(0, count)` 可以在只找到 1 条时执行“用户明确要 2 条”的部分 mutation（`finance-command.ts:607-611`、`640-692`）。
- update/delete 没有 source/source_id 幂等检查；`ledger_operations` 只是记录 source 字段，不构成唯一 idempotency key。
- restore 只按最近 20 个 applied delete operation 扫描，几乎完全不使用用户的 target/reference（`finance-command.ts:709-761`）；“恢复刚才那张/某一笔”可能恢复错误的最近删除记录。
- create 没有 `ledger_operations`，receipt 也不经过本文件，故“所有 mutation 统一审计”目前不成立。

### 6.4 `src/finance-conversation.ts`

- `routeSchema` 只有 inherit/today/yesterday/month/day，没有任意 range、结果集、分页、字段、排序、topic 或 mutation patch（`finance-conversation.ts:47-58`）。
- `finance_chat_context` 只读写最近范围、label、mode、last text（`finance-conversation.ts:134-170`）；`last_user_text` 保存了但没有作为完整 turn context 供模型使用。
- `handleFinanceConversationTelegram` 在调用 AI 前先用 `parseFinanceTextQuery`、`looksLikeFinanceAnalysis`、`looksLikeContextualFollowup` 和 `hasFinanceSignal` 做语义门控（`finance-conversation.ts:455-471`）。这既漏掉模型可理解的自然语言，又保留了第二套语义 authority。
- analysis 路径是 route AI + data query + prose AI（`finance-conversation.ts:367-395`、`455-490`）；compare 只比较支出，忽略收入、转账、净额和筛选条件（`finance-conversation.ts:437-452`）。
- context save 失败被吞掉，查询仍可能返回成功但下一轮丢上下文；context load 失败也被当作 null（`finance-conversation.ts:134-170`）。
- 每次继承都重置 `page:1, limit:10`，没有当前结果集/当前页面语义；因此“下一页/这些/第二笔”无法可靠解析。

### 6.5 `src/finance.ts`

- `parseFinanceTextQuery` 只覆盖固定关键词和今天/昨天/月/显式日期（`finance.ts:183-239`），不支持“上周六到今天”等任意绝对/相对 range，也无法表达字段、排序、分组或结果引用。
- 只读 Telegram formatter 与 command formatter 字段不同：API/finance query 使用 `occurred_at DESC, id DESC`（`finance.ts:314-332`），command 使用 `occurred_at DESC, created_at DESC, id DESC`（`finance-command.ts:404-415`）。
- API 使用 offset pagination，没有 stable snapshot；数据在两次 page 请求间变化时可能重复/漏项。
- `handleFinanceIntakeQuery` 在 auth 之后没有写入 context，导致 API 发起的查询与 Telegram 对话不共享 session。

### 6.6 `src/ai.ts` 和 `src/finance-reference.ts`

- `src/ai.ts:41-85` 是另一套动态 taxonomy + ParsedIntake schema，仍可独立 create。
- `validateParsed` 允许 amount 为 0，真正失败延迟到 D1 CHECK；日期/货币/字段清洗不足以保证完整 domain invariant（`ai.ts:87-168`）。
- `normalizeParsedReferenceFields` 对无效 category/account 静默 fallback 到默认值（`finance-reference.ts:83-112`）；这会把“模型无法确认”转换为“已确认的其他支出/未指定”，需要由 V2 policy 明确是拒绝还是允许降级。
- catalog 是全局 active categories/accounts，不带 actor/session/权限边界；V2 reference resolver 不能只复制现有 prompt。

### 6.7 receipt chain

- `receipt-job-v2.ts:101-141` 直接 batch 写 parent、items 和 ingestion status，没有 FinancePlan/FinanceResult/ledger operation/session reference。
- `resolveReceiptAccountId` 找不到支付方式时直接返回硬编码 `account-unspecified`（`receipt-job-v2.ts:279-294`），没有统一 account resolver/policy。
- 顶层 category 由商品分类金额多数映射为 `cat-expense-food/daily/other`（`receipt-job-v2.ts:296-310`），与 finance reference catalog 和 item category taxonomy 是两套模型。
- receipt 成功后没有把 parent transaction、item IDs、receipt source/attempt 写进会话，因此 `第二项改成日用品`、`这张小票撤销` 等不能可靠进入同一引用模型。
- Queue 发送失败可能导致已提交交易在重投后又发送 duplicate 用户消息；`message.ack()` 是在 Telegram send 成功后才调用，但没有发送 outbox 去重。

## 7. current -> V2 组件迁移表

| 当前组件/数据 | 当前角色 | 分类 | V2 去向与限制 |
|---|---|---|---|
| `src/app.ts` webhook/API/Queue adapter | 入口、顺序 fallback、发送消息 | **ADAPT** | 只保留协议校验、Turn 生成、adapter、Queue binding；删除 finance intent 分支和自动 fallback。 |
| `src/index.ts` sync/file API | 非 finance core 与 legacy finance | **ADAPT + COMPATIBILITY_ONLY** | sync 路径可复用；legacy finance routes 只作为显式 compatibility endpoint，不能再是默认路径。 |
| `src/finance.ts` D1 summary/list SQL | 读模型、旧 formatter、API adapter | **ADAPT** | 抽出 deterministic query/executor/result/renderer；删除其自然语言 parser authority。 |
| `parseFinanceTextQuery` | 关键词/日期语义 parser | **COMPATIBILITY_ONLY** | 仅允许在明确 legacy API 版本中短期存在；不得被 V2 Telegram/API 默认路由调用。 |
| `src/finance-command.ts` `classifyFinanceCommand`、Command schema | 独立 NLP authority | **REMOVE_AFTER_CUTOVER** | 不复用为第二协议；其 executor 中的 SQL/快照/金额逻辑可拆入 V2 deterministic executor。 |
| `src/finance-command.ts` target/snapshot/audit helper | 过渡 executor | **ADAPT** | 复用纯事实/执行部分，但必须加入 plan version、actor、turn、idempotency、CAS、receipt item 和统一 Result。 |
| `src/finance-conversation.ts` route schema/regex gate/旧 context | 独立 NLP authority | **REMOVE_AFTER_CUTOVER** | route/regex/context 不能进入最终权威路径。 |
| `src/finance-conversation.ts` D1 analysis/comparison 聚合 | 真实数据聚合 | **ADAPT** | 作为 Analysis capability，输入只能是统一 Result/plan；compare 语义需重定义并纳入统一 Plan。 |
| `src/ai.ts` `parseIntake`/legacy schema | legacy natural-language create | **COMPATIBILITY_ONLY -> REMOVE_AFTER_CUTOVER** | 只在显式迁移窗口保留；禁止作为 V2 失败后的 fallback。 |
| `src/finance-reference.ts` catalog/resolver | 分类/账户事实查询 | **ADAPT** | 保留 DB lookup；取消无策略的静默 fallback，增加 type/actor/scope/ambiguity contract。 |
| `src/telegram-time.ts` | Telegram event time 转本地时间 | **REUSE** | 作为基础工具复用，但 Turn 必须同时保存 event_time、received_time、timezone、消息序号/topic。 |
| `src/receipt-resolver.ts` | Veryfi 字段重建、商品名/金额解析 | **REUSE** | 保留为 receipt extraction/resolution 专业模块；输出必须进入统一 receipt-aware executor。 |
| `src/receipt.ts` `reconcileReceipt`/纯校验 | 金额核对、结构安全校验 | **REUSE** | 作为 code-only safety capability，统一错误码和 Result。 |
| `src/receipt.ts` Vision AI pass | 旧 receipt semantic/vision pipeline | **COMPATIBILITY_ONLY -> REMOVE_AFTER_CUTOVER** | 仅处理旧 Queue in-flight 兼容；最终只保留一套明确 provider/extraction contract。 |
| `src/receipt-provider.ts` Veryfi transport | 外部 OCR、商品分类 AI | **ADAPT** | 外部 provider 是受控 extraction adapter；商品分类是否调用 LLM、失败是否拒绝，须写入 Blueprint，不得静默降级。 |
| `src/receipt-job.ts` enqueue/lock | Queue ingress 与旧 processor 混合 | **ADAPT** | 保留入队/lease 思路；拆出 Queue adapter、attempt state、outbox；旧 processor compatibility-only。 |
| `src/receipt-job-v2.ts` Queue processor/direct D1 write | 当前活动 receipt 后续链路 | **ADAPT** | 保留下载/超时/lock 逻辑的可复用部分；禁止继续绕过统一 executor、audit、reference、Result。 |
| `src/types.ts` Env/transaction/receipt 基础类型 | 共享类型 | **ADAPT** | 新增 FinanceTurn、Plan/PlanPatch、ReferenceSpec/Resolution、ResultSet、Execution、actor/idempotency/error 类型；legacy ParsedIntake 标为 compat。 |
| `migrations/0001` transactions/accounts/categories/ingestion_log | ledger 基础 schema | **REUSE + ADAPT** | 保留历史数据；添加 actor/event/operation/outbox 等字段或新表，不能直接破坏 unique/source 语义。 |
| `migrations/0002` sync_files | Obsidian sync | **REUSE** | 与 finance V2 无关，保持隔离。 |
| `migrations/0003` transaction_items | receipt item 数据 | **REUSE + ADAPT** | 保留 FK/cascade；增加 item version/operation/reference 所需模型。 |
| `migrations/0004` `finance_chat_context` | 旧单行 session | **COMPATIBILITY_ONLY** | 迁移窗口读取/回填；不能作为 V2 长期 session projection。 |
| `migrations/0005` fidelity recovery log | 历史分类/账户恢复证据 | **ADAPT** | 保留历史 evidence；必须先解决与 hard delete 的 FK 生命周期冲突。 |
| `migrations/0006` inactive composite categories | 历史数据兼容 | **REUSE** | 保留历史 category_id；Blueprint 需要记录其单向数据迁移和查询行为。 |
| `migrations/0007` ledger_operations | update/delete/restore snapshot audit | **ADAPT** | 扩展为统一 operation/audit/idempotency 基础，或定义新 operation log；不能只把它当现成完整审计。 |
| `tests/*` 当前纯单元/mock | 局部回归 | **ADAPT** | 保留纯函数回归；新增 app/API/Queue/D1/AI/并发/rollback/architecture guard/E2E suites。 |
| `scripts/generate-finance-fidelity-recovery.ts` | 历史数据恢复与 SQL 生成 | **REUSE + ADAPT** | 保留为一次性维护工具；rollback SQL 不能代替 V2 production rollback。 |

## 8. 数据库 / session migration 影响

### 8.1 现有 0001-0007 的兼容事实

- **0001**：`transactions` 以 `(source, source_id)` 唯一；`amount_fen > 0`；`transaction_items` 尚未存在；`ingestion_log` 只有一个 `created_at`，没有 attempt/event/lease/version。所有自然语言来源都共用全局 ledger，没有 actor/chat/topic scope。
- **0002**：只创建 `sync_files`，不应被 finance V2 migration 牵连。
- **0003**：`transaction_items.transaction_id` `ON DELETE CASCADE`，对 receipt delete/restore 有数据影响；item schema 是固定枚举，无法表达 item patch、item version 或 provider attempt。
- **0004**：`finance_chat_context.chat_id` 单主键，每个 chat 只有一行；24 小时 TTL 是代码查询条件，不是数据模型；无法回填历史 result IDs、页面、排序、引用或并发 turn。
- **0005**：`finance_fidelity_recovery_log.transaction_id` 有 FK，但没有 `ON DELETE CASCADE`。因此只要某交易存在 fidelity recovery log，当前 `finance-command.ts:609` 的 hard delete 就可能被 FK 拒绝；Blueprint 必须把历史维护表与 delete/restore 生命周期纳入兼容设计。
- **0006**：只把历史复合分类设为 inactive，不改变历史 transaction.category_id；新 resolver 不能误把 inactive historical label 当作可新建分类，也不能破坏历史查询显示。
- **0007**：`ledger_operations` 只覆盖 `update/delete/restore`，没有 unique `(source, source_id, operation)`、turn/session/actor/event time、result/outbox、create/receipt audit，也没有 immutable operation state machine。

### 8.2 实施前必须明确的新增数据边界

当前 Blueprint 建议的单行 `finance_sessions` 不足以覆盖长期对话。至少要在 Blueprint 中明确以下逻辑表/投影，不要求本轮实现，但必须在实施前定稿：

1. **append-only `finance_turns`**：保存 turn_id、channel、channel_event_id、actor/tenant、session_key、topic/thread、event_time、received_time、timezone、idempotency_key、payload hash、interpretation status、execution status、result/outbox linkage。
2. **`finance_sessions` projection**：保存当前 plan pointer、session version、active topic、current result set handle、reference index、last accepted event order；所有写入用 CAS/version。
3. **`finance_result_sets` 或等价 immutable snapshot handle**：保存 query fingerprint、排序键、完整/当前页范围、visible IDs、total、plan version、ledger snapshot/version、过期策略；不能只存“可重新查询”的模糊 metadata。
4. **统一 operation/idempotency 表**：所有 create/update/delete/restore/receipt operation 都必须先占用 durable key，记录 terminal status，重放只返回原 Result。
5. **receipt attempt/attachment reference**：保存 source_id、message/update/event、provider、attempt、状态、parent ID、item IDs、reconciliation、错误阶段；原图是否保留必须是明确 policy。
6. **outbox/message delivery 表**：D1 mutation/result/session state 与 outbox 原子提交，Telegram/API renderer/send 在事务外可重试且不重复制造用户消息。

### 8.3 Migration 与 rollback 风险

- SQLite/D1 对既有表增加约束或重建表可能需要 table copy；Blueprint 当前没有 fresh DB、0001-0007 upgrade、已有生产数据、回滚/前滚的逐版本矩阵。
- 0006 的 inactive 数据迁移是单向改变；0005 恢复日志和现有 hard delete 需要先做生命周期设计，不能简单新增 session 表后宣称可回滚。
- 0007 snapshot JSON 可能很大，扩展为统一 audit 需要限制大小、敏感字段、schema version 和 retention。
- 旧 Worker 与新 schema 的兼容性没有验证；尤其旧 `/v1/intake` 仍可能写 transactions，而新 Worker 可能依赖新 operation/session 记录。
- Queue 中已经存在的旧 job 可能使用旧 `ReceiptQueueJob` 语义；切换 consumer 时必须有 job schema/version 和 drain 策略。

## 9. 生产 rollout 风险

### CRITICAL

1. **双语义权威仍会执行**：Command、Conversation、regex、legacy intake 同时存在；Blueprint 当前没有强制 cutover gate 来阻止 legacy mutation。
2. **mutation 幂等不完整**：update/delete/restore 没有统一 durable key；网络重试、超时重放或迟到消息可能再次修改不同目标。
3. **restore 目标不可信**：当前 restore 按最近 delete operation 扫描，不按用户 reference/target 解析；短期继续共存会产生错误恢复。
4. **receipt 绕过统一 core**：小票成功入账没有统一 audit/session/reference/result，用户无法可靠进行后续 item/parent 引用。
5. **session 丢失或被覆盖**：单行 chat context 无 version；并发或 Telegram 乱序消息可互相覆盖。

### HIGH

6. **topic/session key 缺失**：Telegram forum `message_thread_id`、频道/群组、用户/聊天边界未进入 session key；不同 topic 可能共享 context。
7. **时间语义不完整**：Telegram message date 已被用于部分 occurred_at，但 session/audit/ledger `CURRENT_TIMESTAMP` 仍是处理时间；没有 event-time ordering contract。
8. **结果集分页漂移**：Telegram、Command、API 使用不同排序；offset/page 没有 immutable result handle，后续“第二笔/这些/下一页”不稳定。
9. **renderer failure 无状态协议**：ledger 已提交但 Telegram send 失败时，没有 outbox/send state；重试可能重复回复，成功 HTTP 也不等于实际送达。
10. **API 与 Telegram 分叉**：API read/query 不保存 context，`/v1/intake` create 走 legacy；同一句自然语言在不同入口可能得到不同 operation/schema。
11. **shadow mode 的成本和副作用**：AI 调用、Veryfi 调用、日志、context、outbox、external rate/cost 都没有严格禁止/隔离清单。
12. **rollback 不可证明**：没有 feature flag、老版本 schema compatibility、Queue drain、已执行 mutation 的补偿/前滚策略。

### MEDIUM

13. `finance_fidelity_recovery_log` FK 与 hard delete 的冲突会在特定历史数据上暴露。
14. 非 schema-constrained analysis prose 的字段/格式不稳定，且当前只读取一种 Workers AI response shape。
15. active taxonomy、receipt item taxonomy、top-level finance taxonomy 之间没有正式映射协议。
16. 现有 health flags 只证明代码返回静态字段，不能证明真实 route、AI、Queue、Gateway、Telegram 送达。

## 10. Blueprint 遗漏项（A-I）

### A. FinancePlan schema 不足以表达真实场景：**是，必须修订**

当前 logical shape 没有定义：

- create 的多笔 entries/每笔字段、receipt resolved input、item patch；
- amount 的 fen/currency 精度和 clear-to-null 语义；
- exact/inclusive/exclusive date-time range、timezone、week definition；
- compare 的两侧范围、metric、dimension、filter；
- PlanPatch 是 merge、replace 还是 clear；
- base session version、plan version、idempotency key、actor/authorization；
- reference spec 与 code resolution result 的分层；
- explicit N 的 exact cardinality 和 current page/full result set；
- clarification payload、field-level confidence、invalid/ambiguous reason；
- `additionalProperties:false`、schema version migration 和 discriminated union。
- Blueprint 的 `FinanceResult.status` 草案同时包含语义重叠的 `applied`/`success`，却没有 `failed`、`pending`、`duplicate`、`in_progress`、renderer/send pending 及 terminal replay 的正式语义；它不足以区分“事实已提交”“结果可重放”和“用户消息已送达”。

“Suggested logical shape”不能直接驱动安全实现；必须给出可校验协议，而不是继续加一个新 parser。

### B. Session State 仍不足以支撑长期多轮：**是，必须修订**

单行 `finance_sessions` + JSON 字段仍不是长期对话模型。缺失 append-only turn history、topic/thread、actor scope、result-set handle、reference TTL/type、plan history/branch、CAS 冲突处理、event ordering、session compaction、retention/privacy 和 renderer/outbox 状态。至少要采用“turn log + session projection + immutable result set/reference index”三层逻辑。

### C. reference 模型不足：**是，必须修订**

目前只列 reference 名称，没有定义 tagged union、解析优先级、过期/失效、跨 topic 隔离、ambiguity candidate、transaction/item/receipt/operation 的关系、current page vs full set、delete snapshot 与 restore operation 的关联。`第二项` 需要稳定的 item order；`这张小票` 需要 parent/source/turn；`刚才删掉的` 需要明确 delete operation ID，而不是“最近 20 条”。

### D. Safety Policy 边界遗漏：**是，必须修订**

缺少 actor/auth/tenant/chat scope、topic isolation、精确金额与货币校验、候选数量与 explicit count 约束、row version/CAS、receipt item invariants、audit immutability、prompt injection/PII、rate/cost limits、external provider side effects、outbox、send failure、错误状态和人工确认边界。模型 confidence 不能覆盖 DB ambiguity，但“拒绝后怎样记录、怎样重放、怎样展示候选”也需要协议。

### E. rollback 不现实：**是，必须修订**

“additive migration + route flag”只是方向，不是可执行 rollback。必须说明：D1 migration up/down/forward-only、旧 Worker 读新 schema、已执行 V2 mutation 的补偿策略、Queue in-flight job version、external provider/Telegram 已发生副作用、旧 parser 删除时如何回退、0005/0006/0007 的既有数据影响，以及 rollback 后 session/result/audit 如何保持可解释。

### F. shadow mode 可能有副作用：**是，必须修订**

shadow 不能只写“V2 mutation 不写”。必须明确禁止：session/result/audit/ingestion/outbox 任何写入、Telegram/API response、Veryfi 外部调用、图片处理持久化、带敏感全文的日志，以及非必要 AI/prose calls。要定义采样、成本上限、privacy、隔离 namespace、同一 event snapshot、比较内容和 kill switch。shadow 结果不能影响 V1 行为。

### G. receipt 无法真正纳入统一模型：**是，必须修订**

“创建 parent ID 写入 session reference”不足以定义 receipt 的入口/turn、caption、provider attempt、OCR 数据可信边界、item mutation、top-level category 映射、reconciliation、Queue lease、retry/outbox、失败状态和旧 Vision processor 淘汰。必须定义 receipt 是“专业 extraction adapter + code-only executor input”，还是要由统一 orchestrator 理解 caption；不能让 receipt 继续直接写 D1。

### H. production cutover 后残留双语义权威：**是，必须修订**

Blueprint 虽写 compatibility-only，但没有强制机制：当前 `/v1/intake`、legacy index webhook、`parseFinanceTextQuery`、Conversation route、Command route 和旧 receipt processor 都能继续存在。必须明确每个入口的版本、flag、拒绝行为、迁移期限、监控指标和删除条件；尤其 mutation 失败不得自动退到 legacy parser。

### I. 未来很可能再次大重构：**是**

若按当前文档实现，最可能在长期多轮、分页引用、多人/topic、receipt follow-up、并发重放、消息送达和 rollback 阶段重写 session/executor/audit。原因是 Blueprint 还没有 operation/event/outbox/version/snapshot/authorization 的正式边界，也没有统一 API/Telegram/Queue contract。

## 11. 实现前必须修改的 Blueprint 条目

以下是交回 ChatGPT 修改 Blueprint 的精确要求；本轮不实现这些方案。

1. **增加“Current route inventory”章节**：列出 `src/app.ts`、`src/index.ts`、`/v1/intake`、finance APIs、Telegram text/photo、两套 receipt processor 的入口、调用关系、AI 次数、写表和 cutover 归属。
2. **把 FinancePlan 从 logical sketch 升级为正式协议**：给出 discriminated JSON schema/TypeScript contract，包含 create entries、query filters、analysis/compare 两侧范围、mutation changes、receipt item patch、fen/currency、时区、schema version、base version、actor 和 idempotency。
3. **定义 PlanPatch 语义**：明确 field merge/replace/clear、patch base plan version、冲突、重试、引用失效和 clarification payload；不能让每个实现者自行解释 patch。
4. **定义 FinanceTurn 完整字段**：至少包含 actor/authorization subject、tenant/chat/session key、Telegram topic/thread、channel event ID、idempotency key、event_time、received_time、timezone、payload hash、causation/correlation 和 attachment/receipt refs。
5. **把 session 改为 turn log + projection**：明确 append-only turn/event 表、mutable session projection、CAS/version、乱序消息处理、duplicate event、topic switch、长期 retention/compaction 和 privacy。
6. **增加 immutable ResultSet/Reference 协议**：定义 query fingerprint、排序 tie-breaker、snapshot/ledger version、current page/full set、page token、item order、reference TTL、候选和 ambiguity；禁止用重新查询替代所有历史引用。
7. **定义统一 operation/idempotency contract**：create/update/delete/restore/receipt 全覆盖，唯一 key、reservation、in-progress、terminal replay、exact count、row version/CAS、operation status 和原始 Result 重放。
8. **补全 Safety Policy**：加入 auth/tenant scope、category/account type、money bounds/precision、receipt reconciliation、prompt injection、cost/rate limit、external side effect、restore tombstone、audit immutability 和 error taxonomy。
9. **明确 mutation transaction boundary**：ledger rows、items、audit/operation、session projection、result handle、idempotency reservation、outbox 的原子关系；renderer/send 失败后的状态必须可重试且不重复发消息。
10. **增加 API/Telegram 行为协议**：结构化 read API 可绕过 LLM，但 `/v1/intake` 的自然语言 create/query 必须明确进入 V2 或固定为 versioned compatibility endpoint；认证后的 actor 必须限制数据范围，不能全库查询。
11. **增加 analysis/compare 统一章节**：analysis/compare 只能是 FinancePlan operation，不得继续保留独立 route schema/regex gate；明确是否允许第二次 prose call、预算、response schema、真实数据边界和 compare 两侧定义。
12. **增加 receipt integration contract**：定义 ReceiptTurn、provider/extraction adapter、caption 语义、parent/item operation、item reference、receipt source identity、provider retry、Queue job version、reconciliation/audit/result/outbox；说明旧 Vision 路径何时停止接收任务。
13. **重写 shadow mode 约束**：列出绝对禁止的 DB/R2/Queue/Telegram/provider/outbox/session/log 写入和 AI 调用，定义隔离存储、采样、成本、privacy、比较字段、kill switch 和“shadow 不影响 V1”的证明。
14. **重写 rollback/migration 章节**：提供 0001-0007 existing DB upgrade、fresh DB、old Worker、新 Worker、Queue in-flight、schema version、D1 forward/compensating rollback、0005 FK、0006 inactive categories、0007 audit extension 的测试矩阵。
15. **增加 cutover gate 和删除清单**：为每个 legacy route/parser 标记 `shadow/canary/v2/compat/removed`，禁止 mutation fall-through；定义指标达到什么条件才可删除 `parseIntake`、Conversation route、Command NLP、regex parser 和旧 receipt processor。
16. **增加 architecture guard/test contract**：guard 必须检查实际 production import/call graph，而不是只检查文件存在；测试“orchestrator error -> no second parser/no write”“one event -> one operation/result/send”“old route -> explicit compat only”。
17. **增加 observability contract**：统一 turn_id、event_id、operation_id、session version、plan version、model call count、target count、audit/result/outbox/send status；禁止 raw secret/敏感全文，且区分 HTTP success、Queue ack、Telegram API success 和用户送达。
18. **明确不新增任何 regex intent/parser**：regex 只能用于输入清洗或非语义格式校验；所有自然语言 operation、范围、指代、topic 和 presentation 解释必须回到唯一 LLM orchestrator，Code 只解析已约束字段并执行事实规则。
19. **修正 FinanceResult 生命周期协议**：拆分 interpretation、policy、execution、commit、render、delivery、replay 状态；定义 failed/pending/duplicate/in-progress 的终态与重放 payload，不能用 `success`/`applied` 两个重叠值替代 outbox/送达状态。

## 12. 可直接复用代码清单

以下只能复用其 code-only/adapter 部分，不能把现有路由结构原样带入 V2：

- `src/telegram-time.ts` 的 Telegram event timestamp 转本地时间基础函数。
- `src/receipt-resolver.ts` 的 Veryfi OCR reading-order 重建、商品名清洗、金额字段解析。
- `src/receipt.ts` 的 `reconcileReceipt`、金额转 fen、结构校验、safe AI response shape 诊断。
- `src/finance-reference.ts` 的 active category/account D1 查询和精确 ID resolver；必须补充类型、权限、ambiguity/error contract。
- `src/finance.ts` 的 D1 summary/list 查询和基础金额格式化；必须统一排序、snapshot、Result 和 renderer boundary。
- `src/finance-command.ts` 的 transaction snapshot 思路、D1 batch、before/after data capture；必须移除独立 NLP ownership并修复 idempotency/restore/cardinality。
- `src/receipt-job.ts` / `receipt-job-v2.ts` 的 timeout、processing lock、stale retry、Queue at-least-once 经验；必须改为 versioned job、lease、outbox 和统一 executor。
- `transactions`、`accounts`、`categories`、`transaction_items` 的既有历史数据与基础 schema；不得破坏历史查询和 source identity。
- `migrations/0005` 的历史 recovery evidence 与 `0007` 的 mutation snapshot 数据；需要迁移到正式 operation/audit 生命周期。
- 当前 read-only finance API 的参数校验与鉴权 adapter；必须加 actor/data scope 和统一结果格式。

## 13. 必须淘汰代码清单

淘汰应在 cutover evidence、compatibility window、Queue drain 和 rollback 证据完成后进行，不是本轮执行：

- `src/app.ts` 中 Command -> Conversation -> regex -> legacy 的自动 fallback 链。
- `src/finance-command.ts` 的 `classifyFinanceCommand`、`FinanceCommand` 作为独立 NLP authority 的部分。
- `src/finance-conversation.ts` 的 `FinanceConversationRoute`、`looksLikeFinanceAnalysis`、`looksLikeContextualFollowup`、`hasFinanceSignal` 作为语义 gate 的部分。
- `src/ai.ts` 的 `parseIntake` legacy natural-language authority。
- `src/index.ts` 的 finance legacy webhook/未版本化 `/v1/intake` natural-language create route。
- `src/index.ts:402-403` 的 `__mockParsedIntake` 测试注入旁路；测试替身不得随 production handler 发布。
- `src/finance.ts` 的 `parseFinanceTextQuery` 作为默认自然语言语义 authority 的部分；如保留只能是显式 compatibility API。
- `src/receipt-job.ts` 的旧 `processReceiptQueueJob` + `analyzeReceiptImage` Vision 语义路径，在旧 Queue job 全部 drain 后移除。
- 任何在 adapter 中根据用户自然语言决定 finance operation 的新/旧分支；不得以“兼容”名义长期保留第二语义权威。

## 14. 最终建议的 V2 模块边界

```text
1. Channel Adapters
   Telegram/API/Queue 只做 auth、schema、event extraction、response encoding。

2. FinanceTurn Intake + Ordering
   生成 turn/event/idempotency；校验 actor/session/topic/time；拒绝重复/迟到/冲突。

3. Dialogue Orchestrator
   唯一 LLM 自然语言理解层；只输出正式 Interpretation/NewPlan/Patch/Clarification。

4. Plan Protocol
   版本化 FinancePlan、PlanPatch、ReferenceSpec、Presentation、Analysis/Compare contract。

5. Session/Result/Reference Store
   append-only turns + session projection + immutable result-set handles + typed references。

6. Deterministic Reference Resolver
   只把受约束 reference/filter 解析成真实 category/account/transaction/item/operation IDs，遇到歧义拒绝。

7. Deterministic Safety Policy
   auth scope、cardinality、money/domain invariants、CAS、restore、reconciliation、cost/side-effect policy。

8. Finance Executor
   唯一 finance write/read fact executor；所有 create/update/delete/restore/receipt parent/items 走这里。

9. Operation/Audit/Idempotency/Outbox Store
   原子记录 operation、before/after、audit、session/result、idempotency terminal state 和 message outbox。

10. FinanceResult + Renderers
    Executor 先输出 typed result；Telegram/API renderer 只渲染，不 re-query、不 reinterpret。

11. Analysis Capability
    只消费结构化 FinanceResult/analysis input；是否额外 prose LLM 必须受统一预算/schema/observability 控制。

12. Receipt Extraction Adapter
    Telegram photo -> provider/OCR/resolver -> ReceiptResolvedInput；不得直接写 ledger，必须经 receipt-aware executor。

13. Compatibility Package
    明确版本、只读/可写范围、期限、指标和删除条件；不得被默认路径自动调用。
```

核心不变量：除 receipt 专业 extraction adapter 外，任何 finance mutation 不得在 adapter、provider、renderer、legacy helper 中直接写 D1；所有自然语言只经过一个 orchestrator。

## 15. 完整验收缺口

### 15.1 本轮已执行的现有检查

- `npm run typecheck`：PASS。
- `npm test`：PASS，包含：
  - `receipt-reconciliation.test.ts`
  - `receipt-resolver.test.ts`
  - `finance-query.test.ts`
  - `finance-conversation.test.ts`
  - `intake-fidelity.test.ts`
  - `multi-intake.test.ts`
- `npx wrangler deploy --dry-run`：PASS，绑定显示 D1/R2/AI/Queue，未部署。
- `npx wrangler d1 migrations list wanxiang-cloud-dev --local`：返回 `No migrations to apply!`；本轮未执行 remote migration。
- 只读 parser probe：`parseFinanceTextQuery('把上周六到今天的财务支出给我详细列出来', ...)` 被解析为“今天”的 summary；`'要求带日期，支出项'` 返回 null。这说明现有 deterministic path 无法表示 Blueprint 的关键多轮 range/presentation 场景。
- `npm run test:real-workers-ai`：FAIL，失败发生在测试自身取得 Wrangler auth token 的 `spawnSync npx.cmd EINVAL`，未形成真实 Workers AI 结果；不能用它证明 legacy AI 或 command AI 在真实模型上通过。

### 15.2 当前测试实际覆盖什么

- `finance-query.test.ts` 只测纯日期/关键词 parser。
- `finance-conversation.test.ts` 只测纯 route/date helper，不调用 AI、不读写 `finance_chat_context`、不走 app。
- `intake-fidelity.test.ts` 只测 taxonomy normalization 和 Telegram time helper。
- `multi-intake.test.ts` 直接调用 `src/index.ts`、注入 `__mockParsedIntake`、使用简化 Mock D1；没有覆盖 `src/app.ts` 的实际 fallback 和真实 AI。
- receipt tests 只测 reconciliation、resolver、response extraction；没有 Telegram getFile、Veryfi、Queue、D1、lock race、send failure 或真实 receipt follow-up。
- 没有 `finance-command.test.ts`；当前最危险的 command create/update/delete/restore、restore selection、mutation idempotency、batch audit 未被现有套件覆盖。
- `tests/real-workers-ai.test.ts` 只覆盖 legacy `parseIntake` 的一条多笔 create，不覆盖 Command/Conversation/analysis/compare/app route。

### 15.3 实现 V2 前的必测缺口

1. **真实入口路由**：Telegram text、Telegram photo/caption、`/v1/intake` create/query、`/v1/transactions`、`/v1/stats`、legacy route 的实际 app-level tests。
2. **AI call budget**：每类 turn 的实际 model call count；analysis 第二次 prose 是否允许、失败如何处理；禁止 sequential second parser。
3. **完整对话**：range -> fields -> filter -> sort -> next page -> summarize；create 后回到旧 query；topic switch/return；跨 API/Telegram session policy。
4. **引用**：这笔/那笔/上一笔/刚才两笔/第二笔/这些/上面那些/刚才删掉的/这张小票/第二项；当前页与完整结果集的明确差异。
5. **mutation safety**：多候选拒绝、explicit exact count、latest/recent 不误选、row version/CAS、update/delete/restore 重放、restore 精确 operation 引用。
6. **统一幂等**：每种 mutation、receipt parent/item、Queue duplicate、HTTP timeout retry、Telegram duplicate update、same event concurrent delivery。
7. **排序与分页**：同时间戳 tie-breaker、插入/更新中途分页、稳定 snapshot、page token、result fingerprint。
8. **乱序与并发**：旧 Telegram event 晚到、新消息先到、相同 chat 不同 topic、不同 chat 同一 receipt、session version conflict。
9. **failure injection**：LLM timeout/invalid schema、DB read/write、batch 中间 statement、audit failure、session CAS failure、renderer/Telegram send failure、Queue ack/retry。
10. **receipt 端到端**：Veryfi/provider、商品 category AI、金额 reconciliation、父子记录、item patch、receipt undo/restore、provider retry/cost、旧 Queue job drain。
11. **生产兼容**：已有 0001-0007 的升级、fresh install、历史 inactive categories、0005 recovery-log FK、old Worker/new Worker、D1 migration failure、forward/compensating rollback。
12. **shadow/canary**：证明 shadow 不写任何 finance/session/outbox/Queue/R2/Telegram/provider state；证明 V1 行为不受 V2 divergence 影响；证明 canary 只覆盖授权 actor/入口。
13. **observability**：可区分 task failure、session failure、model failure、API failure、context overflow/compression、Hook/Queue/Worker process、Gateway、Telegram API success 与真实送达。
14. **架构 guard**：必须对生产入口 call graph 做断言：一个 text turn 只有一个 orchestrator；mutation 失败不可到第二 parser；所有 writes 只有一个 executor；adapter 不包含 semantic routing。
15. **真实外部结果**：不能以 HTTP 200、Queue ack、D1 row 或本地 mock 代替 Telegram 实际回复、用户可见消息、完整状态链。

## 16. 是否有理由认为修订后仍会需要架构级重写

**按当前 Blueprint 直接实施：有，而且概率高。**

最可能再次重写的部分是：

- session 从一行 JSON 变成 turn/event + projection；
- result reference 从“最近结果 metadata”变成 immutable snapshot/operation handle；
- mutation audit/idempotency 从 `ledger_operations` 扩展成 operation/outbox 状态机；
- receipt 从直接入账变成统一 executor 的 machine-origin operation；
- API/Telegram/Queue 从三套行为收敛到同一个 core；
- renderer/send 与 ledger commit 的可靠性边界；
- rollback 和旧 Queue/旧 Worker 兼容。

**如果先按第 11 节修订 Blueprint，并在实现前冻结这些协议，架构级重写风险可显著降低，但不能在没有完整 dialogue、真实 Telegram、Queue、D1 migration、并发和 rollback E2E 前保证为零。**

## 17. 最终建议

1. 先将本报告中的 A-I 缺口和第 11 节要求写回 Blueprint，继续保持 architecture-only，不在当前 main 实现。
2. 在 Blueprint 被接受前，不要新增另一套 regex intent/parser；也不要把现有 Command 或 Conversation parser 改名后直接当 V2。
3. 实现第一阶段应先冻结 Turn/Plan/Patch/Reference/Result/Operation/Outbox schema 与 migration/rollback 计划，再写 executor 和 adapter。
4. 在任何 production cutover 之前，必须有真实 app-level path tests、全对话 tests、receipt follow-up、duplicate/ordering/failure injection、fresh/upgrade migration 和 rollback 证据。
5. 本轮结论保持：**NEEDS_REVISION；请由 ChatGPT 修改 Blueprint，下一轮再审计修订后的架构，不在本轮自行实现解决方案。**
