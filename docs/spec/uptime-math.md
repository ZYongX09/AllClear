# Uptime maths (M3)

**Status: implemented and tested.** The algorithm is
`packages/shared/src/uptime.ts`. `packages/shared/test/uptime.test.ts` is the unit
evidence, and its test names enumerate the cases the algorithm is required to
handle. Materialising a day into the `daily_uptime` table is
`apps/api/src/lib/uptime-recompute.ts`, with
`apps/api/test/uptime-retention.test.ts` as integration evidence including the
retention interaction. The table definition is in
`apps/api/migrations/0002_m1_model.sql`. This document explains the design and, at
the end, what it does not claim.

## The one invariant

`impact` is the only place a duration is recorded; nothing else in the schema
stores a span to be summed (see [data-model.md](data-model.md)). Uptime is
therefore always *computed from recorded intervals* rather than asserted, and a
component cannot report 100% while an impact is open. Everything below exists to
compute one ratio —

    uptime = 1 - weightedDowntimeSeconds / coveredSeconds

— without inventing evidence and without losing it.

## Sweep, do not union

The plausible-but-wrong calculation sums the duration of each active impact. That
double-counts whenever two impacts overlap. The usual repair — union the intervals
per severity, then add the severities together — still double-counts when a
`partial_outage` and a `full_outage` overlap in time: the overlapping minute is
charged once at weight 0.5 and again at weight 1.0, so the numerator can exceed the
window and the uptime can fall below zero.

The implemented algorithm instead cuts the window at every impact boundary into
non-overlapping segments, and charges each segment exactly once at the worst weight
active during it:

    D_weighted = sum over segments of (delta_t × max weight active in the segment)

Because the cuts include every boundary of every interval involved, each interval
either covers a segment entirely or not at all, which is what makes the
per-segment maximum exact rather than approximate. The resulting `segments` array
is exposed on the result for tests and diagnostics, and one test asserts that the
segments partition the window exactly once with no gap and no overlap.

Two consequences follow from "worst weight in the segment". Two faults of the same
severity that overlap are a union, not a sum: the overlapping stretch is charged
once. Two faults of different severities that overlap are charged once at the worse
one. When two active faults have equal weight but different severities — only
possible with custom weights, because the defaults are all distinct — the
tie-break falls back to the documented `FAULT_RANK` ordering in
`packages/shared/src/status.ts`, so the choice is deterministic rather than
dependent on array order.

## Window clipping and `available_since`

The window under evaluation is the intersection of the requested window, the
component's lifetime, and the evaluation instant:

    start = max(windowStart, availableSince)
    end   = min(windowEnd, max(now, start))

`availableSince` is when the component first existed, so a window that predates it
is not an outage and not uptime either — the time simply is not in scope. If the
intersection is empty (the component did not exist yet, or the whole window is in
the future) the result is a zero-length span and therefore `uptime: null` with
empty segments, rather than a fabricated 100%. `now` clips the window so that a
partial day is measured only up to the present and never extrapolated.

## Coverage is evidence, and it is built from adjacent samples

A probe *samples*; it does not observe continuously. `computeCoverageIntervals`
turns a sorted, duplicate-free list of observation timestamps into coverage
intervals by taking each adjacent pair whose gap is no larger than `gapMax` and
merging qualifying pairs that share an endpoint into a single run. Coverage is
therefore the union of `[r_k, r_{k+1})` over adjacent pairs, and — deliberately —
it does not include any tail after the final observation. Extending coverage to
"the next sample should have arrived by now" would credit a prober that has stopped
reporting, which is the exact failure the coverage concept exists to catch.

Two facts surprise people and are worth stating plainly. First, a component with a
single observation has *no* coverage, not full coverage: one sample cannot bracket
anything, so there is nothing for a fault to intersect with. Second, a fault that
is still open when the prober stops is charged only over the covered part; the
unmonitored remainder is not charged as downtime.

The default gap threshold is `defaultCoverageGapMax(interval) = max(2 × interval,
120)` seconds, so it tolerates one missed sample and never drops below two minutes.
`computeDailyUptime` derives `interval` as the largest `interval_seconds` among the
component's enabled targets, defaulting to 60 when there are none.

## Two sources of impact, treated differently

An impact is classified by whether `impact.probe_target_id` is set. The recompute
does not infer this from the severity or the timestamps; the presence of a target
id is the only signal that the interval came from sampling rather than from a human.

* **Probe-sourced** (`probe_target_id` set) is a *sample*. Its boundaries are two
  probe observations, and if the prober dies the impact can stay open forever. It
  is therefore intersected with the coverage intervals, and only the overlap is
  counted.
