# The snapshot and the read chain

The contract is `packages/shared/src/snapshot.ts`; status derivation is
`packages/shared/src/status.ts`. The API owns summary construction, caching and
checkpoint scheduling. This describes the low-write pipeline, not production
acceptance or a free-tier capacity guarantee.

## One document, three clocks

A snapshot carries evidence, not a stored current component status. Readers call
`deriveSnapshotComponent(component, now)` to evaluate impacts, maintenance and
probe evidence at their own clock. A newly assembled document cannot make an
old probe healthy.

| Field | Meaning |
| --- | --- |
| `generatedAt` | When this summary document was assembled. |
| `sourceUpdatedAt` | When the underlying page row last changed. |
| `historyComputedAt?: number \| null` | When the embedded daily history was last computed; epoch seconds, **not ISO text**. Missing on legacy documents; null means unavailable. |
| `component.probe.lastProbeAt` | The actual observation time, independent of all summary timestamps. |
| `component.statusFreshnessMax` | Maximum acceptable age of that observation. |

The default probe interval remains 60 seconds. Freshness remains
`max(2 * interval, 120)`, hence 120 seconds for a 60-second target. No target, no
observation, expired evidence, or a fresh failure with no classified impact is
`unknown`, not fabricated uptime. Active recorded impacts and maintenance still
participate in derivation.

Daily history is materialized in `daily_uptime`, embedded oldest first, and
normally recomputed on a separate 300-second cadence. The history timestamp is
not a promise that every historical day was remeasured at that instant. Missing
coverage stays unknown; `SnapshotDay.uptime` can be null. Historical windows,
late corrections and failures can differ from the live evidence. Retention is
performed daily rather than per minute.

The payload retains its bounds: 90 daily rows per component, up to 50 embedded
changes, and a 30-day recent-change horizon.

## Normal reads use a materialized D1 summary

The API stores the assembled JSON summary in D1. Summary construction uses one
SQL statement with correlated JSON aggregation, rather than a per-page-view
multi-query rebuild. Public reads normally use one point query for this materialized document or
its short-lived cache copy. A missing/revision-mismatched summary triggers a
read-only single-SQL assembly (`d1-rebuild`). Public reads write neither D1 nor
KV, only best-effort cache. If background repair keeps failing and Cache API is
unavailable, repeated requests can each repeat full assembly; not every read is
guaranteed to remain a cheap point lookup.

| `source` | Meaning | `stale` |
| --- | --- | --- |
| `cache-live` | Short-lived copy of the D1 summary, with a 30-second hot-cache lifetime. | `false` |
| `d1-live` | Current materialized D1 summary. | `false` |
| `d1-rebuild` | Compatibility/repair path that assembled a summary from D1. | `false` |
| `kv-fresh` | First KV checkpoint fallback; the historical name does **not** confirm current D1 state. | `true` |
| `kv-last` | Last-known-good KV checkpoint fallback. | `true` |
| `cache` | Legacy fallback cache, not the live hot cache. | `true` |
| `none` | No document is available. | `true` |

The order is live hot cache → revision-matched D1 summary → read-only D1
assembly if missing/mismatched → first KV checkpoint → last KV checkpoint →
one-hour local fallback cache → no document (503). The local fallback is not
the 30-second live hot cache.

The legacy source values remain in `SnapshotSource` so existing consumers can
read them. The new normal-path values are `d1-live` and `cache-live`.

A fallback is unconfirmed even if it was written recently. The status page warns
about that provenance while still deriving component statuses from the actual
evidence and reader clock. It never substitutes `generatedAt` for `lastProbeAt`.

## Writes, checkpoints and budgets

Admin mutations update the D1 summary immediately server-side. Successful probe
observations refresh live evidence even without an impact transition. This
replaces the old transition-only publication path, which could leave a healthy
probe's public timestamp frozen.

This does **not** promise global linearizability. A location with a populated
hot cache can retain the previous summary for up to its 30-second lifetime;
other locations can have a different cache state. Cache invalidation at the
writer is not a global purge or a cross-location read-after-write guarantee.

KV is an independent fallback checkpoint, not the normal publication authority:

| Key | Purpose |
| --- | --- |
| `snapshot:<slug>` | First fallback checkpoint. |
| `snapshot:<slug>:last` | Last-known-good fallback checkpoint. |

Checkpoints are due every 600 seconds and write two keys. Admission is budgeted
across the deployment, so a due checkpoint can be delayed or skipped. The default
periodic ceiling is 288 KV put attempts per UTC day **globally across all pages**,
not per page; the total ceiling including events/repairs is 800 attempts. These
are application budgets, not a guarantee about account-wide usage or allowance.
Other applications and resources can consume the same account quota. Repairs
and admin activity do not imply an unlimited checkpoint write or an immediate
KV update; normal reads do not replenish KV. Neither key relies on TTL expiry
for refresh, and `:last` must remain available during D1 failure. If D1 cannot
be read, do not replace an existing checkpoint with an empty document.

`page.snapshot_version` identifies public content revisions. Probe evidence,
assembly time, history computation time and checkpoint time are separate facts;
a matching version is not sufficient reason to skip refreshing those clocks.
A rebuild is a repair tool, not a way to bypass cache or checkpoint budgets.

## ReadResult and HTTP behavior

Required `ReadResult` fields are unchanged:

| Field | Meaning |
| --- | --- |
| `snapshot` | Document, or null when there is nothing to serve. |
| `source` | Provenance of this read. |
| `stale` | Whether the live summary could not be confirmed. |
| `ageSeconds` | `max(0, now - generatedAt)`, or null without a document. |
| `aged` | Whether assembly age exceeds the warning threshold (default 300 seconds). |
| `errors` | Read-chain diagnostics; logged, not displayed as storage internals. |

A stable summary can be old without being unconfirmed. Conversely a recent
checkpoint can be unconfirmed without being old. Neither flag says when history
was computed or when the service was probed.

The API's `/api/status/:slug` and `/snapshot.json` routes return this envelope.
The web route `/status/:slug/snapshot.json` preserves the API's body and status
and explicitly sets `Cache-Control: no-store`; there is no additional
`stale-while-revalidate` window. No document means HTTP 503, not a healthy-looking
empty 200. The HTML page derives status per request.

The web Atom route uses the same snapshot and shared feed builder, with public
self/alternate URLs. It returns recorded incident/maintenance entries, not a
current-health signal or a history-freshness assertion. Entry ids and change
timestamps remain unchanged; neither request time nor `historyComputedAt`
becomes an invented incident update. A fallback feed preserves recorded entries,
reports source/staleness in `X-AllClear-Source` / `X-AllClear-Stale`, and is
`no-store`; no document produces 503.

## Verification boundary

Shared tests cover backward-compatible optional metadata, epoch-second history
time, the unchanged read envelope, source values, and stale/uncovered probe
derivation independent of summary assembly time. API tests must establish the
normal D1 path, hot-cache expiry, fallback ordering, successful-observation
refresh, and checkpoint-budget behavior. Frontend fixtures cover live, cached,
fallback, missing/null history time and unavailable documents.

Local tests do not establish real cross-location cache behavior, outage recovery,
free-tier capacity, provider billing, or production freshness. Validate those in
your own environment before making operational promises. No Durable Object or
R2 is required by this pipeline.
