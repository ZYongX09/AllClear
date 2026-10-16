# The snapshot and the read chain

**Status: implemented and tested.** The contract is
`packages/shared/src/snapshot.ts`; the derivation the snapshot defers to is
`packages/shared/src/status.ts`; construction, the two KV keys and the read chain
are `apps/api/src/snapshot.ts`; the colo-local cache layer is
`apps/api/src/cache.ts`; the public routes and the cron repair pass are
`apps/api/src/index.ts`. The evidence is `apps/api/test/snapshot.test.ts` and
`apps/api/test/cache.test.ts`. This document explains the design and, at the end,
what it does not claim.

## What the snapshot is

The snapshot is one JSON document per page, assembled from D1 and published to
KV. It is the only thing the public read path needs, which is what lets a status
page render while D1 is unreachable.

Three public routes serve it, all in `apps/api/src/index.ts`:

| Route | Response | Cache header |
| --- | --- | --- |
| `GET /api/status/:slug` | The whole `ReadResult` | `no-store` |
| `GET /api/status/:slug/snapshot.json` | The same `ReadResult` | `public, max-age=30, stale-while-revalidate=300` |
| `GET /api/status/:slug/feed.xml` | An Atom feed built from the snapshot | `public, max-age=60` |

All three return HTTP 503 when there is no snapshot to serve, so a caller cannot
mistake "we have no data" for "everything is fine". The `.json` variant is
deliberately the same `ReadResult` shape as `/api/status/:slug` rather than a
bare snapshot: two shapes for one document would be two contracts to keep in
sync, and the `source`/`stale` fields are exactly what a machine consumer needs.

The document itself is assembled by `buildSnapshot` in
`apps/api/src/snapshot.ts`. It reads the page row, then everything that depends
on the page id in a single `db.batch()` of nine statements. The batch matters:
reads in a D1 batch run as one transaction, so no write can land between the
components query and the impacts query and produce a document describing a state
that never existed.

Three bounds shape the payload:

| Constant | Value | Meaning |
| --- | --- | --- |
| `CHANGE_HISTORY_SECONDS` | `30 * 86_400` | Changes older than this are not embedded. |
| `HISTORY_DAYS` | `90` | Daily uptime rows per component. |
| `MAX_CHANGES` | `50` | Upper bound on embedded changes. |

## Why the snapshot carries evidence, not a verdict

The obvious design stores each component's computed `status` in the snapshot.
The contract explicitly does not: `SnapshotComponent` has no `status` member, and
`apps/api/test/snapshot.test.ts` asserts `expect(built).not.toHaveProperty("status")`.

The reason is time. Status depends on `now`. A maintenance window that ends at
03:00, or an impact whose interval closes, changes the correct status **without
any write occurring**. A stored status therefore goes stale in a way the
snapshot version counter cannot detect, because no version bump accompanies the
passage of time. A version counter answers "has the data changed since I last
published?"; it cannot answer "has the clock moved past a boundary?".

So the snapshot carries the *evidence* and the reader derives the status at its
own clock using the pure functions in `packages/shared/src/status.ts`:

| Evidence in the payload | Field | Why the reader needs it |
| --- | --- | --- |
| Impact intervals | `impacts` | Each is `{severity, startsAt, endsAt}`; the reader tests whether it covers `now`. |
| Maintenance windows | `maintenances` | Includes `scheduled` ones, so the page can announce upcoming work. |
| Latest probe result | `probe` | `{targetPublicId, lastProbeAt, ok}`, or `null`. |
| Freshness budget | `statusFreshnessMax` | Per component; how old `probe.lastProbeAt` may be and still count. |
| Precomputed daily history | `days` | The one aggregate that cannot be recomputed per view. |

`deriveSnapshotComponent` in `packages/shared/src/snapshot.ts` is the single call
the reader makes. It unpacks the evidence into `deriveComponentStatus` and takes
`statusFreshnessMax` from the component rather than from a caller-supplied
argument, so the reader cannot accidentally pass the wrong budget.

Two details in the evidence are load-bearing and easy to get wrong:

* **Impacts are filtered to those that could still be active.** The query keeps
  rows where `end_at IS NULL OR end_at >= <build time>`. An interval that had
  already closed before the snapshot was built can only be inactive at a later
  read time too, so it is omitted rather than shipped and re-evaluated.
* **A target that has never reported is not evidence of health.** If
  `probe_state.last_probe_at` or the latest result is null, `probe` is left
  `null`, which the derivation reads as `uncovered` and turns into `unknown` —
  never `operational`. A probe result older than `statusFreshnessMax` derives as
  `unknown` with reason `monitoring_stale`; a fresh *failing* probe with no
  impact derives as `unknown` with reason `monitoring_failing_unclassified`,
  because reporting a fault severity there would invent a classification the
  data does not contain.

`statusFreshnessMax` comes from `defaultCoverageGapMax(interval_seconds)`, which
is `max(2 * interval, 120)`. A component with no enabled probe target gets
`defaultCoverageGapMax(60)`, i.e. 120 seconds. The snapshot test asserts the
value 120 for a 60-second target, which is the `max` taking the 120 branch.

The one precomputed verdict is the daily uptime history. It is an aggregate over
thousands of probe results and cannot be recomputed per page view, so it is
materialised into `daily_uptime` and embedded as `days`, oldest first.
`SnapshotDay.uptime` is `number | null`, and `null` is kept distinct from 1 so
that a day nobody measured cannot read as a perfect day.

## The read chain

`readSnapshot` in `apps/api/src/snapshot.ts` tries five things in order and
reports which one answered in `source`:

| Order | `source` | Reached when | `stale` |
| --- | --- | --- | --- |
| 1 | `kv-fresh` | The fresh key exists. Touches no D1. | `false` |
| 2 | `d1-rebuild` | The fresh key missed or failed to parse. Rebuilds from D1 and repopulates **both** KV keys and the colo-local copy. | `false` |
| 3 | `kv-last` | D1 is also unavailable. Serves the last known good document. | `true` |
| 4 | `cache` | KV could not answer at all. Serves the colo-local copy. | `true` |
| 5 | `none` | Nothing to serve. `snapshot` is `null`. | `true` |

The ordering is written out in the module header because "which source answered"
is the single most useful fact when a status page looks wrong.

Two properties of the chain are worth naming.

The `d1-rebuild` step writes both keys. That is not incidental: the `kv-last`
step depends on the key existing, so the rebuild has to maintain it. A failure
to write KV during a rebuild is recorded in `errors` but does not fail the read,
because the data has already been assembled. The test
"rebuilds from D1 on a KV miss and repopulates both keys" asserts the fallback
key is not left unwritten.

The `kv-last` and `cache` steps are the only paths where `stale` is a real
signal: on both, the read is serving data whose currency it could not check. They
cover different failures — `kv-last` covers D1 being unavailable and is itself in
KV; `cache` covers KV being unavailable, which `:last` cannot cover for that exact
reason — so neither substitutes for the other. The test "falls back to the last
good snapshot and marks the read stale when D1 is down" deletes only the fresh
key and uses a database stand-in that throws on every query, then asserts
`source: "kv-last"`, `stale: true`, and an `errors` entry mentioning
`d1-rebuild`.

## `stale` is about the read path; age is about the document

This is the point M0 left open and M2 settles. `stale` is not "the document is
old". A page whose content has not changed in an hour is perfectly current, and
flagging it would make the warning indicator permanently lit and therefore
ignored. The original M0 implementation derived `stale` from the document's age,
which is exactly that failure.

The two facts are now reported separately in `ReadResult`:

| Field | Statement about | Computed as |
| --- | --- | --- |
| `stale` | the read path | `true` only on the `kv-last` and `none` paths |
| `ageSeconds` | the document | `max(0, now - snapshot.generatedAt)`, or `null` |
| `aged` | the document | `ageSeconds !== null && ageSeconds > ageWarningSeconds` |

`ageWarningSeconds` defaults to `DEFAULT_AGE_WARNING_SECONDS` (300) and can be
overridden per call. The test "separates staleness from age" serves a document
written at `T0`, reads at `T0 + 3600`, and asserts all four of `source:
"kv-fresh"`, `stale: false`, `ageSeconds: 3600`, `aged: true` at once. That
combination is the property: a stable page is current and simultaneously old.

