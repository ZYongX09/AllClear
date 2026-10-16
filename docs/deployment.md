# Cloudflare 部署指南

[返回 README](../README.md) · **简体中文** · [English](deployment.en.md)

本指南说明如何从源码将 AllClear 部署到自己的 Cloudflare 账号，包括首次安装、资源绑定、域名、邮件和后续更新。当前使用命令行手动部署，不需要配置 GitHub Actions。示例名称均可调整，不依赖项目作者的 Cloudflare 资源。

> AllClear 仍是早期版本。请先了解[已知问题](#已知问题)，并在对外使用前完成自己环境中的端到端验证。以下步骤是部署流程，不代表完整系统已经通过生产验收。

## 1. 准备环境与源码

需要准备：

- 一个 Cloudflare 账号。进入 **Workers & Pages**，按提示设置账号的 `workers.dev` 子域；即使 API 不公开，也应先完成该设置再注册定时触发器。
- Git、Node.js 22.12+ 和兼容的 npm，推荐 Node.js 24 LTS 的最新维护版本。项目使用的 vinext / cf 工具链不支持 Node.js 20。
- 若使用自定义域名，需要同一账号下已激活的 Cloudflare DNS zone。域名不是首次部署的必要条件。

```sh
git clone --branch develop https://github.com/ZYongX09/AllClear.git
cd AllClear

npm --prefix packages/shared ci
npm --prefix apps/api ci
npm --prefix apps/web ci
npm --prefix packages/shared run build
```

各包独立安装依赖，请使用随源码提交的 lockfile。仓库根目录没有 npm workspaces 安装入口。API 与前端都依赖共享包的构建产物，不要跳过最后一步。

**本文后续命令都从仓库根目录执行。** 命令中的括号会在子目录中执行操作，不改变当前终端目录。

### Cloudflare 登录

API 使用 Wrangler，前端使用 `cf`，二者的交互登录凭据不互通：

```sh
(cd apps/api && npx wrangler login)
(cd apps/web && npx cf auth login)
```

多个账号时，显式指定目标账号，并在后续命令中保留这个环境变量：

```sh
export CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id"
```

无浏览器或自动化环境也可以通过安全的环境变量配置方式提供 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，供两套工具使用。令牌需要有目标账号内 Workers、D1、KV 等部署所需权限；绑定自定义域名还涉及目标 zone。将令牌限制到实际使用的账号和资源，不要写入源码、文档、命令参数或 shell 历史。参见 [Cloudflare API 令牌说明](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)。

## 2. 创建存储资源

```sh
(cd apps/api && npx wrangler d1 create allclear-db)
(cd apps/api && npx wrangler kv namespace create SNAPSHOT_KV)
```

编辑 [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc)，用命令输出替换以下占位符：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "allclear-db",
    "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
  }
],
"kv_namespaces": [
  {
    "binding": "SNAPSHOT_KV",
    "id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
  }
]
```

ID 必须来自你自己的账号。配置中的 `DB`、`SNAPSHOT_KV` 是代码读取的绑定名，应保持不变；数据库和 Worker 的资源名称可以更改。

### 同一账号部署多个实例

每个实例使用独立的数据库、KV、Worker 名称与密钥，避免共享生产数据。需要同步修改：

| 配置 | 默认值 | 修改位置 |
| --- | --- | --- |
| API Worker 名称 | `allclear-api` | `apps/api/wrangler.jsonc` 的 `name` |
| 前端 Worker 名称 | `allclear-web` | `apps/web/cloudflare.config.ts` 的 `worker.name` |
| 前端指向的 API | `allclear-api` | 同文件的 `API: bindings.worker({ worker: ... })` |
| D1 数据库名称 | `allclear-db` | `apps/api/wrangler.jsonc` 的 `database_name` |

本指南的迁移命令使用绑定名 `DB`，因此不依赖数据库名称。`apps/api/package.json` 中现有 `db:migrate:*` 快捷脚本使用默认名称；自定义名称时，请同步修改脚本或继续使用本指南的绑定名命令。

## 3. 初始化数据库与 API 密钥

```sh
(cd apps/api && npx wrangler d1 migrations apply DB --remote)
(cd apps/api && npx wrangler secret put INTERNAL_KEY)
```

`secret put` 会交互式要求输入密钥。如果提示 Worker 不存在，确认创建目标名称的 Worker，再继续后续部署。

使用密码管理器或安全随机数生成器生成 `INTERNAL_KEY`，并保存好它：前端稍后必须配置**同一个值**。另生成独立的 `ADMIN_TOKEN` 作为控制台登录口令，不要与服务间密钥共用。

迁移会创建一个示例页面 `example`（显示名为 “Example Service”）及示例组件，**不会创建任何真实探测目标或管理员凭据**。初始未知状态不表示服务已经通过检测。请使用 Wrangler 的迁移命令，不要手工重复执行 SQL 文件；其中的结构迁移并非全部幂等。

## 4. 部署 API Worker

```sh
(cd apps/api && npm run deploy)
```

默认配置保持 `workers_dev: false`，也不声明公网路由。API 由前端通过 Service Binding 调用，不需要给它绑定域名或为了排障将管理接口暴露到公网。

该配置同时注册每分钟触发一次的 Cron Trigger。Cloudflare 定时触发器使用 UTC，新增或修改后可能需要最多 15 分钟生效。在控制台的 Worker 定时触发器、Cron Events 或日志中检查执行情况，而不是把部署成功当作探测已执行。参见 [Cron Triggers 文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 5. 首次部署前端 Worker

前端配置位于 [`apps/web/cloudflare.config.ts`](../apps/web/cloudflare.config.ts)，不是 API 的 `wrangler.jsonc`。确认 `API` 指向刚部署的 API Worker。

使用文本编辑器在仓库外创建私有文件，例如 `$HOME/.config/allclear/web-secrets.env`（先创建所需目录），内容为：

```dotenv
INTERNAL_KEY=REPLACE_WITH_THE_SAME_API_INTERNAL_KEY
ADMIN_TOKEN=REPLACE_WITH_A_SEPARATE_RANDOM_ADMIN_PASSPHRASE
```

上面的值是占位符，必须替换。限制文件权限，不要提交或分享此文件：

```sh
chmod 600 "$HOME/.config/allclear/web-secrets.env"
```

首次部署需要同时写入密钥。当前项目的 `vinext-cloudflare deploy` 不转发 `--secrets-file`，因此先构建，再直接使用 `cf`：

```sh
(cd apps/web && npm run build)
(cd apps/web && npx cf deploy --prebuilt \
  --secrets-file "$HOME/.config/allclear/web-secrets.env")