* **Hand-recorded** (`probe_target_id` null) is *direct evidence* from a human. It
  passes through whole and counts wherever it falls, even on a component with no
  probe target at all.

The distinction is what lets the system say "we measured this much, and no more"
instead of either charging an unmonitored week as downtime or hiding a
human-recorded outage that no probe happened to cover.

An `impact` row whose severity is literally `maintenance` is treated as a
maintenance window rather than a fault, and any severity outside the three fault
values is ignored. Both behaviours are in `computeDailyUptime`.

## Maintenance is removed from the denominator, but cannot hide a fault

Declared maintenance windows are excluded from the denominator: time the operator
has announced as planned work is not time the service was expected to be available.
But the ordering rule inside the sweep is that a real fault outranks a maintenance
declaration. A segment that is inside a maintenance window *and* has a non-zero
fault weight is counted as covered downtime, not excluded. Without that rule, a
conveniently placed maintenance window could launder real downtime out of the
record.

The recompute selects maintenance from `change` joined through `change_component`,
requiring `kind = 'maintenance'` and an overlap with the day — deliberately **not**
by `ch.status`. A status filter there looks reasonable and is wrong in both
directions:

* `status <> 'completed'` makes a past day's uptime move retroactively. The window
  is deducted while the maintenance runs and counted once someone marks it
  completed, so the same historical day reports a worse number after the fact, and
  planned downtime inside an announced window is charged as an outage once the
  window ends.
* `status = 'in_progress'` has the same defect, plus one more: a window whose
  operator never posted the update that moves it out of `scheduled` is silently
  ignored.

What decides whether a window applies is its *start time*, and the overlap test
already answers that: `starts_at` carries the announced start, so a window that has
not begun does not intersect the day. Nothing is hidden by dropping the status
filter, because the fault-outranks-maintenance rule above keeps every segment with
a non-zero fault weight counted regardless of the window it sits in.

> This was a real defect, fixed on 2026-10-15. The earlier query filtered on
> `status <> 'completed'`, and a test asserted that a completed window contributes
> nothing. Both were reversed, and
> `apps/api/test/uptime-retention.test.ts` now pins the stable behaviour: a
> completed window still excludes its day, a `scheduled` window whose start has
> passed excludes its day, and a window that has not started does not.

## A zero denominator is `null`, never 100

`uptime` is `null` whenever `coveredSeconds` is zero — no coverage at all, a window
entirely excluded as maintenance, or an empty span. Returning 1.0 there would
manufacture a perfect record out of an absence of measurement, which is the single
most misleading number this system could print. The same rule is enforced at the
storage layer: `daily_uptime.uptime` is nullable, and the migration comment says so
explicitly.

## An unmeasured period is `unknown`, not `operational`

Each segment is accounted for in exactly one of three ways, and the choice is what
drives `worstStatus`:

| Segment | Condition | Counted as |
| --- | --- | --- |
| covered | it has coverage evidence, or a hand-recorded fault | denominator and numerator |
| excluded | it is maintenance and has no fault | neither (removed from the denominator) |
| unknown | it has neither coverage nor a hand-recorded record | neither (excluded from the denominator) |

`worstStatus` is then derived in this order: any fault severity that was actually
counted wins; otherwise a window with no covered seconds is `maintenance` if
something was excluded and `unknown` if nothing was; otherwise `unknown` if unknown
time outlasts covered time; otherwise `maintenance` if anything was excluded;
otherwise `operational`. The awkward middle case is deliberate: a day that was
unmeasurable for most of its length is not a healthy day, so `unknown` beats
`operational` there. A window with no coverage at all is `unknown`, never
`operational`, which is the same principle as the null rule above.

## The three markings: `null`, `partial`, `ongoing`

| Field | Type | Meaning |
| --- | --- | --- |
| `uptime` | `number \| null` | `null` when there is nothing measurable (zero denominator). |
| `partial` | `boolean` | `windowEnd > now`: the window extends past the evaluation instant, so today or a partial day. |
| `ongoing` | `boolean` | Some input impact has `endAt === null` and `startAt <= now`. |

`partial` says the answer is provisional because the window is not over. `ongoing`
says a fault had not closed at `now`. `uptime` being `null` is orthogonal to both:
a fully covered, clean, complete window is `1`, and a partially covered one is
whatever the covered seconds support.

## Severity weights

`DEFAULT_WEIGHTS` sets `degraded_performance` at 0.25, `partial_outage` at 0.5 and
`full_outage` at 1. This is a stated convention, not a measurement. It is a
parameter (`UptimeInput.weights`) rather than a constant baked into the algorithm,
because the right ratio is a judgement about a particular service and the algorithm
must not silently encode someone else's. The numerator is clamped to `[0, 1]` on
the way out, and `clamp01` maps non-finite values to 0 so a bad weight cannot leak
a `NaN` into a stored row.

