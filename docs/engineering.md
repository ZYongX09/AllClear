# Engineering notes

This is the engineering companion to the [README](../README.md). The README says
what the project is and how to run it; this document says how it is built, which
properties are load-bearing, and — the part worth reading before you trust any of
it — **what has actually been verified versus what is only designed**.

Detailed specifications live next to this file in [`docs/spec/`](spec/), one per
subsystem.

---

## Status

**M0–M5 have local verification records. The low-write pipeline is a local
change, not a deployment or a production acceptance claim.**

| Milestone | Scope | State |
| --- | --- | --- |
| M0 | Deployment and technical-boundary validation on real Cloudflare infrastructure | Done — [`docs/spec/m0-findings.md`](spec/m0-findings.md) |
| M1 | Data model and the fault state machine | Done — [`docs/spec/state-machine.md`](spec/state-machine.md) |
| M2 | Admin API, admin console, snapshot pipeline | Done — [`docs/spec/admin-api.md`](spec/admin-api.md), [`docs/spec/admin-ui.md`](spec/admin-ui.md) |
| M3 | Uptime maths and the probe scheduler | Done — [`docs/spec/uptime-math.md`](spec/uptime-math.md), [`docs/spec/probe.md`](spec/probe.md) |
| M4 | Public status page | Done — [`docs/spec/visual-parity.md`](spec/visual-parity.md) |
| M5 | Subscriptions and unsubscribe | Done — [`docs/spec/subscriptions.md`](spec/subscriptions.md) |

Historical M0–M5 gate record (not the current revision’s final gates):

```sh
npm run typecheck   # exit 0
npm test            # 294 passing (shared 82 / api 212)
npm run build       # exit 0
```

