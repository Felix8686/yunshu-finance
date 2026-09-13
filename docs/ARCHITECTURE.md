# 云枢 v0.1 架构

## 目标

云枢是个人财务记录与回顾系统，不是通用 Agent 平台。

它要可靠完成两件事：

1. 把自然语言变成结构化财务指令。
2. 用确定性代码把这些指令落到真实数据库并返回结果。

## 唯一主链路

```text
Telegram
  -> Cloudflare Worker
  -> DeepSeek API
  -> FinanceCommand JSON
  -> 参数校验
  -> 固定代码执行 D1
  -> 确定性结果
  -> Telegram
```

## 五条架构铁律

1. DeepSeek 是唯一自然语言理解权威。
   后端不写关键词路由、不写正则意图识别、不维护第二套 parser。

2. 代码是唯一执行权威。
   DeepSeek 只能输出固定 FinanceCommand，不能直接执行数据库操作。

3. D1 是唯一财务事实来源。
   模型不能自己计算或记忆“真实账目”。所有统计必须来自 D1 查询结果。

4. 模型永远不能生成可执行 SQL。
   SQL 模板固定在代码中，用户输入只能变成绑定参数。

5. 不建立 fallback 意图链。
   DeepSeek 输出无效结构时直接失败并提示重试；不得偷偷切到另一套语义判断逻辑。

## v0.1 指令协议

### create

新增一笔或多笔收入/支出。

模型负责：
- 拆分多笔交易
- 理解金额
- 理解相对日期
- 统一分类
- 识别账户

代码负责：
- 校验字段
- 防重复
- D1 batch 写入

### report

所有查账都归为一个动作，通过 `report_type` 区分：

- `summary`：总账、总收入、总支出、结余
- `details`：账单、明细
- `category_breakdown`：分类构成
- `compare`：两个时间段比较

周、月、季度、年度没有各自独立代码路径；模型统一转换成绝对 `start_date/end_date`，后端只认识日期范围。

### undo

撤销当前 Telegram 用户最近一次记账消息对应的整个 transaction group。

### clarify

只有缺少必要信息时使用，例如记账没有金额。

### help

非财务请求或能力说明。

## 数据模型

v0.1 只使用一张核心表 `transactions`。

重要字段：

- `type`
- `amount_fen`
- `category`
- `description`
- `account`
- `occurred_at`
- Telegram 来源字段
- `raw_text`

金额统一使用整数分，避免浮点误差。

## 为什么不做更多层

不引入：

- Orchestrator
- 多级 Router
- Intent Parser
- Planner
- Agent memory
- 多 Provider fallback
- 模型生成 SQL
- 关键词兼容层

需要增加功能时，优先扩充 `FinanceCommand` 协议和固定执行器，而不是增加新的语义入口。

## v0.1 验收核心语句

以下必须在真实 Telegram + DeepSeek + D1 环境连续通过：

- `午饭18，支付宝`
- `一盒烟15，一个打火机3块，现金`
- `上个月的账单`
- `这个月总共花了多少`
- `看看本周各类花费`
- `第二季度总账`
- `第二季度和第一季度比一下`
- `撤销刚才那次记账`

只有这一组核心闭环稳定后，才允许增加 OCR、复杂修改、图表或其他外围能力。
