<div align="center">

# AllClear

**开源、自部署的状态页与可用性监控。**

让用户了解服务状态，让团队掌握故障与恢复。

[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)
[![Project status: early preview](https://img.shields.io/badge/status-early_preview-orange.svg)](#运行限制)

**简体中文** · [English](README.en.md)

[部署指南](docs/deployment.md) · [功能特性](#功能特性) · [界面预览](#界面预览) · [参与贡献](#参与贡献)

</div>

## 关于 AllClear

AllClear 帮助你为网站、API 或其他在线服务建立公开状态页，将组件状态、故障进展、维护安排和可用率历史集中展示。你可以配置 HTTP(S) 探测来记录服务的失败与恢复，也可以通过管理控制台发布事件更新，向用户解释发生了什么。

项目面向希望自行部署、管理数据并按需修改的个人开发者和团队。运行环境基于 Cloudflare，无需维护常驻服务器，也无需购买独立的状态页 SaaS。被监控的服务不需要托管在 Cloudflare 上。

> **早期版本**：部署前请阅读[运行限制](#运行限制)。目前不应将 AllClear 作为唯一的生产告警来源；持续探测的快照刷新及邮件投递配置尤其需要注意。

## 功能特性

- **公开状态页**：支持多个页面，按分区组织服务组件，展示当前状态、事件时间线与维护信息。
- **HTTP(S) 可用性探测**：配置请求方法、预期状态码和超时，通过连续失败与恢复阈值记录故障区间。
- **90 天可用率历史**：提供条形、日历与表格视图；可用率根据观测覆盖和影响区间计算，缺少测量时显示未知，而不是默认计为 100%。
- **事件沟通**：在控制台创建事件、追加进展、管理维护记录，并通过固定链接分享更新。自动探测影响与人工发布的事件分别管理。
- **订阅与集成**：提供 Atom 订阅源和 JSON 快照；邮件订阅支持按组件选择、双重确认与一键退订，需另行配置邮件投递。
- **管理控制台**：集中管理页面、分区、组件、探测目标及手工影响，查看公开快照和用量预算。
- **多语言与主题**：公开状态页支持简体中文与英文，提供浅色、深色及跟随系统主题，适配桌面与移动端。管理控制台与邮件目前使用英文。

## 界面预览

![AllClear 公开状态页：组件状态、可用率历史与事件时间线](docs/images/status-page.png)

*预览使用仓库中的示例数据，不代表某个服务的实际运行状态。*

## 自行部署

当前提供 **Cloudflare Workers** 部署方式，使用 D1 保存业务数据、KV 保存公开快照，通过 Cron Triggers 执行定时探测。自定义域名可选；首次部署可以使用 Cloudflare 提供的 `workers.dev` 地址。

### 准备条件

- 一个 Cloudflare 账号，并在 **Workers & Pages** 中设置好 `workers.dev` 子域。
- Git、**Node.js 22.12+**（推荐 Node.js 24 LTS）与 npm。
- 如需自定义域名，准备同一 Cloudflare 账号内的有效 DNS zone；如需邮件通知，另行配置发信服务。

### 获取项目

```sh
git clone --branch develop https://github.com/ZYongX09/AllClear.git
cd AllClear

npm --prefix packages/shared ci
npm --prefix apps/api ci
npm --prefix apps/web ci
npm --prefix packages/shared run build
```

当前开发版本位于 `develop`。安装后，按照 **[Cloudflare 部署指南](docs/deployment.md)** 完成以下配置：

1. 登录 Cloudflare，创建自己的 D1 数据库与 KV 命名空间。
2. 填写资源绑定，应用数据库迁移，设置服务间密钥与管理员口令。
3. 依次部署 API Worker 与前端 Worker，确认 Service Binding 指向正确。
4. 登录 `/admin`，配置页面和探测目标，再访问 `/status/<slug>` 验证结果。

指南同时包含首次部署所需的前端 secrets 文件、域名与邮件配置、更新流程和常见问题。Worker 名称、资源 ID、域名及默认页面均可按部署环境调整；不要使用其他实例的配置或凭据。

Cloudflare 的免费额度不等于无限用量。实际费用取决于请求、探测频率、存储及邮件服务，请根据自己的规模核对[平台定价](https://developers.cloudflare.com/workers/platform/pricing/)与配额。

## 工作方式

```text
访问者 / 管理员
       │
       ▼
前端 Worker ── Service Binding ── API Worker ◀── 定时触发器
状态页与控制台                     │
                             ┌────┴────┐
                             D1        KV
                          业务数据   公开快照
```

前端负责展示页面与管理交互，API 负责数据、探测和快照发布。API 默认不开放公网路由；管理请求还需要服务间密钥。公开页面从快照读取数据，在数据过期或不可用时展示相应状态。

主要技术：**TypeScript、React、Next.js / vinext、Hono、Tailwind CSS、Cloudflare Workers、D1、KV**。架构与一致性说明见[工程文档](docs/engineering.md)。

## 文档

| 文档 | 适合什么时候阅读 |
| --- | --- |
| [部署指南](docs/deployment.md) / [English](docs/deployment.en.md) | 首次部署、配置资源与密钥、绑定域名、升级和排障 |
| [工程文档](docs/engineering.md) | 了解架构、数据读取链、容量和验证边界 |
| [探测器](docs/spec/probe.md) · [可用率计算](docs/spec/uptime-math.md) | 了解探测调度、失败判定与历史数据的含义 |
| [管理接口](docs/spec/admin-api.md) · [管理界面](docs/spec/admin-ui.md) | 扩展控制台或使用内部管理接口 |
| [订阅机制](docs/spec/subscriptions.md) · [快照契约](docs/spec/snapshot.md) | 接入通知或读取公开数据 |

## 本地开发

完成依赖安装后，可以先用示例数据预览界面，不需要创建 Cloudflare 资源：

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5219
```

打开 <http://localhost:5219/status/fixture>。此模式仅用于界面开发，不会执行真实探测、保存生产数据或投递邮件。完整前端说明见 [`apps/web/README.md`](apps/web/README.md)。

在仓库根目录运行检查：

```sh
npm run typecheck
npm test
npm run build
```

构建前请停止上述预览服务，避免同时写入构建目录。共享逻辑与 API 测试分别使用 Node.js 和本地 `workerd` / D1 运行环境，不会执行远程数据库迁移。

## 运行限制

- **监控快照刷新**：静态检查发现，持续成功的探测可能不会刷新已发布快照，公开页面因此可能显示陈旧数据或未知状态。当前可在控制台手动重建快照；这不是持续监控的替代方案，详见[部署指南的已知问题](docs/deployment.md#已知问题)。
- **探测规模**：当前支持范围按每个部署最多 20 个启用目标设计，最小间隔 60 秒；每个组件最多启用一个目标。探测来自 Cloudflare，不提供独立的多地域探测共识。
- **通知范围**：探测故障区间不会自动创建时间线事件或发送事件邮件。邮件投递需配置实际发信绑定；默认配置不会送达确认邮件。
- **管理权限**：控制台使用共享管理员口令，不提供多用户角色与权限体系。
- **可用性边界**：状态页与探测器共用 Cloudflare，无法作为 Cloudflare 全平台故障的独立观测来源。

项目尚处于早期阶段，未完成生产环境端到端验收，也不应被视为已通过完整安全审计。具体测试覆盖和待验证事项保留在[工程文档](docs/engineering.md#verification-honesty)中。

## 参与贡献

欢迎通过 [Issues](https://github.com/ZYongX09/AllClear/issues) 报告问题、讨论需求，也欢迎提交 [Pull Request](https://github.com/ZYongX09/AllClear/pulls)。

- 报告问题时，请附上复现步骤、部署方式和相关日志，并移除密钥、邮箱及其他敏感信息。
- 贡献代码前建议先讨论较大的变更；Pull Request 请以 `develop` 为目标分支，并运行类型检查、测试和构建。
- 部署配置请保留通用占位符，不要提交个人账号、数据库、域名或凭据。

开发与发布约定见 [AGENTS.md](AGENTS.md)。

## 许可证

AllClear 使用 **GNU General Public License v3.0 only**（SPDX：`GPL-3.0-only`）。使用、修改或再分发时，请遵守 [LICENSE](LICENSE) 中的条款。第三方依赖保留各自的许可证。

Copyright (C) 2026 ZhX589, ZYongX09.
