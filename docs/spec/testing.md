# Testing

How the suites are organised, what they actually run against, and the rules that
follow from it.

```sh
npm test          # packages/shared, then apps/api
npm run typecheck # builds packages/shared, then type-checks all three packages
npm run build     # builds packages/shared, then apps/web
```

| Suite | Files | Tests | Runs against |
|---|---|---|---|
| `packages/shared` | 4 | 92 | plain Node |
| `apps/api` | 15 | 266 | real `workerd` with a real D1 binding, including 3 capacity scenarios |
| `apps/web` | — | — | no suite yet; see below |

### `packages/shared` must be built before anything imports it

This is not an npm workspaces monorepo. Each package installs its own
dependencies, and `apps/api` and `apps/web` resolve `@allclear/shared` through
the package's `exports` map to `dist/index.d.ts`. So **a change to shared source
is invisible to the other two packages until `packages/shared` is rebuilt**, and
a type-check run without that build reports on the previous build — it can pass
while the source is broken, or fail while the source is fine.

Both root scripts therefore build it first, in order:
`typecheck` runs `packages/shared run build` before checking anything, and `build`
builds shared before `apps/web`. Running `npm --prefix apps/web run typecheck`
on its own after editing shared is the way to get a confusing result, and it is
the reason the rule is written down here rather than left in the root
`package.json` comment where only someone reading that file would find it.

## `packages/shared` — pure functions, plain Node

`vitest run`, nothing more. Everything exported from the package is deterministic
and free of I/O, which is the whole reason the package exists: the availability
maths and the status derivation are the two places where being wrong is expensive
and silent, and neither should need a runtime to test.

`uptime.test.ts` is the plan's M3 gate. It covers cross-severity intervals that
fully overlap, partially overlap and share a layer; windows crossing midnight;
`available_since` later than the window start; maintenance covering the whole
window; a fault overlapping maintenance; no coverage at all; coverage
intersection when a probe stops; ongoing impacts; weight boundaries; empty input;
a zero denominator; and a constructed case where summing unions per layer and
scanning the timeline disagree.

`status.test.ts` is the other half of the same gate: the two-stage derivation, and
in particular that `resolved` and `completed` changes stop contributing, that a
`scheduled` maintenance contributes nothing, and that a component with no fresh
probe evidence comes out `unknown` rather than `operational`.

## `apps/api` — integration, against `workerd`

`@cloudflare/vitest-plugin`, configured in `vitest.config.ts`, with
`wrangler.configPath` pointing at the real `wrangler.jsonc`.

**It is a real runtime, not a mock, and that is load-bearing.** The design depends
on specific SQLite behaviour: `db.batch()` rolling back as one transaction, a
conditional `UPDATE` matching zero rows without raising an error, partial unique
indexes, `meta.changes`. A mock would assert beliefs about those behaviours
instead of the behaviours. `d1-semantics.test.ts` exists to pin them down
directly, so that when one of them is the reason a state-machine test fails, the
cause is already documented rather than rediscovered.

### Storage is shared across the tests in one file

`test/apply-migrations.ts` runs as a `setupFiles` hook and applies migrations
once per file, against storage that every test in that file shares. This is worth
stating plainly because the opposite is easy to assume: the
`@cloudflare/vitest-pool-workers` package this plugin replaced had an
`isolatedStorage` option that snapshotted and restored bindings around each test.
`@cloudflare/vitest-plugin` 1.4.2 has no such option, and a two-test experiment
confirms the behaviour — a row written in one test is still readable in the next.

The consequence is a rule for writing tests here, not a defect to work around:

- A test that only reads what it seeded itself is fine. Seeding a page with a
  unique slug per test, which `helpers.ts` does, is enough isolation.
- A test that exercises a **global** operation is not. `runProbes` selects every
  due target, `applyRetention` deletes by age across the whole table, and the rate
  limiter counts per bucket name — so each of those files must clear or disable
  the state it depends on in `beforeEach`. That is why `probe-run.test.ts`
  disables every target before each test and `uptime-retention.test.ts` clears
  `probe_result`.

### Clock control

Route tests normally use the real clock and age their fixture rows. Scheduler
and capacity tests control `Date.now()` or pass an explicit clock so that a full
UTC day, midnight boundaries, and stopped-monitor freshness can be exercised
without waiting in real time. Mocked HTTP responses replace external probe
requests; accepted observations and storage operations still use local workerd
and D1.

### Timeouts are raised on purpose

`testTimeout` and `hookTimeout` are 30 s rather than Vitest's 5 s default. These
are integration tests: each one starts real `workerd` work, and the concurrency
cases deliberately run several five-attempt retry loops against a single D1 row,
so one test has been measured at over a second on an idle machine. A slow CI box
would otherwise trip the default and report a timeout, which looks like a
state-machine failure and is not one.

### Fixture bindings are not credentials

`vitest.config.ts` supplies `INTERNAL_KEY`, `UNSUBSCRIBE_HMAC_KEY`,
`PUBLIC_BASE_URL`, `EMAIL_FROM` and `MAX_TARGETS_PER_RUN` as miniflare bindings.
They exist for the duration of a test run, they authorise nothing outside it, and
they must never be reused as a deployed value — which is why the two key-shaped
ones are named so they cannot be mistaken for something real. Real values come
from the environment or a secret store and appear in no file in this repository.

### The Cache API is exercised, not mocked