## Aggregation sums seconds, not percentages

`aggregateUptime` folds several components' results by summing `coveredSeconds` and
`weightedDowntimeSeconds` and taking the ratio once. It is deliberately not an
average of per-component percentages: averaging lets one unmeasured component
dilute a real outage and lets a component with one second of coverage weigh as much
as one with a full day. Summing the raw seconds makes every second of evidence
count exactly once regardless of which component produced it. The result is `null`
when no component contributed measurable time.

## Why `daily_uptime` exists, and how it stays honest

`daily_uptime` holds the historical aggregate. Computing ninety days from
`probe_result` on every page view would be thousands of rows per request. The
materialized live summary embeds those daily rows without recomputing them.

The exact full-day recompute remains the repair and validation oracle. Routine
history work runs every 300 seconds using an incremental prefix: additive covered,
unknown, excluded, weighted-downtime and counted fault-severity totals are stored
on the daily row. Only the interval through an actual observed boundary is
checkpointed. The remaining tail is evaluated afresh, so a stopped probe never
receives invented coverage and later qualifying observations can still bracket
previously unknown time.

The daily public result and its prefix commit in one revision-guarded upsert.
Within a revision, delayed shorter prefixes cannot overwrite longer ones;
meaningful event or configuration changes invalidate the prefix and use the exact
oracle instead. Status derives from the combined counters and counted severities,
not the maximum of prefix/tail status labels or an average of their percentages.

`historyComputedAt` records actual computation work in epoch seconds; assembling
a live summary must not advance it or claim every historical day was refreshed.
Current-state summaries reuse a revision-matched cached history fragment, with
sparse component/day invalidation rather than rereading ninety days per minute.

The recompute reads coverage from one `gapMax` before the day through one
`gapMax` after it, bounded by `now`. Actual observations on both sides of midnight
can bracket the boundary; future scheduled observations never count as evidence.
Routine work recomputes today every 300 seconds. Impact transitions recompute
today and yesterday together. A persisted finalization cursor processes closed
days after a probe-interval-dependent grace period and catches up one day per
tick after missed runs. Current status still derives from live evidence; history
can legitimately lag and its computation time is displayed separately.

### Historical edits and late evidence

Impact interval/severity edits, maintenance membership or window changes, probe
configuration, and component lifetime changes advance a separate rollup revision.
Ordinary accepted append-only observations do not invalidate an existing prefix.
Direct raw imports and component-wide out-of-order evidence are exceptional and
must invalidate concurrent computations, including a predecessor day's midnight
coverage dependency.

Today and confirmed probe transitions retain priority. Persisted historical
repair processes retained, unarchived component-days in bounded steps, including
missing days reached by a backdated edit; a restart does not discard the cursor.
A newer mutation revision prevents an older worker from advancing or clearing its
repair state. This is eventual historical repair, not a promise that an edit
recalculates every affected date in the request that saved it.

## Retention interaction: roll up before deleting

Retention normally runs once per UTC day, with bounded catch-up chunks when
expired work remains. The cutoff is UTC midnight thirty days before today.
`apps/api/src/lib/retention.ts` processes one component-day per scheduled chunk:
its aggregate is materialized and marked `archived` in the same transaction that
purges that day's raw observations. Failure rolls back the chunk and preserves
the evidence for retry; already committed chunks remain valid.

After seeking the initial actual evidence date, the archive cursor advances
through every intervening day, not just dates containing a sample. Neighboring
observations or a manual impact can account for a sample-free day. Purging keeps
the predecessor needed to bracket the next day and the accepted result referenced
by `probe_state.last_result_id`; these anchors can survive beyond thirty days.
Once catch-up completes, persisted scheduling prevents repeated scans that day.

Archived aggregates are sealed: routine recomputation cannot overwrite them using
purged evidence. Consequently, retroactive incident or maintenance edits do not
automatically recalculate sealed days. Correcting those aggregates requires an
explicit evidence-backed archival repair; the API must not imply that editing an
old event restores observations that retention already deleted.

## Worked cases pinned by the tests

All figures below are the exact values asserted in
`packages/shared/test/uptime.test.ts` and
`apps/api/test/uptime-retention.test.ts`. In the unit file the window is one full
day (`86400 s`), `availableSince` predates it, and `now` is just past its end. In
the integration file the day is `2023-11-14` with `interval_seconds = 300`, so
`gapMax = 600`.

