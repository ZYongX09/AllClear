<div align="center">

# AllClear

**Open-source, self-hosted status pages and uptime monitoring.**

Keep users informed about service health, incidents, and recovery.

[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)
[![Project status: early preview](https://img.shields.io/badge/status-early_preview-orange.svg)](#operating-limits)

[简体中文](README.md) · **English**

[Deployment guide](docs/deployment.en.md) · [Features](#features) · [Preview](#preview) · [Contributing](#contributing)

</div>

## About AllClear

AllClear helps you publish a status page for websites, APIs, and other online services. Bring component health, incident updates, scheduled maintenance, and uptime history into one place. Configure HTTP(S) probes to record failures and recovery, and use the admin console to explain incidents to your users.

The project is for developers and teams who want to deploy their own instance, control their data, and adapt the software. It runs on Cloudflare without a long-running server or a separate status-page SaaS subscription. The services you monitor do not need to run on Cloudflare.

> **Early preview:** Read the [operating limits](#operating-limits) before deploying. Do not use AllClear as your sole production alerting source; in particular, validate the independent summary-cache, history-rollup, and email-delivery timing.

## Features

- **Public status pages:** Create multiple pages, organize components into sections, and display service health, incident timelines, and maintenance information.
- **HTTP(S) availability probes:** Configure request methods, expected status codes, and timeouts. Consecutive failure and recovery thresholds determine recorded outage intervals.
- **90-day uptime history:** Switch between bar, calendar, and table views. Uptime is calculated from measurement coverage and impact intervals; missing measurements remain unknown rather than counting as 100% uptime.
- **Incident communication:** Publish incidents, append progress updates, manage maintenance records, and share permanent links. Automatic probe impacts and manually published incidents are managed separately.
- **Subscriptions and integrations:** Atom feeds and JSON snapshots are available. Email subscriptions support component selection, double opt-in, and one-click unsubscribe, with separately configured email delivery.
- **Admin console:** Manage pages, sections, components, probe targets, and manual impacts; inspect public snapshots and usage budgets.
- **Languages and themes:** Public status pages support Simplified Chinese and English, with light, dark, and system themes and layouts for desktop and mobile. The admin console and emails currently use English.

## Preview

![AllClear public status page showing component health, uptime history, and an incident timeline](docs/images/status-page.png)

*The preview uses the repository's sample data, not the live status of a service.*

## Self-hosting

The supported deployment target is **Cloudflare Workers**, with D1 for application data and materialized live summaries, KV for fallback checkpoints, and Cron Triggers for scheduled probes. A custom domain is optional; you can start with a Cloudflare-provided `workers.dev` address.

### Prerequisites

- A Cloudflare account with a `workers.dev` subdomain configured under **Workers & Pages**.
- Git, **Node.js 22.12+** (Node.js 24 LTS recommended), and npm.
- An active DNS zone in the same Cloudflare account if you want a custom domain. Email notifications require a separately configured sending service.

### Get the source

```sh
git clone --branch develop https://github.com/ZYongX09/AllClear.git
cd AllClear

npm --prefix packages/shared ci
npm --prefix apps/api ci
npm --prefix apps/web ci
npm --prefix packages/shared run build
```

The current development version is on `develop`. After installing dependencies, follow the **[Cloudflare deployment guide](docs/deployment.en.md)** to:

1. Authenticate with Cloudflare and create your own D1 database and KV namespace.
2. Configure resource bindings, apply database migrations, and set the service key and admin passphrase.
3. Deploy the API Worker followed by the web Worker, with the correct Service Binding.
4. Sign in at `/admin`, configure a page and probe targets, then verify `/status/<slug>`.

The guide also covers the secrets file required for the first web deployment, domains, email setup, upgrades, and troubleshooting. Worker names, resource IDs, domains, and the default page can be changed for your deployment. Never reuse another instance's configuration or credentials.

Cloudflare's free allowances are not unlimited. Costs depend on requests, probe frequency, storage, and email delivery; review [platform pricing](https://developers.cloudflare.com/workers/platform/pricing/) and quotas for your expected usage.

## How it works

```text
Visitors / administrators
           │
           ▼
      Web Worker ── Service Binding ── API Worker ◀── Cron Triggers
  Status pages and console                 │
                                     ┌─────┴─────┐
                                     D1         KV
                                Data +       Fallback
                                summaries    checkpoints
```

The web Worker handles presentation and admin interactions. The API Worker manages data, probes, and snapshot publication. The API has no public route by default, and admin requests also require a shared service key. Public pages normally read a materialized D1 summary or its 30-second hot cache; KV is unconfirmed fallback only. Default probes remain 60 seconds with 120-second freshness, history rolls up every 300 seconds, budgeted two-key KV checkpoints are due every 600 seconds, and retention runs daily. Assembly, history-computation, and probe times are distinct; admin writes do not promise globally simultaneous visibility.

Built with **TypeScript, React, Next.js / vinext, Hono, Tailwind CSS, Cloudflare Workers, D1, and KV**. See the [engineering notes](docs/engineering.md) for architecture and consistency details.

## Documentation

| Document | When to use it |
| --- | --- |
| [Deployment guide](docs/deployment.en.md) / [简体中文](docs/deployment.md) | Initial setup, resources and secrets, domains, upgrades, and troubleshooting |
| [Engineering notes](docs/engineering.md) | Architecture, read paths, capacity, and verification boundaries |
| [Probes](docs/spec/probe.md) · [Uptime calculation](docs/spec/uptime-math.md) | Scheduling, failure detection, and the meaning of historical data |
| [Admin API](docs/spec/admin-api.md) · [Admin UI](docs/spec/admin-ui.md) | Extending the console or using internal management endpoints |
| [Subscriptions](docs/spec/subscriptions.md) · [Snapshot contract](docs/spec/snapshot.md) | Integrating notifications or consuming public data |

## Local development

After installing dependencies, preview the UI with sample data without creating Cloudflare resources:

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5219
```

Open <http://localhost:5219/status/fixture>. This mode is for UI development only: it does not run real probes, persist production data, or deliver email. See [`apps/web/README.md`](apps/web/README.md) for details.

Run checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
```

Stop the preview server before building to avoid concurrent writes to the build directories. Shared logic and API tests use Node.js and a local `workerd` / D1 environment respectively; they do not apply remote database migrations.

## Operating limits

- **Update timing:** Admin writes update the D1 summary immediately server-side, but hot caches across locations can retain the previous summary for up to 30 seconds. History rollups and budgeted KV fallback checkpoints update independently. Successful observations now refresh live evidence without requiring an impact transition. Production freshness and free-tier capacity remain unvalidated; see [known issues](docs/deployment.en.md#known-issues).
- **Probe scale:** The current supported deployment budget is 20 enabled targets, with a minimum interval of 60 seconds and one enabled target per component. Probes run from Cloudflare, not an independent multi-region consensus network.
- **Notifications:** Probe-generated impacts do not automatically create timeline incidents or send incident emails. Email delivery requires a real sending binding; the default configuration does not deliver confirmation messages.
- **Admin access:** The console uses a shared admin passphrase, not a multi-user role and permission system.
- **Availability boundary:** The status page and prober share Cloudflare and cannot independently observe a platform-wide Cloudflare outage.

AllClear is early-stage software. Production end-to-end acceptance is incomplete, and the project should not be described as having passed a complete security audit. Test coverage and outstanding verification are documented in the [engineering notes](docs/engineering.md#verification-honesty).

## Contributing

[Issues](https://github.com/ZYongX09/AllClear/issues) for bug reports and feature discussions, and [pull requests](https://github.com/ZYongX09/AllClear/pulls), are welcome.

- Include reproduction steps, deployment details, and relevant logs when reporting a problem. Remove secrets, email addresses, and other sensitive information.
- Discuss substantial changes first. Target `develop` with pull requests, and run type checks, tests, and the build.
- Keep deployment configuration generic. Do not commit personal account, database, domain, or credential values.

See [AGENTS.md](AGENTS.md) for development and release conventions.

## License

AllClear is licensed under the **GNU General Public License v3.0 only** (SPDX: `GPL-3.0-only`). Use, modification, and redistribution are subject to [LICENSE](LICENSE). Third-party dependencies retain their respective licenses.

Copyright (C) 2026 ZhX589, ZYongX09.