## `page.snapshot_version` and what must advance it

`page.snapshot_version` is a counter on the page row. `bumpSnapshotVersion`
performs `snapshot_version = snapshot_version + 1, updated_at = <now>` and
returns the new value. The snapshot embeds the value it read as
`snapshotVersion`.

The counter exists for one job: it lets the cron repair pass decide, **without
rebuilding**, whether a KV payload has fallen behind D1. That is a different
question from "did the data change". Repair compares the version embedded in the
KV document against `page.snapshot_version`; if they agree, the payload is
current and is skipped.

Because the comparison is the whole point, every write that changes public
output must advance the counter *and* republish synchronously. In
`apps/api/src/admin/service.ts` this is enforced structurally rather than
remembered: every mutating operation is wrapped in `withPublish`, which calls
`publishSnapshot`, which is `bumpSnapshotVersion` → `buildSnapshot` →
`writeSnapshot`. The module header states the reason — a write that forgets to
republish is invisible, because the API returns 200 and the database is correct
while the page silently keeps serving the old document. Making the publish
something an operation *chooses* to do is how that omission becomes possible.

The probe path uses the same rule. `republishPages` in `apps/api/src/index.ts`
is called for the pages whose components transitioned during a probe run; it
advances the version and rebuilds. Its comment says why the version is advanced
there as well: a probe-driven change that advanced the document without
advancing the version would make repair's comparison report "in sync" while KV
held something older.

The paths that republish **without** advancing the version are the ones that do
not change page content, and they are deliberate:

| Path | Advances version? | Republishes KV? |
| --- | --- | --- |
| Admin mutation (`withPublish`) | Yes | Yes |
| Probe transition (`republishPages`) | Yes | Yes |
| `POST /internal/admin/pages/:slug/rebuild` | Yes (`publishSnapshot`) | Yes |
| `POST /internal/snapshot/:slug/rebuild` | No | Yes |
| `readSnapshot` `d1-rebuild` step | No | Yes |
| `repairSnapshots` (cron) | No | Yes |

The last three rebuild KV from D1 without a bump. That is correct: none of them
changes D1's page content, so the embedded version already equals the stored
one, and advancing it would make repair's comparison lie in the other direction.

## Synchronous publication, and what the cron pass is for

Admin writes rebuild and write KV inside the same request. The reason is stated
in `apps/api/src/admin/service.ts`: if publication waited for the next cron tick,
an operator who had just resolved an incident would watch the public page keep
showing it for up to a minute, and the natural reaction to that — "the save did
not work" — is wrong in a way that invites a second, conflicting edit. The test
"advances the version and rewrites KV on every write" then reads
`/api/status/:slug` and asserts `source: "kv-fresh"`, which proves the write
published rather than deferring to cron.

Cron's job is therefore **repair, not publication**. `repairSnapshots` lists the
pages, reads each fresh key, and rebuilds only when the embedded
`snapshotVersion` differs from the page row (or the key is missing).

The failure direction is the part worth stating. If D1 is unreachable, the
`SELECT` of pages throws, the handler logs `snapshot repair skipped: D1
unreachable`, and returns **without touching KV**. Cron must never "repair" a
snapshot by replacing it with nothing. This is also why the fresh key being
absent is not usable as a signal anywhere: repair treats a missing fresh key as
"rebuild me", so deleting it is not a durable state.

The repair pass has no test of its own. `docs/spec/m0-findings.md` records that
it was exercised incidentally during M0 but never deliberately, and that is still
true in the current suite.

## Two KV keys, and why `:last` never expires

`writeSnapshot` writes both keys in one `Promise.all`:

| Key | Helper | Role |
| --- | --- | --- |
| `snapshot:<slug>` | `freshKey` | The normal read source. |
| `snapshot:<slug>:last` | `lastKey` | The fallback served when D1 is unavailable. |

Neither `kv.put` call sets an `expirationTtl`. So neither key expires by TTL, and
`:last` in particular is the only durable copy in KV: the read chain's third step
and the documented D1-failure behaviour both depend on it existing. The
`writeSnapshot` comment says this explicitly — writing only the fresh key would
leave the documented fallback with no write contract behind it.

