<div align="center">

# allclear

**A status page and basic availability monitor for Cloudflare's serverless platform**

Public status page · automatic probing · uptime computed from real measurements

[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Deployed](https://img.shields.io/badge/deployed-no-lightgrey.svg)](#status)

[中文](README.md) · [Engineering notes](docs/engineering.md) · [Specifications](docs/spec/)

</div>

---

## What this is

`allclear` gives you a public status page — component tree, incident timeline, 90-day
uptime history, email subscriptions, zh-CN/en-US, dark mode — backed by **real
measurement**. Scheduled probes record what actually happened, and uptime percentages
are computed from those recorded impacts rather than typed in by hand.

It depends on no hosted service. The whole thing runs in your own Cloudflare account:
two Workers, one D1 database, one KV namespace. Probe targets are configured and
reviewed by an administrator and point at your own endpoints.

![Status page screenshot](docs/images/status-page.png)

> The screenshot above was rendered locally from the project's own fixture data
> (`apps/web/verify/`). **Nothing is deployed**, so there is no screenshot of a live
> instance. The fixture data is deliberately awkward: a fresh probe, a stale probe, a
> component with no probe at all, an open incident, and a scheduled maintenance window
> that must not paint its component.

## Features

### Public status page (`/status/:slug`)

- **Component tree** grouped into sections, with each component's status derived at
  read time.
- **Incident and maintenance timeline** with expandable entries and deep links
  (`#change-<public_id>` jumps straight to one).
- **90-day uptime history** in three views: bar strip, month calendar, table.
- **Email subscriptions** with per-component scoping, double opt-in, and RFC 8058
  one-click unsubscribe.
- **zh-CN / en-US, dark mode**, responsive down to 375px.
- **Atom feed** (`/status/:slug/feed.xml`) and a machine-readable
  `/status/:slug/snapshot.json`.

### Automatic availability probing

- Admin-configured HTTP probes on a per-minute scheduler.
- A **persisted state machine** with failure and recovery thresholds, so a single
  failed request does not open a public incident.
- Probe transitions open and close `impact` intervals automatically, preserving the
  real observation timestamps.

### Admin console (`/admin`)

- Page, section, component, probe target, change and manual-impact management.
- A **budget panel** showing probe-target and daily-email headroom.
- A **snapshot panel** that reads the *public* endpoint, so a stale snapshot is
  discoverable from the console.

### Uptime computed from recorded data

Both probe transitions and hand-entered impacts are producers of `impact` intervals,
so the availability percentage is always derived from what was actually recorded.
There is no path that writes a percentage by hand.

## Explicit non-goals

Deliberately excluded, to keep the scope from drifting:

- On-call schedules and alert escalation
- Hundreds of service integrations
- Real-user monitoring (RUM)
- AI/LLM-based incident analysis
- Multi-tenant SaaS, billing, or per-customer accounts

This is a status page and a basic monitor. It is not a replacement for a full
incident-management platform.

## Architecture

Two Workers plus a shared pure-function package.

```
                    ┌─────────────────────────────┐
   browser ────────▶│  allclear-web               │
                    │  Next.js (vinext)           │
                    │  • public status page       │
                    │  • /admin console           │
                    │  • Server Actions (writes)  │
                    └───────────┬─────────────────┘
                                │  Service Binding
                                │  + X-Internal-Key
                                ▼
                    ┌─────────────────────────────┐
   cron ───────────▶│  allclear-api               │
                    │  Hono Worker                │
                    │  • public read API          │
                    │  • /internal/admin/*        │
                    │  • probe scheduler          │
                    └───────────┬─────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
                 D1 (source of truth)    KV (published snapshots)
```

`allclear-api` is deployed with **no public route**. The web Worker reaches it over a
Service Binding, and that reachability is *not* treated as authentication — every
`/internal/*` route additionally requires a shared `INTERNAL_KEY`.

## Getting started

```sh
git clone https://github.com/ZYongX09/AllClear
cd AllClear

# each package installs its own dependencies (this is not an npm workspaces monorepo)
npm --prefix packages/shared install
npm --prefix apps/api install
npm --prefix apps/web install
```

**Look at the UI without any Cloudflare resources:**

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5219
```

This serves the UI against fixture Workers, so it renders with no D1, no KV and no
migrations. Open <http://localhost:5219/status/fixture>. The first compile is slow;
that is expected.

**Test and type-check:**

```sh
npm run typecheck   # builds packages/shared, then type-checks all three packages
npm test            # packages/shared (pure Node), then apps/api (real workerd + D1)
npm run build       # builds packages/shared, then apps/web
```

`apps/api` tests run against a **real `workerd` runtime with a real D1 binding**, not
mocks — the design depends on specific SQLite behaviours (`db.batch()` rollback
semantics, conditional `UPDATE` matching zero rows, partial unique indexes,
`meta.changes`), and mocks would assert beliefs about those behaviours instead of the
behaviours themselves.

**Deployment is manual** — there is no CI pipeline that publishes on push:

```sh
cd apps/api && npm run deploy
cd apps/web && npm run deploy
```

A successful `git push` is **not** evidence of a successful deployment. Verify by
hitting the deployed Worker.

## Tech stack

Cloudflare Workers · D1 · KV · Service Bindings · Hono 4 · Next.js 16 (vinext) ·
React 19 · Vite 8 · Tailwind CSS 4 · Radix UI · `next-intl` · `next-themes` ·
lucide · Inter.

## Status

**M0–M5 are built and verified locally. Nothing is deployed.**

```sh
npm run typecheck   # exit 0
npm test            # 294 passing (shared 82 / api 212)
npm run build       # exit 0
```

Those numbers measure the **local build and test suite**, not production. The full
verified/not-verified list lives in the
[engineering notes](docs/engineering.md#verification-honesty), and it includes gaps
worth not glossing over: neither the admin console nor the status page has automated
tests, and no human-perspective visual review has happened. A deep static security
scan also came back **inconclusive**, so **this project must not be described as
security-audited**.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/engineering.md](docs/engineering.md) | Architecture, design commitments, the read chain, capacity boundaries, security posture, and the verification boundary |
| [docs/spec/state-machine.md](docs/spec/state-machine.md) | Fault state machine and data model |
| [docs/spec/probe.md](docs/spec/probe.md) | Probe scheduling, SSRF constraints, retention |
| [docs/spec/uptime-math.md](docs/spec/uptime-math.md) | The uptime algorithm (interval sweep) |
| [docs/spec/snapshot.md](docs/spec/snapshot.md) | Snapshot contract and consistency boundary |
| [docs/spec/admin-api.md](docs/spec/admin-api.md) / [admin-ui.md](docs/spec/admin-ui.md) | Admin API and console |
| [docs/spec/subscriptions.md](docs/spec/subscriptions.md) | Subscriptions, unsubscribe, send quota |
| [docs/spec/visual-parity.md](docs/spec/visual-parity.md) | Visual verification record and its known gaps |
| [docs/spec/m0-findings.md](docs/spec/m0-findings.md) | What M0 actually observed on real Cloudflare infrastructure |
| [AGENTS.md](AGENTS.md) | Working rules for this repository (branches, deployment, secrets, licensing) |

## Known single point of failure

The status page and the prober both run on Cloudflare. **If Cloudflare itself is down,
this system cannot report on it.** Detecting a full-platform outage requires a probe
source outside Cloudflare; that is deliberately out of scope for now and is recorded
as a risk rather than a solved problem.

## Contributing

This is primarily a personal project at the moment. Issues and pull requests are
welcome.

`develop` is the development branch and `main` is the release branch. Feature work
lands on `develop`; merging into `main` is a deliberate release step. See
[AGENTS.md](AGENTS.md) for the full rules. The repository's default branch is
`develop`, because nothing has been released yet — `main` holds only the initial
skeleton.

## License

**GNU General Public License v3.0** (SPDX: `GPL-3.0-only`) — full text in
[LICENSE](LICENSE).

Copyright (C) 2026 ZhX589, ZYongX09

Functionality was informed by studying mature commercial status-page products, but
**all code and assets in this repository are original**. No third-party stylesheets,
markup, copy, message catalogs, logos, or images were copied. Dependencies are all
GPL-3.0-compatible (MIT / ISC / OFL / Apache-2.0).
[OpenStatus](https://github.com/openstatusHQ/openstatus) is **AGPL-3.0** and is not a
source for this project's code.
