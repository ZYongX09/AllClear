<div align="center">

# allclear

**为 Cloudflare serverless 场景打造的开源状态页与基础可用性监控**

公开状态页 · 自动可用性探测 · 由真实测量算出的可用率

[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

[English](README.en.md) · [工程文档](docs/engineering.md) · [规格说明](docs/spec/)

</div>

---

## 简介

`allclear` 让你在自己的 Cloudflare 账号里跑起一个公开状态页：组件树、事件与维护
时间线、90 天可用率历史、邮件订阅、中英双语、深色模式。整套系统不依赖任何第三方
托管服务，全部资源都在你的账号里。

它和「手填一个 99.9%」的状态页的区别在于数据来源。一个按分钟调度的探测器持续请求
你配置的端点，把观测到的失败与恢复写成 `impact` 区间；页面上的每一个可用率百分比都
是从这些记录算出来的——没有一条路径可以手写一个数字进去。

如果你已经跑在 Cloudflare 上，想要一个与业务同账号、权限边界清晰、又不引入 SaaS
依赖的状态页，这个项目就是为此准备的。

## 功能特性

### 公开状态页（`/status/:slug`）

- **组件树**，按分区组织，每个组件的状态在读取时派生。
- **事件与维护时间线**，条目可展开、可深链（`#change-<public_id>` 直接定位）。
- **90 天可用率历史**，三种视图：条形、月历、表格。
- **邮件订阅**，可按组件订阅、双重确认（double opt-in）、支持 RFC 8058 一键退订。
- **中英双语、深色模式**，响应式下探到 375px。
- **Atom feed**（`/status/:slug/feed.xml`）与机器可读的
  `/status/:slug/snapshot.json`。

### 自动可用性探测

- 管理员配置的 HTTP 探测，按分钟调度。
- **持久化的状态机**，带失败阈值与恢复阈值——单次请求失败不会开出公开事件。
- 探测状态翻转时自动开关 `impact` 区间，并保留真实的观测时间戳。

### 管理控制台（`/admin`）

- 页面、分区、组件、探测目标、事件、手工影响，全部可管理。
- **预算面板**：探测目标数量与每日发信量的余量。
- **快照面板**：直接读*公开*端点，所以快照过期在控制台里就能发现。

## 界面预览

![状态页](docs/images/status-page.png)

> 上图为项目自带的 fixture 数据渲染出的状态页。项目目前没有公开的演示实例。

## 部署到 Cloudflare

整套系统跑在 Cloudflare 上：一个 Hono API Worker（公开读接口、管理接口、探测调度）、
一个 Next.js 前端 Worker（状态页与控制台），以及 D1 与 KV。下面是把它从零部署到自己
账号的完整步骤。

### 前置条件

- 一个 Cloudflare 账号。免费版即可，但要注意
  [Free 套餐的 D1 读子请求上限](docs/engineering.md#capacity-boundaries-v1)。
- Node.js 20+ 与 npm。
- 账号已启用 `*.workers.dev` 子域。注册 cron 触发器要求子域存在，**即使 Worker 本身
  不对外暴露**——这是实测结论，见 [M0 记录](docs/spec/m0-findings.md)。
- Wrangler 已登录：`npx wrangler login`。或者在命令前提供 `CLOUDFLARE_API_TOKEN` 与
  `CLOUDFLARE_ACCOUNT_ID`。

### 1. 克隆并安装依赖

这不是 npm workspaces 单仓，每个包各自安装依赖：

```sh
git clone https://github.com/ZYongX09/AllClear
cd AllClear
npm --prefix packages/shared install
npm --prefix apps/api install
npm --prefix apps/web install
```

### 2. 创建 D1 数据库与 KV 命名空间

```sh
cd apps/api
npx wrangler d1 create allclear-db
npx wrangler kv namespace create SNAPSHOT_KV
```

把两条命令各自输出的 `database_id` 与 `id` 填进 `apps/api/wrangler.jsonc`：

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "allclear-db", "database_id": "<你的 database_id>" }
],
"kv_namespaces": [
  { "binding": "SNAPSHOT_KV", "id": "<你的 KV id>" }
]
```

> 仓库里的 `wrangler.jsonc` 刻意不写 `account_id`，账号通过 `CLOUDFLARE_ACCOUNT_ID`
> 按环境提供。数据库名请保持 `allclear-db`；改成别的名字就要同步改
> `apps/api/package.json` 里的迁移脚本。

### 3. 应用数据库迁移

```sh
cd apps/api
npm run db:migrate:remote   # wrangler d1 migrations apply allclear-db --remote
```

### 4. 设置密钥

API Worker 读取两个密钥，用 Wrangler 写进 Worker：

```sh
cd apps/api
npx wrangler secret put INTERNAL_KEY          # web → api 的共享密钥，自己生成一个随机串
npx wrangler secret put UNSUBSCRIBE_HMAC_KEY  # 退订链接签名；不设则完全不发邮件
```

前端 Worker 读取 `INTERNAL_KEY`（与上面**同一个值**）和 `ADMIN_TOKEN`（你用来登录
`/admin` 的口令）。它的配置在 `cloudflare.config.ts` 而不是 `wrangler.jsonc`，这两个
密钥在**首次部署**时随部署一起写入，见下一步。

> 不要把密钥写在命令行参数里或用 `echo` 管道传递——它们会进入 shell 历史。用交互式
> 提示，或让 `--secrets-file` 指向一个仓库之外的文件。

### 5. 部署两个 Worker

先部署 API：

```sh
cd apps/api
npx wrangler deploy
```

再部署前端。**首次部署必须用 `cf` 并附带 secrets 文件**：`vinext-cloudflare deploy`
不会转发 `--secrets-file`，而 Worker 上这时还没有那两个密钥。

```sh
cd apps/web
npm run build