```

部署输出会给出前端地址，通常形如 `https://allclear-web.<your-subdomain>.workers.dev`。后续普通部署可以使用 `npm --prefix apps/web run deploy`；已有远程密钥会保留。轮换密钥时，更新私有 secrets 文件，再执行上述构建与部署命令。

本地 `.dev.vars` 不会代替远程 secret 配置；Wrangler 登录也不会代替 `cf` 登录。

## 6. 配置页面并验证

1. 访问前端地址的 `/admin`，输入 `ADMIN_TOKEN` 登录。
2. 编辑示例页面或新建页面，添加分区、组件和探测目标。目标必须是允许公开访问的 HTTP(S) 服务。
3. 等待定时触发器生效后，在控制台检查探测记录。必要时在页面详情的 **Page → Rebuild snapshot** 手动重建公开快照。
4. 访问以下地址，核对页面内容与机器可读结果：

| 地址 | 用途 |
| --- | --- |
| `/` | 项目首页及默认状态页入口 |
| `/admin` | 管理控制台 |
| `/status/example` | 示例页面；自建页面时替换为自己的 slug |
| `/status/example/snapshot.json` | 公开 JSON 快照及来源、陈旧标记 |
| `/status/example/feed.xml` | Atom 订阅源 |

`/api/hello` 只能证明前端 Worker 可以响应，不能证明 D1、KV、Service Binding 或探测器工作正常。JSON 快照使用 `ReadResult` 封装，不是单个状态值；集成时请查阅[快照契约](spec/snapshot.md)。

如果新页面使用不同的 slug，修改前端配置中的 `DEFAULT_STATUS_SLUG: bindings.text("your-page-slug")`，然后重新构建、部署前端。这只改变首页链接，不会创建或重命名数据库中的页面。

将 API 配置中的 `PUBLIC_BASE_URL` 设置为前端的规范来源，例如 `https://status.example.com` 或实际的 `workers.dev` 地址，然后重新部署 API。不要填写 API 地址、`/status/example` 路径或带查询参数的 URL。

> **重要**：页面未知不一定等于探测故障。未配置目标、未产生观测、观测已过期，以及下文的快照刷新缺口，都可能导致未知。浏览器刷新不会强制重建服务端快照。

## 配置参考

