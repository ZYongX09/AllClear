<div align="center">

# allclear

**为 Cloudflare serverless 平台打造的状态页与基础可用性监控**

公开状态页 · 自动可用性探测 · 由真实数据计算的可用率

[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Deployed](https://img.shields.io/badge/deployed-no-lightgrey.svg)](#项目状态)

[English](README.en.md) · [工程文档](docs/engineering.md) · [规格说明](docs/spec/)

</div>

---

## 这是什么

`allclear` 提供一个公开状态页——组件树、事件时间线、90 天可用率历史、邮件订阅、
中英双语、深色模式——并且背后是**真实测量**：定时探测器记录实际发生了什么，
可用率百分比由这些记录计算得出，而不是手填上去的。

它不依赖任何托管服务，整套东西跑在你自己的 Cloudflare 账号上：两个 Worker、
一个 D1、一个 KV。探测目标由管理员配置并审核，指向你自己的端点。

![状态页截图](docs/images/status-page.png)

> 上图由项目自带的 fixture 数据在本地渲染生成（`apps/web/verify/`）。项目**尚未部署**，
> 所以这里没有线上实例的截图——fixture 数据本身是刻意做成「难看」的：一个新鲜探测、
> 一个过期探测、一个完全没有探测的组件、一个进行中的事件，以及一个不该给组件上色的
> 计划维护窗口。

## 核心特性

### 公开状态页（`/status/:slug`）

- **组件树**，按分区组织，每个组件的状态在读取时派生。
- **事件与维护时间线**，条目可展开、可深链（`#change-<public_id>` 直接定位）。
- **90 天可用率历史**，三种视图：条形、月历、表格。
- **邮件订阅**，可按组件订阅、双重确认（double opt-in）、支持 RFC 8058 一键退订。
- **中英双语、深色模式**，响应式下探到 375px。
- **Atom feed**（`/status/:slug/feed.xml`）与机器可读的 `/status/:slug/snapshot.json`。

### 自动可用性探测

- 管理员配置的 HTTP 探测，按分钟调度。
- **持久化的状态机**，带失败阈值与恢复阈值——单次请求失败不会开出公开事件。
- 探测状态翻转时自动开关 `impact` 区间，并保留真实的观测时间戳。

### 管理控制台（`/admin`）

- 页面、分区、组件、探测目标、事件、手工影响，全部可管理。
- **预算面板**：探测目标数量与每日发信量的余量。
- **快照面板**：直接读*公开*端点，所以快照过期在控制台里就能发现。

### 可用率由数据算出

探测状态翻转和手工录入的故障，都是 `impact` 区间的生产者。因此可用率永远是从
实际记录里算出来的，不存在「手写一个 99.9%」这条路。

## 明确不做

为了不让范围漂移，以下都是刻意排除的：

- on-call 排班与告警升级
- 几百个第三方服务集成
- 真实用户监控（RUM）
- 基于 AI/LLM 的事件分析
- 多租户 SaaS、计费、按客户分的账号体系

这是个状态页加一个基础监控。它不是完整的事件管理平台的替代品。

## 架构

两个 Worker，加一个只放纯函数的共享包。

```
                    ┌─────────────────────────────┐
   浏览器 ─────────▶│  allclear-web               │
                    │  Next.js (vinext)           │
                    │  • 公开状态页               │
                    │  • /admin 控制台            │
                    │  • Server Actions（写）     │
                    └───────────┬─────────────────┘
                                │  Service Binding
                                │  + X-Internal-Key
                                ▼
                    ┌─────────────────────────────┐
   cron ───────────▶│  allclear-api               │
                    │  Hono Worker                │
                    │  • 公开读 API               │
                    │  • /internal/admin/*        │
                    │  • 探测调度                 │
                    └───────────┬─────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
                 D1（真相来源）          KV（已发布的快照）
```

`allclear-api` **不暴露公网路由**。web Worker 通过 Service Binding 访问它，
而「能连上」不等于「有权限」——每个 `/internal/*` 路由还要额外校验共享的
`INTERNAL_KEY`。

## 快速开始

```sh
git clone https://github.com/ZYongX09/AllClear
cd AllClear

# 每个包各自安装依赖（这不是 npm workspaces 单仓）
npm --prefix packages/shared install
npm --prefix apps/api install
npm --prefix apps/web install
```

**不接任何 Cloudflare 资源，先看一眼界面**：

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5219
```

这条命令用 fixture Worker 提供数据，不需要 D1、KV 或迁移，打开
<http://localhost:5219/status/fixture> 即可。首次编译较慢，属正常。

**跑测试与类型检查**：

```sh
npm run typecheck   # 先构建 packages/shared，再检查三个包
npm test            # 先 packages/shared（纯 Node），再 apps/api（真 workerd + 真 D1）
npm run build       # 先构建 packages/shared，再构建 apps/web
```

`apps/api` 的测试跑在**真实的 `workerd` 与真实 D1 之上**，不是 mock——这套设计
依赖若干具体的 SQLite 行为（`db.batch()` 的回滚语义、条件 `UPDATE` 匹配零行、
偏唯一索引、`meta.changes`），用 mock 只会把「我以为它这样」当成「它确实这样」。

**部署是手动的**，没有 CI 会在推送后自动发布：

```sh
cd apps/api && npm run deploy
cd apps/web && npm run deploy
```

`git push` 成功**不代表**部署成功，要打线上 Worker 验证。

## 技术栈

Cloudflare Workers · D1 · KV · Service Bindings · Hono 4 · Next.js 16 (vinext) ·
React 19 · Vite 8 · Tailwind CSS 4 · Radix UI · `next-intl` · `next-themes` ·
lucide · Inter。

## 项目状态

**M0–M5 已全部建成并在本地验证通过。目前没有部署任何东西。**

```sh
npm run typecheck   # exit 0
npm test            # 294 项通过（shared 82 / api 212）
npm run build       # exit 0
```

这些数字衡量的是**本地构建与测试**，不是生产。完整的「已验证 / 未验证」清单在
[工程文档](docs/engineering.md#verification-honesty)，其中包含几条不该被忽略的缺口：
管理端与状态页都还没有自动化测试，也没有做过人工的观感验收。此外，一次深度静态
安全扫描的结论是 **inconclusive（不完整）**，因此**这个项目不能被称为已通过安全审计**。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/engineering.md](docs/engineering.md) | 架构、设计约束、读链、容量边界、安全姿态，以及验证边界 |
| [docs/spec/state-machine.md](docs/spec/state-machine.md) | 故障状态机与数据模型 |
| [docs/spec/probe.md](docs/spec/probe.md) | 探测器调度、SSRF 约束、保留策略 |
| [docs/spec/uptime-math.md](docs/spec/uptime-math.md) | 可用率算法（区间扫描） |
| [docs/spec/snapshot.md](docs/spec/snapshot.md) | 快照契约与一致性边界 |
| [docs/spec/admin-api.md](docs/spec/admin-api.md) / [admin-ui.md](docs/spec/admin-ui.md) | 管理接口与控制台 |
| [docs/spec/subscriptions.md](docs/spec/subscriptions.md) | 订阅、退订与发信配额 |
| [docs/spec/visual-parity.md](docs/spec/visual-parity.md) | 视觉验收记录与已知缺口 |
| [docs/spec/m0-findings.md](docs/spec/m0-findings.md) | M0 在真实 Cloudflare 上的实测结论 |
| [AGENTS.md](AGENTS.md) | 本仓库的工作规则（分支、部署、密钥、许可） |

## 已知单点

状态页和探测器都跑在 Cloudflare 上。**Cloudflare 自己挂了，这套系统就报不了它。**
要探测全平台故障，需要一个 Cloudflare 之外的探测来源；这一项目前刻意不在范围内，
被记为风险而不是已解决的问题。

## 参与

目前主要是一个个人项目。Issue 和 PR 都欢迎。

`develop` 是开发分支，`main` 是发布分支，功能开发落在 `develop`，只有作为一次
刻意的发布动作才会合并进 `main`。详细规则见 [AGENTS.md](AGENTS.md)。
仓库默认分支是 `develop`——因为还没发布过，`main` 目前只有初始骨架。

## 许可证

**GNU General Public License v3.0**（SPDX：`GPL-3.0-only`），全文见 [LICENSE](LICENSE)。

Copyright (C) 2026 ZhX589, ZYongX09

功能上受到成熟商业状态页产品的启发，但**本仓库的代码与素材全部原创**，没有复制
任何第三方的样式表、标记、文案、消息目录、logo 或图片。依赖项均为 GPL-3.0 兼容
许可（MIT / ISC / OFL / Apache-2.0）。
[OpenStatus](https://github.com/openstatusHQ/openstatus) 采用 **AGPL-3.0**，
本项目未使用其任何代码。