# 仓库之外，例如 ~/.config/allclear/web-secrets.env
cat > ~/.config/allclear/web-secrets.env <<'EOF'
INTERNAL_KEY=<与 API 相同的值>
ADMIN_TOKEN=<你的管理口令>
EOF

CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account> \
  npx cf deploy --prebuilt --secrets-file ~/.config/allclear/web-secrets.env
```

密钥已经存在 Worker 上之后，日常部署用普通命令即可：

```sh
cd apps/web && npm run deploy
```

> `cf` 与 Wrangler 是两套独立的凭据体系：`cf` 只认 `CLOUDFLARE_API_TOKEN` 或它自己的
> OAuth 登录，**不会复用** Wrangler 的会话。这条以及其余几条部署期的坑，完整记录在
> [M0 记录](docs/spec/m0-findings.md)。

### 6. 首次登录

打开 `https://<你的前端 Worker 域名>/admin`，用 `ADMIN_TOKEN` 登录。控制台里可以新建
页面、分区、组件与探测目标，之后状态页就会从探测结果生成内容。

> 部署是手动的，没有 CI 会在推送后自动发布。`git push` 成功**不代表**部署成功——要访问
> 线上 Worker 验证。

## 配置参考

| 位置 | 名称 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- | --- |
| `apps/api` | `DB` | D1 binding | 是 | 真相来源，所有实体与探测记录 |
| `apps/api` | `SNAPSHOT_KV` | KV binding | 是 | 已发布的快照 |
| `apps/api` | `INTERNAL_KEY` | secret | 是 | `/internal/*` 的共享密钥，空值等于关闭内部命名空间 |
| `apps/api` | `UNSUBSCRIBE_HMAC_KEY` | secret | 否 | 退订链接签名；不设则订阅可用但不发信 |
| `apps/api` | `PUBLIC_BASE_URL` | var | 建议 | 邮件与 Atom feed 里的绝对链接来源 |
| `apps/api` | `EMAIL_FROM` | var | 否 | 发信信封地址 |
| `apps/api` | `MAX_TARGETS_PER_RUN` | var | 否 | 每次 cron 处理的探测目标数，上限 20 |
| `apps/web` | `API` | Service Binding | 是 | 指向 `allclear-api` |
| `apps/web` | `INTERNAL_KEY` | secret | 是 | 与 API 侧同一个值 |
| `apps/web` | `ADMIN_TOKEN` | secret | 是 | `/admin` 的登录口令，空值等于拒绝一切管理操作 |
| `apps/web` | `DEFAULT_STATUS_SLUG` | var | 否 | 落地页链接到哪个状态页，默认 `example` |

## 架构

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

`allclear-api` **不暴露公网路由**。前端 Worker 通过 Service Binding 访问它，而「能连上」
不等于「有权限」——每个 `/internal/*` 路由还要额外校验共享的 `INTERNAL_KEY`。浏览器
永远接触不到任何管理凭据。