### API Worker：`apps/api/wrangler.jsonc` 与 secrets

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 binding | 页面、组件、事件、订阅和探测数据；必需 |
| `SNAPSHOT_KV` | KV binding | 已发布的公开快照；必需 |
| `INTERNAL_KEY` | secret | 保护内部接口；必需，与前端一致 |
| `PUBLIC_BASE_URL` | var | 前端的绝对来源；确认邮件和事件邮件需要它 |
| `MAX_TARGETS_PER_RUN` | var | 每次触发处理的目标上限，默认 `"20"`，最大 20 |
| `EMAIL` | `send_email` binding | 可选；真实邮件投递，默认不配置 |
| `EMAIL_FROM` | var | 邮件信封发件人；启用邮件时替换默认的 `status@localhost` |
| `UNSUBSCRIBE_HMAC_KEY` | secret | 签署退订链接；启用事件通知时必需 |

### 前端 Worker：`apps/web/cloudflare.config.ts` 与 secrets

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `API` | Service Binding | 指向自己的 API Worker；必需 |
| `INTERNAL_KEY` | secret | 与 API 相同的服务间密钥；必需 |
| `ADMIN_TOKEN` | secret | 独立的管理口令，同时用于会话校验；必需 |
| `DEFAULT_STATUS_SLUG` | text binding | 首页状态页入口，默认 `example` |
| `ASSETS` / `IMAGES` | 平台集成绑定 | 构建工具管理，不需要手工创建 D1/KV 式资源 |

普通变量属于版本化配置，请优先在对应文件中修改并重新部署；不要仅在控制台修改后又被下一次源码部署覆盖。密钥通过 secret 机制管理，不放入 `vars`。

## 自定义域名

首次验证可先使用 `workers.dev`。准备好同账号下的有效 DNS zone 后，在前端的 `defineWorker({ ... })` 中添加以下字段，保留其他配置：

```ts
name: "allclear-web",
domains: ["status.example.com"],
```

替换为自己的主机名，确保不存在冲突的 CNAME，然后重新构建并部署前端。这里使用的是 `cf` 的 typed config，**不要把 Wrangler 的 `routes` JSON 直接粘贴到这个文件中**。如需同时保留 `workers.dev` 地址，可显式设置 `workersDev: true`。