| Case | Inputs | Weighted downtime | Covered seconds | Uptime | Source |
| --- | --- | --- | --- | --- | --- |
| clean, fully covered day | coverage spans the day, no impacts | 0 | 86400 | 1 | unit |
| single full outage for one hour | probe `full_outage` over `[0, 3600)` | 3600 | 86400 | `1 - 3600/86400` | unit |
| same-hour full and partial outage | both over `[0, 3600)` | 3600 | 86400 | > 0 | unit |
| partial overlap of two severities | `full` `[0,3600)`, `partial` `[1800,5400)` | 1800 + 1800 + 900 = 4500 | 86400 | — | unit |
| same-severity overlap | two `degraded` intervals unioning to 5400 s | 5400 × 0.25 = 1350 | 86400 | — | unit |
| extreme custom weight | `full_outage` weight 4 over the whole day | 345600 | 86400 | 0 (clamped) | unit |
| fault crossing midnight | `full` `[W1-1800, W1+1800)` | 1800 (yesterday) + 1800 (today) | — | — | unit |
| fully covered healthy day | 300 s samples across the day | 0 | 86100 | 1 | integration |
| probe fault clipped to coverage | 600 s of coverage, `partial` fault all day | 300 | 600 | 0.5 | integration |
| hand-recorded hour, no coverage | manual `full_outage` `[0, 3600)` | 3600 | 3600 | 0 | integration |
| overlapping severities, no double charge | manual `partial` `[0,7200)`, `full` `[3600,7200)` | 1800 + 3600 = 5400 | 86100 | `1 - 5400/86100` | integration |
| maintenance covers the whole day | window over the day, no fault | 0 | 0 | `null` | integration |
| real fault inside maintenance | whole-day window plus a manual `full` hour | 3600 | 3600 | 0 | integration |
| completed window still excludes | whole-day window, change later marked `completed` | 0 | 0 | `null` | integration |
| scheduled window with a past start | whole-day `scheduled` window | 0 | 0 | `null` | integration |
| window that has not started | window starting after `now` | 0 | 3600 | 1 | integration |

The "same-hour full and partial outage" case is the one that motivates the whole
design: a per-severity union followed by a sum would report `3600 × 1.0 + 3600 ×
0.5 = 5400` seconds of downtime inside a 3600-second span, and an uptime that goes
below zero once the overlap is large enough. The sweep reports 3600.

The "fully covered healthy day" case is the other instructive one. The samples run
every 300 seconds, so the merged coverage reaches the second-to-last sample and
stops: the final 300 seconds of the day have no following observation to bracket
them, so they are `unknown`, not `operational`. Coverage does not extend past the
final observation, and the test asserts the resulting 86100 covered / 300 unknown
split explicitly.

## What this does not claim

* **Production latency is not measured.** The algorithm is tested against exact
  arithmetic; no production deployment has been observed.
* **The weight ratio is a convention, not a calibration.** 0.25 / 0.5 / 1 is a
  stated choice and is overridable per call.
* **Maintenance is selected by window, not by change status — reconciled.** The
  recompute no longer filters on `ch.status` at all (see
  [Maintenance is removed from the denominator](#maintenance-is-removed-from-the-denominator-but-cannot-hide-a-fault)).
  This is deliberately *not* the same rule as status derivation, which counts only
  `in_progress` maintenance inside its window
  (`packages/shared/src/status.ts`). The two answer different questions: "what is
  this component's status right now" versus "how much of that day was planned
  downtime". A day is now stable under later status changes, which the previous
  filter was not. Three tests cover the `scheduled`-with-past-start,
  `scheduled`-not-yet-started and `completed` cases.
* **`ongoing` is reported false when the evaluated span is empty.** The early
  return for a zero-length span hard-codes `ongoing: false` even if an input impact
  is open, because there is no span in which to evaluate it. In practice this only
  occurs when the component did not exist or the window is entirely in the future.
* **The table is read, but only through one bounded window.** `buildSnapshot`
  (`apps/api/src/snapshot.ts`) reads up to `HISTORY_DAYS = 90` daily rows per
  component and embeds them in the served snapshot, so the table is the read path
  for the public daily history rather than a write-only cache. Nothing here claims
  a wider history than that window, and no production read load has been measured.
* **History has its own clock.** Recent history runs on a 300-second cadence;
  the thirty-day boundary rollup belongs to the daily retention pass. Neither
  is a claim that all retained days were remeasured at summary assembly time.

## Running

```bash
cd packages/shared && npm test     # the algorithm and its unit matrix
cd apps/api && npm test            # materialisation, retention, integration
```

The tests need no network and no credentials.