Read [Verification honesty](#verification-honesty) before treating any of that
as a claim about production. It is not.

---

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
                 D1 (data + summary)     KV (fallback checkpoints)
```

`allclear-api` is deployed with **no public route**. The web Worker reaches it
over a Service Binding, and that reachability is *not* treated as
authentication — every `/internal/*` route additionally requires a shared
`INTERNAL_KEY`.

---

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | Hono Worker — public read API, admin API, probe scheduler, subscriptions |
| `apps/web` | Next.js status page and admin console, built with [vinext](https://github.com/cloudflare/vinext) |
| `packages/shared` | Pure functions: status derivation, uptime maths, probe coverage, snapshot contract |
| `docs/spec` | Specifications and verification records |
| `apps/web/verify` | Fixture Workers used to render the UI locally without D1 or KV |

### Stack

Cloudflare Workers · D1 · KV · Service Bindings · Hono 4 · Next.js 16 (vinext) ·
React 19 · Vite 8 · Tailwind CSS 4 · Radix UI · `next-intl` · `next-themes` ·
lucide · Inter.

This is **not** an npm workspaces monorepo — each package installs its own
dependencies. The consequence worth knowing is that `packages/shared` must be
built before anything importing it can run or type-check; both root scripts do
that first.

---

## Design commitments

These are load-bearing invariants, not aspirations. Each is enforced by code and
pinned by tests.

### Uptime is computed, never asserted

```
uptime = 1 − weighted_downtime / covered_duration
```

The numerator is a swept sum over non-overlapping time segments, taking the
**most severe** active impact per segment. Overlapping incidents therefore
cannot double-count, which a naive "sum of union per severity" gets wrong when
different severities overlap.

### Absence of evidence is not evidence of uptime

A component with no probe coverage, or with probe data older than its freshness
budget, reports `unknown` — never `operational`. Uncovered time is excluded from
the denominator and reported separately as `unknown_duration`.

### No silent 100%

If the effective window is entirely excluded — for example fully covered by
maintenance — uptime is `null` / N/A, not `100%`. A day nobody measured cannot
render as a perfect day.

### The snapshot carries evidence, not verdicts

No component status is stored in the snapshot. Status depends on `now`: a
maintenance window ending or an impact interval closing changes the correct
answer **without any write occurring**, so a stored status goes stale in a way no
version counter can detect. The snapshot carries the intervals and the latest
probe result, and the reader derives the status at its own clock using the pure
functions in `packages/shared`.

### Probe timestamps are estimates, and stored as four separate fields

`first_failed_at`, `detected_at`, `first_recovery_success_at` and `resolved_at`
are distinct. The nominal detection lag is `(failure_threshold − 1) × interval`
— not one interval. Probe-generated impacts are marked `estimated: true`, and the
documentation states the error conditions rather than promising a bound.

### Live summary and fallback evidence are distinct

Normal reads use a materialized D1 summary or its 30-second hot-cache copy.
If the live path fails, KV checkpoints can serve unconfirmed fallback evidence.
Provenance (`source`) and currency (`stale`) are separate from assembly age
(`ageSeconds`, `aged`), history computation time and individual probe timestamps.

### Probes are an admin-reviewed allowlist

No user-submitted probe targets, and redirects are denied by default.

---

## The read chain

The low-write path separates current evidence from historical aggregation and
outage checkpoints:

| Layer/task | Cadence | Meaning |
| --- | --- | --- |
| Probe scheduling | 60 seconds by default | Freshness remains 120 seconds for a default target. |
| D1 materialized summary | Updated server-side with admin writes and applied observations | Normal read authority; fetched by one point query. |
| Hot cache | 30 seconds | `cache-live`; a location may retain the prior summary for this lifetime. |
| Daily history recompute | 300 seconds | Separate from current probe evidence; reports `historyComputedAt` in epoch seconds. |
| KV fallback checkpoint | 600 seconds when due and admitted by the shared budget | Two keys; not a per-observation or per-read write. |
| Raw-result retention | Daily | Roll up before deleting; retain evidence when rollup fails. |

`d1-live` and `cache-live` are normal reads. KV/legacy fallback sources are
unconfirmed (`stale: true`); `none` means an explicit unavailable view. All
required `ReadResult` fields stay unchanged. Summary assembly time must not be
used as a probe timestamp or a claim that all history is fresh.

Admin writes update the D1 summary immediately server-side, not every global
cache at once. A hot cache can retain old data for up to 30 seconds; independent
KV checkpoint budgets can delay fallback publication further. There is no global
linearizability or cross-location read-after-write promise. The prior
transition-only publication gap is replaced by refreshing summary evidence for
successful observations too. See [snapshot.md](spec/snapshot.md) for the contract
and verification boundaries. Missing/mismatched summaries can require a read-only
single-SQL assembly; if repair persistently fails and Cache API is unavailable,
every request can repeat that more expensive work. Public reads write neither
D1 nor KV, only best-effort cache. Production behavior and free-tier capacity still
require validation; reduced writes alone do not establish either.

---

## Capacity boundaries (v1)

Application boundaries are not provider-capacity guarantees. The workload must
be measured against the intended plan before claiming free-tier support:

| Boundary | Value | Enforced by |
| --- | --- | --- |
| Probe targets per run | 20 | Scheduler cap; excess due targets can wait |
| Minimum probe interval | 60 s | DB `CHECK`, API validator |
| Enabled targets per component | 1 | Partial unique index |

They live in one place — `packages/shared/src/limits.ts` — so the four layers
cannot drift apart.

The per-component limit exists so there is no hidden assumption about how
multiple targets on one component would aggregate. Aggregate rules are deferred
and documented rather than guessed at.

---

## Security posture

**Server-side requests (SSRF).** Any code that fetches a URL supplied as data
allows only `http`/`https`, validates the host, and rejects loopback, private,
link-local and reserved addresses. Redirects are denied by default (0 hops), with
a 64 KB response body cap as defence in depth. A rejected URL is treated as
*skipped*, not as an outage — the service behind it may be perfectly healthy, and
opening a public incident over a typo in a config field would be a false positive
on the most visible surface this project has.

**The residual risk is stated, not hidden.** Host-string validation alone does
not eliminate DNS rebinding. v1 therefore only probes an admin-reviewed allowlist
of targets, and opening probe configuration to third parties would require a
dedicated egress-security design first.

**SQL.** All external input is passed as bound parameters. SQL is never built by
concatenation, formatting, or interpolation.

**Secrets.** Credentials come from environment variables or a secret store only.
No usable credential literal appears in source, examples, tests or documentation.
Local development secrets live in `.dev.vars`, which is gitignored. The test
suite's fixture bindings are named `fixture-…-not-a-credential` precisely so they
cannot be mistaken for real values.

**Two credentials, on purpose.** `INTERNAL_KEY` says "this request comes from the
web Worker" and is a property of the deployment. `ADMIN_TOKEN` says "a human who
knows it is operating this console" and is a property of the request. Sharing one
value would mean every operator knows the Worker's credential, and rotating it to
revoke a person would break the site. The browser holds neither: it holds an
`HttpOnly`, `SameSite=Lax`, `Path=/admin` HMAC session cookie.

**Reachability is not authorisation.** A Server Action compiles to a public POST
endpoint that attaches the Worker's own credential on the way out. The console's
layout gate decides what *renders*; every write action re-checks the session
independently, because rendering is not authorising.

**Probe transitions are idempotent and atomic.** Each transition is modelled as a
retryable business operation: a `db.batch()` commits the state update, change and
impact together, actual affected-row counts are verified (a conditional `UPDATE`
matching zero rows raises no error), and unique constraints backstop it. The test
suite covers two concurrent cron runs on one target, a duplicate confirmation,
and a failure after counters were updated.

---

## Verification honesty

This project keeps a hard line between **what has been observed** and **what is
merely designed**. The same rule applies here.

**Verification records (historical unless noted):**

- `apps/api`: 212 tests across 10 files, against real `workerd` and real D1 —
  including the state machine's concurrency and retry cases, the uptime
  algorithm's overlap and zero-denominator cases, SSRF rejection, the read chain's
  fallback ordering, and the colo-local cache layer.
- `packages/shared`: 92 tests across 4 files, pure Node, passed for the low-write
  contract change; its TypeScript build also passed.
- The status page's functional behaviour: component/section rendering, incident
  expansion, deep links, the subscribe dialog, the calendar/chart toggle, i18n,
  dark mode, and responsive breakpoints down to 375px — all driven in a browser
  and recorded in [`docs/spec/visual-parity.md`](spec/visual-parity.md).
- The admin console's write guard: a rendered form was replayed with
  `credentials: "omit"`, which is what an unauthenticated caller has. It was
  refused, and nothing was created.
- Build and type-check green, with `/admin` and `/status/:slug` present in the
  build's route table.

**Not verified, and not claimed:**

- **No deployment acceptance for this change.** Local checks do not establish
  production behavior. This optimization does not deploy or enable monitors.
- **The admin console has no automated tests.** Its session verification, cookie
  attributes and per-action guard are the security boundary for a public write
  surface, and they were checked by hand once. This is the most important gap to
  close.
- **The status page has no automated tests either.** Its branches were driven in
  a browser, not asserted in code.
- **No human-perspective visual review has happened.** The design-language
  comparison is a computed-style and geometry diff table; the rendered-PNG review
  path could not run in the environment this was built in. The status page is
  therefore **functionally verified and visually unverified**.
- **The visual "dark mode" screenshot artefact is not trustworthy** — the file
  named dark is actually a light render. Dark mode *behaviour* was verified by
  operating the page's own toggle. See `visual-parity.md` §3.
- **Cross-location freshness and real outage behavior remain unmeasured.**
  Local repair/checkpoint tests do not establish global cache or KV propagation.
- **KV propagation delay is not simulated.** The D1-failure path is tested with a
  database stand-in that throws; a real cross-colo delay is not reproduced.
- **`GET /api/status/:slug/history` does not exist.** History is embedded in the
  snapshot as `days` and served through `/snapshot.json`. The endpoint appears in
  the original plan and was not built.
- **A deep static security scan is inconclusive, not clean.** Its seven
  candidates were each resolved by hand as non-findings, but the scan never
  reached a complete conclusion, so this project must not be described as
  security-audited. See [`docs/spec/security-scan.md`](spec/security-scan.md).
- **Migration `0002` is not idempotent.** Apply tracked migrations through the
  migration tool; do not manually replay schema changes.

---

## Known single point of failure

The status page and the prober both run on Cloudflare. **If Cloudflare itself is
down, this system cannot report on it.** Detecting a full-platform outage requires
a probe source outside Cloudflare; that is deliberately out of scope for now and
is recorded as a risk rather than a solved problem.

---

## Attribution

Functionality was informed by studying mature commercial status-page products.
**All code and assets here are original.** No third-party stylesheets, markup,
copy, message catalogs, logos, or images were copied.

Reusable dependencies:

| Dependency | License |
| --- | --- |
| shadcn/ui patterns, Radix UI | MIT |
| lucide icons | ISC |
| Inter | OFL |
| Tailwind CSS | MIT |

[OpenStatus](https://github.com/openstatusHQ/openstatus) is **AGPL-3.0** and is
not a source for this project's code.
