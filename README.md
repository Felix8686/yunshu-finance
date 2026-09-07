# Wanxiang Cloud

Cloudflare-first 的个人万象库云端化项目。

## Status

**Active development**

当前目标是把原本依赖本机 Obsidian / Hermes 环境的部分能力逐步迁移到云端，使记账、生活管理、数据查询和后续 Agent 自动化在电脑关机时仍可运行。

## Direction

- Cloudflare 优先部署；
- 本地 Obsidian 保留为可读、可编辑的个人知识入口；
- 云端作为持续在线的数据与自动化层；
- 后续 AI 管理能力优先部署在云端；
- 必须访问本机资源的能力采用“云端主控 + 本地轻量执行端”。

## Planned stack

- Cloudflare Workers
- D1
- R2
- Queues
- Cron Triggers

Finance Orchestrator V2 已进入隔离工作树实现验证阶段：本地协议、D1 迁移、统一执行核心、ResultSet/分页、Outbox、receipt V3 和 runtime route fence 已接入；生产迁移、部署、Telegram 真实账号 E2E 和全量 cutover 仍需按实现运行手册逐项验收。