`cache.test.ts` runs against the `workerd` environment's real `caches.default`,
where the API exists and round-trips. It covers seven cases: a written document
reads back, a document that was never written reads as `null`, an entry past its
`max-age` is not served, `purge` removes an entry, and every entry point degrades
to "no cached copy" rather than throwing when the API is absent. That last group
is the point: the cache is an optimisation, and the module's contract is that a
missing or broken cache costs speed rather than correctness.

These local cache tests do not establish cross-location behavior or rescue
during a real outage. Snapshot integration tests must distinguish the 30-second
live hot cache from legacy fallback cache and unconfirmed KV checkpoints; see
[snapshot.md](snapshot.md). Production freshness and free-tier capacity need
separate workload validation.

### Storage-capacity regression

`pipeline-capacity.test.ts` meters each executed SQL statement, including every
statement in a batch, and sums actual local D1 `meta.rows_read`/`rows_written`.
It also counts attempted KV reads and puts. Global fixtures reset pages,
publication budgets, and every maintenance cursor between scenarios.

The five-target, one-page, sixty-second healthy scenario executes 1,440 ticks
with a preceding day of raw samples and ninety daily aggregates per component
already present. Raw fixtures are imported before aggregates, with the resulting
rollup revision stamped onto the seeded rows; import dirtiness is cleared before
metering the quiet workload. This does not bypass invalidation in production.

The measured result is 7,200 new observations, 288 KV puts, zero KV gets,
393,543 D1 rows read, 66,616 rows written, and at most 38 SQL statements in one
tick. The fault/recovery scenario peaks at 45 statements. With 223,200 retained
samples seeded, the thirty-tick retention scenario reads 58,558 rows, writes
5,028, and purges 3,570 expired observations while preserving required anchors.
The materialized daily result is also checked against the exact full-day oracle
at its actual computation time.

Before incremental prefixes and sparse history reuse, the preceding version
read 2,405,044 rows in its daily fixture. The new, more populated fixture reduces
that measured read count by 83.6%; writes increase modestly for invalidation and
history-cache bookkeeping. This is a read/write trade, not zero-cost monitoring.

These are local regression workload measurements, not a production billing
forecast or an account-wide Free-tier guarantee. Visitors, retries, more pages,
incident history, additional services, and runtime query plans can add work.
The full-day test has an explicit 600-second test timeout; run the capacity file
separately when iterating on faster suites.

## `apps/web` — no suite yet

There is no `test` script in `apps/web`, and both the M4 status-page verification
and the M2 console verification were done by driving a browser rather than by
asserting in code. That is a gap, not a decision: the status page has real
branches worth pinning down — a stale probe rendering `unknown` rather than
`operational`, an unmeasured day drawing differently from an `unknown` day, the
two-stage derivation surviving into the render — and the console has a security
boundary worth pinning down even more. None of them are covered by a test today.

The console's write guard was checked the hard way instead, in a browser: the
rendered create-page form was POSTed with its real hidden action fields but with
`credentials: "omit"`, which is exactly what an unauthenticated caller has. The
response carried `not_signed_in`, and a follow-up read confirmed nothing was
created. That is a real check of the real question, but it is a check someone ran
once, not a regression test. See [admin-ui.md](admin-ui.md).

What exists to build on is `apps/web/verify/`:

- `api-stub.ts` stands in for `allclear-api` over the Service Binding, so the page
  renders with no D1, no KV and no migrations. Its snapshot is deliberately
  awkward — a fresh probe, a stale probe, no probe, an open incident with a
  timeline, a scheduled maintenance that must *not* paint its component, a
  component missing five days of history.
- `admin-stub.ts` answers `/internal/admin/*` from a mutable in-memory store, so
  the admin console renders *and is writable* against the same fixture. It is
  asked first and answers only for the admin prefix, so it cannot shadow a public
  route. It checks only that `X-Internal-Key` is present — the fixture has no copy
  of the real secret and should not have one; the value comparison is the API
  Worker's job and is tested in `apps/api`. It does reproduce the API's
  absent/null/string distinction for nullable fields, because the console's
  "move a component out of a section" path depends on that distinction and a stub
  that collapsed it would make a broken path look correct.
- `vite.config.verify.ts` wires both stubs in as `auxiliaryWorkers` entries.

```sh
cd apps/web
npx vite dev --config verify/vite.config.verify.ts --port 5180
```

Two things learned building it, worth keeping: `auxiliaryWorkers` takes a typed
inline config whose module specifier key is `entrypoint` (not `main`, not
`configPath`), and `types: { generate: false }` keeps the auxiliary worker out of
`.cloudflare/types/index.d.ts`.

The fixture's clock is read per request, not at module scope. A fixture pinned at
module scope goes stale minutes after the isolate starts, and then it silently
stops exercising the `operational` branch it was written to exercise — which is
the one failure mode a fixture must not have.

## What these suites do not cover

- **Nothing is deployed or migrated by a test run.** `npm test` never touches
  production D1, never applies migrations remotely, and never deploys. A green
  suite is evidence about the code and about nothing else.
- **The real API Worker is never exercised end to end by the web app.** The web
  tests, when they exist, will run against `api-stub.ts`, which is a fixture. The
  Service Binding path to the deployed Worker is covered by `apps/api` tests on
  one side and by the M4 browser checks on the other, not by a single test that
  spans both.
- **Visual output is not asserted.** `docs/spec/visual-parity.md` records what was
  measured and, in §3, what could not be.
- **The console has no automated tests at all.** Its session verification, its
  cookie attributes and its per-action guard are the security boundary for a
  public write surface, and none of them are pinned by a test. A future suite
  should start there: the guard is a pure-ish function of the request's cookie
  and the configured token, which makes it the cheapest of these gaps to close.
