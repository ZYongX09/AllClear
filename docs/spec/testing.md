# Testing

How the suites are organised, what they actually run against, and the rules that
follow from it.

```sh
npm test          # packages/shared, then apps/api
npm run typecheck # all three packages
```

| Suite | Files | Tests | Runs against |
|---|---|---|---|
| `packages/shared` | 4 | 82 | plain Node |
| `apps/api` | 9 | 197 | real `workerd` with a real D1 binding |
| `apps/web` | — | — | no suite yet; see below |

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

### The clock is real

Routes under test read `Math.floor(Date.now() / 1000)`, so tests age database rows
rather than pinning time. A test that needs "three days ago" writes a row with a
three-day-old timestamp; it does not freeze the clock. Freezing would test the
freeze.

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

## `apps/web` — no suite yet

There is no `test` script in `apps/web`, and the M4 verification was done by
driving a browser rather than by asserting in code. That is a gap, not a
decision: the status page has real branches worth pinning down — a stale probe
rendering `unknown` rather than `operational`, an unmeasured day drawing
differently from an `unknown` day, the two-stage derivation surviving into the
render — and none of them are covered by a test today.

What exists to build on is `apps/web/verify/`:

- `api-stub.ts` stands in for `allclear-api` over the Service Binding, so the page
  renders with no D1, no KV and no migrations. Its snapshot is deliberately
  awkward — a fresh probe, a stale probe, no probe, an open incident with a
  timeline, a scheduled maintenance that must *not* paint its component, a
  component missing five days of history.
- `vite.config.verify.ts` wires that stub in as an `auxiliaryWorkers` entry.

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