域名变更后，将 API 的 `PUBLIC_BASE_URL` 同步为新的规范来源并重新部署 API。参见 [Cloudflare Worker 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 可选：启用邮件订阅

订阅相关逻辑已经实现，但默认配置**不投递邮件**。没有 `EMAIL` 绑定时，API 使用仅记录结果的发送器；页面显示请求已接收不代表确认邮件已经送达。未配置 `PUBLIC_BASE_URL` 时，订阅请求会被拒绝。

如需真实投递：

1. 按照 [Cloudflare Email Service 发信指南](https://developers.cloudflare.com/email-service/get-started/send-emails/)在账号中开通发信，并完成域名及 DNS 配置。
2. 确认当前套餐与收件人策略适用于你的场景。免费向已验证地址发送与向任意订阅者发送不是同一能力；不要假定免费 Email Routing 就能覆盖公开邮件列表。参见 [Email Service 说明](https://developers.cloudflare.com/email-service/)。
3. 在 API 的 `wrangler.jsonc` 顶层添加绑定，并将 `EMAIL_FROM` 改成已开通域名的发件地址：

   ```jsonc
   "send_email": [{ "name": "EMAIL" }]
   ```

4. 设置真实的 `PUBLIC_BASE_URL`，并通过交互提示创建独立的退订签名密钥：

   ```sh
   (cd apps/api && npx wrangler secret put UNSUBSCRIBE_HMAC_KEY)
   (cd apps/api && npm run deploy)
   ```

5. 使用自己控制的真实邮箱验证完整链路：提交订阅、收到并点击确认邮件、发布人工事件、收到通知、退订。不要只检查 HTTP 成功码。

当前实现使用 `cloudflare:email` 的 `EmailMessage`，官方 [Workers API 文档](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)说明该接口仍向后兼容；AllClear 在你账号中的实际投递仍需上述验证。其他邮件提供商需要实现项目的发送适配器，不能仅填写一个 API key 即接入。

代码默认预算为每个 UTC 日 2,000 次发信尝试，每次事件通知最多处理 500 个匹配订阅者；预算与确认邮件共用，没有排队补发保证。这些是应用预算，不是服务商的免费额度。自动探测故障本身不会触发事件邮件。

## 更新已有部署

1. 记录当前部署版本，并用自己的私有位置备份配置与密钥。结构迁移前先备份远程 D1：

   ```sh
   (cd apps/api && npx wrangler d1 export DB --remote \
     --output /absolute/private/path/allclear-before-upgrade.sql)
   ```

   备份可能包含订阅邮箱等敏感数据，请放在仓库之外。

2. 获取目标版本，先阅读差异和迁移说明；保留自己实例的绑定、域名与变量，不要用模板覆盖真实配置。当前源码跟踪 `develop`，不应把 `main` 分支的存在误认为已有稳定发布。
3. 按第 1 节重新执行三个包的 `npm ci` 并构建共享包，再执行：

   ```sh
   npm run typecheck
   npm test
   npm run build
   (cd apps/api && npx wrangler d1 migrations apply DB --remote)
   (cd apps/api && npm run deploy)
   (cd apps/web && npm run deploy)
   ```

4. 重新核对公开页面、JSON、控制台、探测与邮件链路。数据库变更不会随 Worker 代码回滚而自动撤销，回退前必须检查兼容性。

源码推送不会自动发布本仓库的 Worker；如果自行增加 CI，请复用相同的配置、迁移顺序与 secret 管理方式。

## 已知问题

### 持续成功的探测可能未刷新公开快照

静态追踪当前发布路径发现：探测写入观测后，定时任务只为产生故障区间开关的页面发布快照；持续健康的观测和可用率更新可能未同步到已有快照。版本未变化时，修复任务也可能跳过重建。因此，初次成功或后续持续成功不一定体现在公开页面，旧观测可能过期为未知。

该问题由源码检查发现，尚未作为运行场景复现。临时可在 `/admin/pages/<slug>` 的 **Page → Rebuild snapshot** 手动刷新；它只能验证当前数据，不修复持续发布。不要将反复手动重建当作生产监控方案，也不要以此承诺持续更新或精确告警时效。

相关实现：[探测结果](../apps/api/src/probe/run.ts)、[调度与发布](../apps/api/src/index.ts)、[快照读取](../apps/api/src/snapshot.ts)。

### 容量与操作边界

- 每个部署按最多 20 个启用目标设计，跨所有页面共享，每次调度最多处理 20 个到期目标；并非创建第 21 个目标时一定会被拒绝，超出后可能造成排队和延迟。每个组件最多启用一个目标，间隔至少 60 秒。
- 探测支持公网 HTTP(S) GET / HEAD、80 / 443 端口，不跟随重定向。控制台暴露基础设置，预期状态码、超时和阈值等高级配置通过内部管理 API 提供。不要开放探测目标编辑权限给不可信用户。
- 维护记录需要操作员推进状态；计划时间字段不等于自动开始或结束维护。
- 控制台使用共享管理员口令；公开页支持中英双语，但控制台和邮件目前使用英文。
- 后端与共享逻辑有自动化测试，前端尚无自动化回归覆盖。完整验证边界见[工程文档](engineering.md#verification-honesty)。

## 常见问题

**部署时出现资源不存在或占位符相关错误。** 先确认 D1 / KV ID 已替换，资源属于当前账号，`CLOUDFLARE_ACCOUNT_ID` 正确。不要直接重试未改动的模板配置。

**Wrangler 已登录，但前端仍提示未认证。** 在 `apps/web` 下完成 `npx cf auth login`，或让两套工具使用相同的安全环境变量。前端首次发布还需要 secrets 文件。

**控制台拒绝登录或管理操作。** 检查前端是否实际配置了 `ADMIN_TOKEN`，两端 `INTERNAL_KEY` 是否一致，Service Binding 是否指向正确的 API。修改管理口令会使原有会话失效。

**探测没有执行，或状态始终未知。** 检查 Cron Trigger 的生效时间、Worker 日志、目标 URL 和 last-check 数据，再检查已知的快照刷新问题。`localhost`、内网地址、带凭据的 URL 或重定向端点不适合作为目标；不要通过关闭地址校验解决配置错误。

**邮件订阅提交成功，但没有收到确认邮件。** 检查是否仍在使用默认的非投递发送器，以及发信绑定、域名、发件地址、收件人策略、公开来源、配额和日志；不要把订阅请求成功等同于邮件成功。

**本地构建结果异常。** 停止 fixture 预览或其他前端开发服务，再构建。二者会写入相同的 `.vinext` / `.cloudflare` 输出目录。
