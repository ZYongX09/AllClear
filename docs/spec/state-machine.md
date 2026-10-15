# Probe fault state machine (M1)

**Status: implemented and tested.** `apps/api/src/probe/transition.ts` is the
implementation; `apps/api/test/transition.test.ts` and
`apps/api/test/d1-semantics.test.ts` are the evidence. This document explains the
design and, at the end, what it does not claim.

## The operation

One function, `applyProbeObservation`, takes a single probe execution's result
and makes four things agree:

1. the observation is recorded (`probe_result`),
2. the target's counters advance (`probe_state`),
3. an impact opens or closes if the thresholds say so (`impact`),
4. the state change is logged (`probe_transition`).

If those four can disagree, the system will eventually report an outage that
never closed, or miss one that did. Everything below follows from that.

## The four timestamps

The plan called out a specific error: treating a probe result as the real
start or end of a fault. A probe *samples*. With `failure_threshold = 3` and a
60 s interval, the impact is confirmed on the third failure, but the outage began
on the first.

Four quantities are therefore stored separately:

| Quantity | Where | Meaning |
| --- | --- | --- |
| `first_failed_at` | `probe_state` | First observation of the current failure run. |
| `detected_at` | `probe_transition` | The observation that met the failure threshold. |
| `first_recovery_at` | `probe_state` | First observation of the current success run. |
| `resolved_at` | `probe_transition` | The observation that met the recovery threshold. |

And the interval uses the first pair, not the second:

* `impact.start_at = first_failed_at`
* `impact.end_at = first_recovery_at`
* `impact.estimated = 1`

Confirmation times stay on `probe_transition`, so the fault interval stays a
clean estimate and the detection delay stays separately measurable.

**Nominal detection lag** is `(failure_threshold − 1) × interval_seconds`. Total
confirmation delay is that plus the time before the first observation (up to one
interval) plus cron scheduling jitter. The system does not promise a bound: the
cron runs once a minute, so the third quantity is real and unbounded from inside
the Worker. `docs/spec/probe.md` (M3) will state the measured figure rather than
an arithmetic one.

## Atomicity

### Why one `db.batch()`

`batch()` runs its statements in a single transaction, so all four writes commit
together or none does. That is what prevents "counter updated, impact insert
failed", which would otherwise leave a target whose counters say it is failing
and whose impact table says it is fine.

### Why a compare-and-swap

`batch()` being transactional does not make it serialisable against *another*
batch. Two cron invocations can both read `transition_seq = 5` and both decide to
open an impact. The counter update is therefore a compare-and-swap on the
sequence that was read, so a writer that lost the race matches zero rows.

**A zero-row `UPDATE` is not an error in SQL** — it does not abort the batch. So
each dependent statement needs its own guard, and a zero-row result has to be
inspected explicitly (`meta.changes`).

### Why a nonce on top of the sequence

The obvious guard — `transition_seq = <the sequence I read> + 1` — is wrong, and
the tests caught it. That condition is satisfied both by *this* batch's write and
by a concurrent batch that started from the same sequence, so it cannot tell
"I won" from "someone else won". Two simultaneous deliveries of the same
observation both satisfied it, both tried to log the transition, and the run
failed on a `UNIQUE` constraint — lucky, but not a design.

The guard is instead a per-attempt nonce. The CAS writes
`probe_state.last_batch_nonce = <token>`; every dependent statement tests
`last_batch_nonce = <the same token>`. Only the batch whose CAS committed finds
its own token in the row.

### Why the CAS runs first

The observation is recorded **after** the CAS, guarded by the same nonce. The
first version recorded it first, and that was a real bug, not a style choice: a
batch that lost the CAS still committed its `probe_result` row (zero-row guards
make the *other* statements no-ops; they do not roll the batch back). The retry
then re-ran the insert, saw `INSERT OR IGNORE` change nothing, and reported the
observation as a **replay** — a lost failure reported as a duplicate, with its
counter never incremented.

With the insert after the CAS, a losing batch writes nothing at all, and
`probe_result` holds exactly the samples that were accepted into the state
machine. That is also the set the coverage maths should see.

### Statement order in the batch

| # | Statement | Guard |
| --- | --- | --- |
| S1 | `CAS_STATE_SQL` — counters, sequence, nonce | `transition_seq = ?`, `last_result_id IS NOT ?`, `last_probe_at <= ?` |
| S2 | `INSERT_RESULT_SQL` | `last_batch_nonce = ?` |
| S3 | `OPEN_IMPACT_SQL` | nonce, threshold met, no open impact |
| S4 | `CLOSE_IMPACT_SQL` | nonce, recovery threshold met, an impact is open |
| S5 | `MIRROR_OPEN_IMPACT_SQL` | nonce |
| S6 | `LOG_TRANSITION_SQL` | nonce, `to_state <> from_state` |

S5 recomputes `probe_state.open_impact_id` from `impact` rather than
incrementing it, so it also repairs drift from an earlier failure.

## Idempotency

The idempotency key is the **observation**: `probe_result.public_id`, a ULID the
prober generates once and reuses verbatim across retries.

The dangerous retry is not "the batch failed" — that rolls back cleanly — but
"the batch committed and the caller did not find out". Replaying then sees
counters that already include the observation. Guarding on `transition_seq`
alone would not catch that, because the sequence has legitimately moved on.
`last_result_id` does: it records which observation was last applied, so
"already applied" is a fact that can be **read** rather than inferred.