The test "writes both the fresh and the last-known-good key" asserts both keys
are present and parse to the same document.

## The colo-local cache, and no Durable Object

`apps/api/src/cache.ts` uses `caches.default` for one purpose: a copy of the
document that a data centre has already assembled, kept so that reads there
survive KV being unreachable. It is step 4 of the read chain, not step 2, and the
module header records why: putting it before the D1 rebuild would make every
healthy KV miss serve a locally cached document up to `CACHE_TTL_SECONDS` (3600)
old instead of rebuilding current data, which trades freshness for a subrequest
on the path that is supposed to be the good one.

What the cache is **not** is a consistency mechanism, and the code says so rather
than implying otherwise. `cache.put` writes to the data centre that handled the
request; nothing replicates the entry, so a different data centre may hold a
newer document, or none. A hit is reported as `source: "cache"` with
`stale: true`, the same claim `kv-last` makes: the chain could not confirm the
document is current. The API is wrapped so it can never fail a read — every entry
point checks for `caches.default` and swallows its errors, because the Cache API
is not present in every runtime this code runs under and an unavailable cache
should cost speed, not correctness.

No Durable Object binding is declared by either Worker or defined in either `src`
tree, and the design does not rely on one. The remaining cache directives in the
system are HTTP `Cache-Control` headers, such as the three on the snapshot routes
listed at the top of this document; those are instructions to the caller rather
than an internal mechanism.

The tests are `apps/api/test/cache.test.ts` (seven cases). They run in the vitest
`workerd` environment, where `caches.default` does exist and round-trips, and
they assert the properties that matter: a written document reads back, a document
that was never written reads as `null`, an entry past its `max-age` is not served,
`purge` removes it, and every entry point degrades to "no cached copy" rather
than throwing when the API is absent. They do not reproduce a real KV outage or a
cross-colo miss; see the limits section at the end.

## The consistency model

The system is eventually consistent, and the code says so rather than implying
otherwise. Two mechanisms are involved.

Publication is synchronous: an admin write bumps the version and rewrites KV in
the same request, so a reader in the same place sees the change immediately
after the write returns. The read chain relies on KV read-after-write for the
fresh key.

The `kv-fresh` path cannot detect a KV propagation delay. The comment in
`readSnapshot` states this plainly — "What this path *cannot* detect is a KV
propagation delay; that is documented rather than papered over with a timestamp
heuristic" — which is also why the document's age is reported separately rather
than folded into `stale`.

The only periodic mechanism is the cron trigger, declared as `* * * * *` in
`apps/api/wrangler.jsonc`: once a minute.

**The consistency target, stated as a target.** A write is usually visible
quickly in the location that handled it, and other locations may see it after a
propagation delay. Roughly sixty seconds — one cron period — is the figure this
project optimises for, and that is the whole of the claim: it is an optimisation
target, **not a guaranteed upper bound**. Nothing in the code enforces it, KV
offers no propagation SLA to enforce it against, and `readSnapshot` explicitly
declines to paper over the gap with a timestamp heuristic. Promising a specific
figure would require a continuously tested, measurable service objective, which
this project does not have. Until then, the honest statement is "usually fast,
occasionally delayed, and here is the `stale` flag that tells you which you got".

The once-a-minute cadence is also an upper bound on how long a *drifted* KV
payload goes unnoticed by the repair pass. That is a different fact from
propagation: repair does not publish in the first place, it only rebuilds a key
whose embedded version has fallen behind D1.

## Why the metadata is in the body, not only in headers

The snapshot body embeds `snapshotVersion`, `generatedAt` and `sourceUpdatedAt`.
The public routes return them inside the `ReadResult` envelope, and the routes
additionally set HTTP headers. Both are deliberate.

Embedding the version in the body is what makes repair possible without a second
read: `repairSnapshots` parses the KV payload and compares `cached.snapshotVersion`
against the page row directly. `generatedAt` is what `ageSeconds` is computed
from at read time, and `sourceUpdatedAt` records when the underlying page row
last changed, which is a different fact from when the document was assembled.

