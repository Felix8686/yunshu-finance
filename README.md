# 云枢

AI 驱动的个人财务记录与回顾系统。

## v0.1 目标

云枢只做一条简单链路：

`Telegram -> DeepSeek -> 结构化财务指令 -> Cloudflare Worker -> D1 -> Telegram`

DeepSeek 是唯一自然语言理解入口；后端不做关键词猜测、不建立第二套意图解析器、不允许模型直接执行 SQL。

v0.1 支持：

- 自然语言记账，可一次输入多笔
- 自然语言查账
- 周 / 月 / 季度 / 年度及任意日期范围汇总
- 分类支出统计
- 两个时间段对比
- 撤销最近一次记账

## 技术栈

- Telegram Bot
- Cloudflare Workers
- Cloudflare D1
- DeepSeek API

## 开发规则

- `main` 只保存已验收版本
- 当前开发分支：`dev/v0.1`
- Secret 不进入 Git
- 所有金额以整数分 `amount_fen` 保存
- D1 是财务事实唯一来源

详细设计见 `docs/ARCHITECTURE.md`。