Replay and out-of-order are decided from persisted state alone, both before an
attempt and after a zero-row CAS, so a caller that lost the race reaches the same
conclusion the caller that won it would.

## Outcomes

`applyProbeObservation` returns one of:

| Outcome | Meaning | Caller should |
| --- | --- | --- |
| `applied` | Processed. `transition` is `opened`, `closed` or `none`. | Move on. |
| `replay` | This exact observation was already applied. Nothing was written. | Move on. |
| `stale` / `out_of_order` | A newer observation was already processed; counting this one would rewind the counters. | Drop it. |
| `stale` / `contended` | The CAS kept losing for `maxAttempts` attempts. | Log; retry later if it matters. |
| `unconfigured` | No `probe_target`/`probe_state` row. | Provisioning bug. |
| `anomaly` | The guards and the intended transition disagreed, or a backstop constraint kept rejecting the write. The batch rolled back, so no partial write survives. | **Bug report.** |

`anomaly` exists so that a broken guard surfaces as a loud failure rather than as
a half-correct state. It is checked in both directions: a transition that was
decided but did not apply, and an impact that applied when none was decided.

## What this deliberately does not promise

* **Not every sample is counted under contention.** An observation older than one
  already processed is rejected rather than counted, and under N-way contention a
  caller can exhaust its attempts and be told `contended`. Both mean a real
  sample went uncounted, and both are reported rather than swallowed. In normal
  operation each target is polled once per interval by one scheduler, so
  contention is limited to overlapping cron runs. The burst test exists to show
  the state stays *consistent*, not that every sample of an artificial N-way race
  is counted.
* **`maxAttempts` is a bound, not a guarantee.** The default of 5 covers two
  overlapping cron runs with margin.
* **No retry queue.** A `contended` result is the caller's problem; nothing
  requeues it.
* **No retention.** `probe_result` grows; the 30-day fold into `daily_uptime` is
  M3.
* **Detection latency is not measured.** The nominal figure is arithmetic. The
  real figure depends on cron behaviour on a real deployment, which is M3.
* **The prober does not exist.** This module is called by tests only. The
  scheduler, the fetch with its timeout and SSRF rules, and the coverage
  accounting are all M3.

## Test matrix

Every test below runs against a real `workerd` with a real D1 binding, not a
mock. That is deliberate: the design depends on specific SQLite behaviour —
`batch()` rolling back as one transaction, a conditional `UPDATE` matching zero
rows without raising, partial unique indexes, `meta.changes` — and a mock would
assert beliefs about those instead of the behaviour itself.

### `d1-semantics.test.ts` — measured, not assumed

| Test | Proves |
| --- | --- |
| lets exactly one of two concurrent compare-and-swaps apply | Concurrent batches do serialise the CAS, and the loser is reported as `changes: 0`, not as an error. |
| rejects the loser when two concurrent batches insert the same unique key | A constraint violation is a *reachable* outcome of a race, which is why the code translates it into a retry instead of throwing. |

### `transition.test.ts` — the state machine

| Test | Proves |
| --- | --- |
| records failures below the threshold without opening anything | Thresholds are respected; no impact for a blip. |
| opens exactly one impact when the threshold is reached | The happy path. |
| does not open a second impact while one is already open | No duplicate incidents for one ongoing fault. |
| logs the transition with the confirmation time kept apart from the fault start | `impact.start_at` is the first failure; `detected_at` is the confirming one. |
| does not close before the recovery threshold is reached | A single success does not clear an outage. |
| closes at the recovery threshold using the first recovery time | `impact.end_at` is the first success of the run. |
| opens a new impact when the target fails again | The partial unique index permits a second impact once the first is closed. |
| resets the failure run when a success intervenes | "Consecutive" means consecutive. |
| treats a repeated observation as a replay | Idempotency by observation id. |
| does not re-transition when the observation that opened the impact is replayed | Replay is a no-op for the impact too, not just the counters. |
| rejects an out-of-order observation instead of rewinding the counters | A delayed delivery cannot move state backwards. |
| produces one impact when two observations for the same target race | Regression guard for the lost-failure-reported-as-replay bug. |
| applies a doubly delivered observation only once | Concurrent duplicate delivery is safe. |
| never leaves two open impacts after a burst of concurrent failures | Consistency under 8-way contention. |
| rolls the counter update back when a later statement in the batch fails | **`batch()` is one transaction.** The failure is asserted to be the primary-key collision, not a binding error, so the test cannot pass for the wrong reason. |
| forbids a second open impact for the same target | The backstop index works. |
| accepts a new open impact once the previous one is closed | The index is partial, not absolute. |
| reports a missing target rather than throwing | Misconfiguration is a value, not an exception. |
| advances `next_check_at` by one interval from the observation | Scheduling state is updated in the same batch. |
| records the observation itself with its status code and latency | The raw sample is persisted, not just its verdict. |

Two of these deserve emphasis because they are the plan's explicit
requirements: *two crons processing the same target at once* (the concurrency
group) and *counters updated but a later statement failing* (the
transactionality group).

## Running

```bash
cd apps/api
npm test          # vitest run
npm run typecheck
```

The tests need no network and no credentials: `@cloudflare/vitest-plugin` starts
`workerd` locally, and migrations are applied from `migrations/` into a
per-file storage snapshot. If `apps/api/migrations/0002_m1_model.sql` has been
edited after a local run, delete `apps/api/.wrangler/state` first — `ALTER TABLE`
has no idempotent form and `d1_migrations` will otherwise skip the file.