One precision, because the two shapes are easy to conflate: `stale` is **not** a
member of the `Snapshot` document. It belongs to `ReadResult`, the envelope the
public routes return, alongside `source`, `ageSeconds`, `aged` and `errors`. The
document records what was published; the envelope records what the read chain
did to obtain it. A caller that receives only a `Snapshot` — the Atom feed reads
one, and `apps/web/lib/allclear-api.ts` models one — has no `stale` field at all.

## Why KV and not R2

The published artefact is a single small JSON document keyed by slug, read on
every page view and written on every write. It is stored in the KV namespace
bound as `SNAPSHOT_KV`; both Workers declare that binding, and there is no R2
binding anywhere in the repository.

The choice is deliberate, and the reasons are three:

1. **The payload is small.** The document is tens of kilobytes — a component
   tree, a bounded change history, ninety daily rows per component. R2's
   advantages (unbounded object size, range reads, a global CDN in front of
   infrequently-read large objects) are not exercised by a document this size, so
   the migration would buy nothing the workload needs.
2. **R2's cost profile is a poor fit here.** R2 charges for operations and, on
   some paths, egress; the whole point of storing the artefact on Cloudflare is
   that reads are cheap. For a document read on every page view, KV's read pricing
   is the better shape. "Zero egress fees" is a real R2 advantage but an
   irrelevant one when the artefact is small and the reads are many.
3. **Dual-writing adds an inconsistency surface for no benefit.** Keeping the
   same document in two stores means two things to keep in step, two failure
   modes, and a new question — "which copy is authoritative?" — that the system
   does not currently have to answer. The read chain already has a
   last-known-good fallback (`snapshot:<slug>:last`) and a colo-local copy; a
   third store would be a third copy to reason about, and the plan's own
   constraint is to accept a bounded eventual consistency rather than add
   machinery to shrink it.

So the read path needs read-after-write on two fixed keys with a last-known-good
fallback, and KV provides exactly that with no extra moving parts. If the payload
ever grows past what KV handles comfortably, or reads ever need to be ranged over
a large object, R2 becomes the right answer — but that is a change to revisit
when the shape of the data changes, not a hedge to build in now.

## What this document does not claim

* **The colo-local cache is not a consistency mechanism, and its coverage is
  unmeasured in production.** `caches.default` is used (see above), but it only
  helps reads in the data centre that populated it, it is not replicated, and its
  real hit rate under a genuine KV outage has not been measured against a live
  deployment. The unit tests prove the layer behaves correctly when called; they
  do not prove it rescues a real outage.
* **"About sixty seconds" is an optimisation target, not a bound.** The code runs
  a once-a-minute repair pass and documents that a KV propagation delay is
  undetectable on the `kv-fresh` path. It enforces no propagation deadline,
  because KV exposes no way to. The figure is what the design aims for, not a
  promise about what any given read will see.
* **The cron repair pass is untested.** It was exercised incidentally in M0 and
  has no dedicated test in the current suite.
* **KV propagation is not simulated in the tests.** The D1-failure path is
  exercised with a database stand-in that throws; a real KV propagation delay is
  not reproduced, and `stale` is not asserted to fire on one.
* **The status page renders this contract, but its visual fidelity is only
  verified by construction.** `apps/web/app/status/[slug]/page.tsx` consumes
  `ReadResult` from `packages/shared` — `apps/web/lib/allclear-api.ts` no longer
  re-declares the shape — so the page cannot render a field the API does not
  write. What is *not* claimed is that the page looks like any particular
  reference; `docs/spec/visual-parity.md` records what was and was not checked,
  and the honest answer there is that the design language is independently
  written and only the functional behaviour is asserted.
* **`days` reports whatever the rollup last wrote.** The snapshot embeds
  `daily_uptime` as-is; it does not recompute it. The rows are produced by
  `apps/api/src/lib/uptime-recompute.ts`, which cron runs for the two days a
  transition could have touched and again hourly for every component. A component
  with no probe results has no coverage, so its rows carry `uptime: null` rather
  than a fabricated 100. The uptime maths itself is documented separately in
  `docs/spec/uptime-math.md`.