## 本地开发

**不接任何 Cloudflare 资源，先看一眼界面**——用 fixture Worker 提供数据，不需要 D1、
KV 或迁移：

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5219
```

打开 <http://localhost:5219/status/fixture> 即可。首次编译较慢，属正常。

**跑测试、类型检查与构建**：

```sh
npm run typecheck   # 先构建 packages/shared，再检查三个包
npm test            # 先 packages/shared（纯 Node），再 apps/api（真 workerd + 真 D1）
npm run build       # 先构建 packages/shared，再构建 apps/web
```

`apps/api` 的测试跑在**真实的 `workerd` 与真实 D1** 之上，不是 mock——这套设计依赖若干
具体的 SQLite 行为（`db.batch()` 的回滚语义、条件 `UPDATE` 匹配零行、偏唯一索引、
`meta.changes`），用 mock 只会把「我以为它这样」当成「它确实这样」。

在 `apps/api` 里改动 schema 后，本地应用迁移用 `npm run db:migrate:local`
（`wrangler d1 migrations apply allclear-db --local`）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/engineering.md](docs/engineering.md) | 架构、设计约束、读链、容量边界、安全姿态，以及验证边界 |
| [docs/spec/state-machine.md](docs/spec/state-machine.md) | 故障状态机 |
| [docs/spec/data-model.md](docs/spec/data-model.md) | 数据模型与 ID 角色分离 |
| [docs/spec/probe.md](docs/spec/probe.md) | 探测器调度、SSRF 约束、保留策略 |
| [docs/spec/uptime-math.md](docs/spec/uptime-math.md) | 可用率算法（区间扫描） |
| [docs/spec/snapshot.md](docs/spec/snapshot.md) | 快照契约与一致性边界 |
| [docs/spec/admin-api.md](docs/spec/admin-api.md) / [admin-ui.md](docs/spec/admin-ui.md) | 管理接口与控制台 |
| [docs/spec/subscriptions.md](docs/spec/subscriptions.md) | 订阅、退订与发信配额 |
| [docs/spec/testing.md](docs/spec/testing.md) | 测试如何组织，跑在什么之上 |
| [docs/spec/visual-parity.md](docs/spec/visual-parity.md) | 视觉验收记录与已知缺口 |
| [docs/spec/security-scan.md](docs/spec/security-scan.md) | 静态安全扫描记录（结论：不完整） |
| [docs/spec/m0-findings.md](docs/spec/m0-findings.md) | 在真实 Cloudflare 上的实测结论与绕行成本 |
| [AGENTS.md](AGENTS.md) | 本仓库的工作规则（分支、部署、密钥、许可） |

## 成熟度与已知限制

项目还没有发布过正式版本。下面几条在使用前值得知道，完整清单在
[工程文档](docs/engineering.md#verification-honesty)：

- 管理控制台与状态页目前**没有自动化测试**，也没有做过人工观感验收。
- 一次深度静态安全扫描的结论是 **inconclusive（不完整）**，因此本项目**不能被称为已
  通过安全审计**——记录见 [扫描记录](docs/spec/security-scan.md)。
- 状态页与探测器都跑在 Cloudflare 上：**Cloudflare 自身故障时，这套系统无法报告它**。
  要覆盖全平台故障，需要一个 Cloudflare 之外的探测来源，目前不在范围内，被记为风险而
  不是已解决的问题。

## 参与

目前主要是一个个人项目，Issue 和 PR 都欢迎。

`develop` 是开发分支，`main` 是发布分支，功能开发落在 `develop`，只有作为一次刻意的
发布动作才会合并进 `main`。详细规则见 [AGENTS.md](AGENTS.md)。

## 许可证

**GNU General Public License v3.0**（SPDX：`GPL-3.0-only`），全文见 [LICENSE](LICENSE)。

Copyright (C) 2026 ZhX589, ZYongX09

功能上受到成熟商业状态页产品的启发，但**本仓库的代码与素材全部原创**，没有复制任何
第三方的样式表、标记、文案、消息目录、logo 或图片。依赖项均为 GPL-3.0 兼容许可
（MIT / ISC / OFL / Apache-2.0）。
[OpenStatus](https://github.com/openstatusHQ/openstatus) 采用 **AGPL-3.0**，本项目未使用
其任何代码。
