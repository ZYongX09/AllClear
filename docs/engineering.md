# Engineering notes

This is the engineering companion to the [README](../README.md). The README says
what the project is and how to run it; this document says how it is built, which
properties are load-bearing, and — the part worth reading before you trust any of
it — **what has actually been verified versus what is only designed**.

Detailed specifications live next to this file in [`docs/spec/`](spec/), one per
subsystem.

---

## Status

**M0–M5 are built and verified locally. Nothing is deployed.**

| Milestone | Scope | State |
| --- | --- | --- |
| M0 | Deployment and technical-boundary validation on real Cloudflare infrastructure | Done — [`docs/spec/m0-findings.md`](spec/m0-findings.md) |
| M1 | Data model and the fault state machine | Done — [`docs/spec/state-machine.md`](spec/state-machine.md) |
| M2 | Admin API, admin console, snapshot pipeline | Done — [`docs/spec/admin-api.md`](spec/admin-api.md), [`docs/spec/admin-ui.md`](spec/admin-ui.md) |
| M3 | Uptime maths and the probe scheduler | Done — [`docs/spec/uptime-math.md`](spec/uptime-math.md), [`docs/spec/probe.md`](spec/probe.md) |
| M4 | Public status page | Done — [`docs/spec/visual-parity.md`](spec/visual-parity.md) |
| M5 | Subscriptions and unsubscribe | Done — [`docs/spec/subscriptions.md`](spec/subscriptions.md) |

Current gate state, measured rather than assumed:

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
                 D1 (source of truth)    KV (published snapshots)
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

### The public read path does not require D1

The snapshot is served from KV, falling back to the last known good document,
and the read reports its own provenance (`source`) and whether it could confirm
currency (`stale`) — separately from the document's age (`ageSeconds`, `aged`).

### Probes are an admin-reviewed allowlist

No user-submitted probe targets, and redirects are denied by default.

---

## The read chain

`readSnapshot` tries five sources in order and reports which one answered:

| # | `source` | Reached when | `stale` |
| --- | --- | --- | --- |
| 1 | `kv-fresh` | The fresh key exists. Touches no D1. | `false` |
| 2 | `d1-rebuild` | KV missed or failed to parse. Rebuilds from D1 and repopulates both KV keys and the colo-local copy. | `false` |
| 3 | `kv-last` | D1 is also unavailable. Serves the last known good document. | `true` |
| 4 | `cache` | KV could not answer at all. Serves the colo-local copy. | `true` |
| 5 | `none` | Nothing to serve. The caller must render an explicit unavailable state. | `true` |

Steps 3 and 4 cover **different failures** and neither substitutes for the other:
`kv-last` covers D1 being unavailable (and is itself in KV), while `cache` covers
KV being unavailable. The colo-local cache is not a consistency mechanism — it
helps only the data centre that populated it — and it is documented as such.

The consistency target is **about sixty seconds, as an optimisation target and
not a guaranteed upper bound**. KV exposes no propagation deadline to enforce,
and the code does not paper over the gap with a timestamp heuristic. Writes are
published synchronously; the once-a-minute cron pass exists to *repair* a
snapshot whose version has drifted, not to publish.

**Storage is KV, not R2.** The payload is tens of kilobytes and read on every
page view; R2's advantages are not exercised at that size, and dual-writing would
add a second copy to keep in step for no benefit. The rationale is written out in
[`docs/spec/snapshot.md`](spec/snapshot.md).

---

## Capacity boundaries (v1)

Written into the code as constants rather than made configurable, because these
are the numbers the deployment was *tested* at:

| Boundary | Value | Enforced by |
| --- | --- | --- |
| Enabled probe targets | 20 | DB constraint, API validator, scheduler cap, console |
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

**Verified by running:**

- `apps/api`: 212 tests across 10 files, against real `workerd` and real D1 —
  including the state machine's concurrency and retry cases, the uptime
  algorithm's overlap and zero-denominator cases, SSRF rejection, the read chain's
  fallback ordering, and the colo-local cache layer.
- `packages/shared`: 82 tests across 4 files, pure Node.
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

- **Nothing is deployed.** No Worker is running, no remote migration has been
  applied, and the production KV/D1 bindings have never been exercised by this
  code.
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
- **The cron repair pass has no dedicated test.** It was exercised incidentally
  during M0 and never deliberately since.
- **KV propagation delay is not simulated.** The D1-failure path is tested with a
  database stand-in that throws; a real cross-colo delay is not reproduced.
- **`GET /api/status/:slug/history` does not exist.** History is embedded in the
  snapshot as `days` and served through `/snapshot.json`. The endpoint appears in
  the original plan and was not built.
- **A deep static security scan is inconclusive, not clean.** Its seven
  candidates were each resolved by hand as non-findings, but the scan never
  reached a complete conclusion, so this project must not be described as
  security-audited. See [`docs/spec/security-scan.md`](spec/security-scan.md).
- **Migration `0002` is not idempotent** and has never been applied to a
  production database.

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
