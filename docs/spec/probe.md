# Probe scheduler and URL guard (M3)

**Status: implemented and tested.** The scheduler and per-target execution are
`apps/api/src/probe/run.ts`; the transition it feeds is
`apps/api/src/probe/transition.ts`; the outbound-request guard is
`apps/api/src/lib/ssrf.ts`; retention of raw results is
`apps/api/src/lib/retention.ts`; the cron entry point is `apps/api/src/index.ts`.
The evidence is `apps/api/test/probe-run.test.ts`, `apps/api/test/ssrf.test.ts`
and `apps/api/test/transition.test.ts`. This document covers scheduling,
execution, the URL guard, capacity and retention; the transition internals are
covered in depth by [state-machine.md](state-machine.md) and are only referenced
here.

## The operation

One cron tick calls `runProbes`. It selects the targets that are due, and for each
one it validates the URL, performs a request, and feeds the observation into
`applyProbeObservation` from `transition.ts`. Everything about *correctness* lives
in that state machine; this document is about the parts that only exist in the
scheduler — which targets a tick picks up, what happens to one whose URL the guard
refuses, how the schedule advances, and what the outbound request is allowed to be.

The return value is a report rather than a boolean, on purpose: a run that silently
did nothing and a run that probed twenty targets and opened three incidents should
not look identical in the logs. The report counts due targets, probes attempted,
configuration skips, applied/replayed/stale/unconfigured outcomes, anomalies, and
the pages and components whose derived output must be rebuilt.

## Selecting a due target

The due query is one statement:

```sql
SELECT t.id, t.component_id, c.page_id, t.url, t.method, t.expected_status,
       t.timeout_ms, t.interval_seconds
  FROM probe_target t
  JOIN component c ON c.id = t.component_id
 WHERE t.enabled = 1
   AND t.next_check_at <= ?1
 ORDER BY t.next_check_at, t.id
 LIMIT ?2
```

A target is due when it is enabled and its cursor has reached the current time.
Ordering by the cursor puts the longest-waiting targets first, and `LIMIT` enforces
the per-run cap. The summary's `due` count is the size of this *limited* result set,
not the number of due targets in the database, so a run cannot report how much work
it left for the next tick.

## The single scheduling cursor

`probe_target.next_check_at` is the only scheduling cursor. The due query reads it,
`idx_probe_target_due(enabled, next_check_at)` indexes it, and the transition batch
advances it in its own nonce-guarded statement (`S7` in `transition.ts`). The cursor
lives on `probe_target` rather than on `probe_state` because the index that makes
the due query cheap has to sit alongside `enabled`.

**The historical defect this replaces is worth recording.** An earlier revision
carried a second `next_check_at` on `probe_state`. The state machine advanced that
one, while the due query read the one on `probe_target`. The two never visibly
disagreed, because the column the scheduler actually reads was simply never
updated — so every enabled target was probed on every cron tick and
`interval_seconds` was decorative. Nothing failed and nothing logged; the only
visible symptom would have been a probe volume roughly sixty times the configured
rate.

The property that prevents it recurring is **one column, one writer per path**,
enforced by testing the column the scheduler reads rather than the column the
writer happens to touch. `probe-run.test.ts` asserts that a target is not re-probed
before its interval has elapsed, and `transition.test.ts` asserts that the cursor
advances by exactly one interval from the observation. The cursor is advanced in the
same nonce-guarded batch as the counters, so a batch that lost the compare-and-swap
records nothing and cannot push a target's next attempt out either. A probe-driven
outage that is still open does not shorten the interval: the interval is the
sampling rate the operator chose, and changing it mid-incident would make the
documented detection lag false exactly when it is being quoted.

The cursor is set to `observedAt + interval_seconds`, anchored to when the
observation was actually taken rather than to a fixed grid. A late tick therefore
delays the next attempt instead of being caught up, so the effective poll rate can
only be at or below the configured interval; the schedule does not drift ahead of
it.

## Executing one target

For each due target the scheduler does the following, in order.

1. **Validate the URL before making a request.** `preValidate` runs the same
   `assertProbeUrlAllowed` rule that `fetchProbe` runs internally. The comment is
   explicit that this is not a second line of defence against a bug: it exists so
   the *reason* for a rejection can be reported and the target's schedule advanced
   without paying for a request that is going to be refused. The URL is validated
   here rather than only at write time because configuration can be edited and a
   check that runs only on the write path can be bypassed by a write path someone
   adds later.
2. **Skip a refused target without probing it.** A refused URL is not an outage:
   the service behind it may be perfectly healthy, and feeding the rejection into
   the state machine would open a public incident caused by a configuration typo.
   The target is skipped — nothing is written to `probe_result`, no counter moves,
   no impact opens — and its cursor is pushed forward by one `interval_seconds` so
   it is not retried in a tight loop. The rejection is logged with its reason. The
   component consequently loses coverage and derives as `unknown`, which is the
   honest answer because the system genuinely cannot measure it.
3. **Fetch.** `fetchProbe` never throws; a probe that cannot be made is a failed
   probe, which is information the state machine needs rather than an exception
   that aborts a cron run.
4. **Apply the observation.** `applyProbeObservation` is called with a `resultId`
   generated once by the scheduler. That id is the idempotency key for the whole
   transition, so it is generated once per attempt and reused across retries;
   regenerating it inside the retry loop would turn a committed-but-unacknowledged
   write into a second counted observation. The scheduler generates one id per
   target per tick and passes the same generator through for the transition's
   internal id needs.
5. **Account for the outcome.** An `applied` outcome adds the page to the affected
   set and, when it actually opened or closed an impact, to the transitioned set;
   `replay`, `stale` and `unconfigured` are counted and logged; an `anomaly` is
   pushed onto the report as a bug to be surfaced. A target with no `probe_state`
   row is still probed — refusing to probe it would hide the provisioning problem
   rather than report it — and its cursor is not advanced.

The scheduler separates observations from impact transitions. Every applied
observation refreshes the page's live summary evidence, including continued
success without a transition. It does not write KV every minute per target.
Historical recomputation runs on its own 300-second cadence; fallback KV
checkpoints are due every 600 seconds and admitted by a shared budget.

## The four timestamps and the nominal detection lag

A probe samples. With `failure_threshold = 3` and a 60-second interval, the impact
is confirmed on the third failure, but the outage began on the first. Four
quantities are therefore stored separately; the transition internals are in
[state-machine.md](state-machine.md).

| Quantity | Where | Meaning |
| --- | --- | --- |
| `first_failed_at` | `probe_state` | First observation of the current failure run. |
| `first_recovery_at` | `probe_state` | First observation of the current success run. |
| `detected_at` | `probe_transition` | The observation that met the failure threshold. |
| `resolved_at` | `probe_transition` | The observation that met the recovery threshold. |

The impact interval uses the first pair, not the second: `impact.start_at =
first_failed_at`, `impact.end_at = first_recovery_at`, `impact.estimated = 1`.
Confirmation times stay on `probe_transition` so the fault interval remains a clean
estimate and the detection delay remains separately measurable.

The **nominal detection lag** is `(failure_threshold − 1) × interval_seconds`. With
the defaults (`failure_threshold = 3`, `interval_seconds = 60`) that is 120 seconds.
The **total confirmation delay** is larger and is not bounded from inside the
Worker: it is the nominal lag, plus the time from the true fault start to the first
observation of it (up to one interval), plus cron scheduling jitter. The cron
trigger is `* * * * *` — once a minute — and when the runtime actually invokes the
handler relative to the wall-clock minute is not something this code controls, so
the third term is real and unbounded. The arithmetic is stated here; the measured
figure is not, and is not claimed.

## Capacity boundaries

The per-run cap is `MAX_ENABLED_TARGETS = 20`, and it is hard-coded. The
`MAX_TARGETS_PER_RUN` environment variable can *lower* the effective limit but
cannot raise it above 20: `maxTargetsPerRun` clamps the parsed value to
`MAX_ENABLED_TARGETS`, and a missing or non-positive value falls back to 20. This
matches the plan's v1 capacity boundary and the `wrangler.jsonc` default of `"20"`.

The cap is a workload boundary, not proof that twenty targets fit the free tier.
Measure complete scheduler D1 queries, rows read/written, CPU, subrequests, cache
misses and checkpoint attempts under healthy and failing workloads. Fewer KV
writes do not by themselves validate provider allowances or production capacity.

The other v1 boundaries are enforced structurally in the schema
(`apps/api/migrations/0002_m1_model.sql`), so they cannot be exceeded by
configuration at all:

| Boundary | Where | Value |
| --- | --- | --- |
| Minimum interval | `probe_target.interval_seconds` CHECK | `>= 60` |
| Timeout | `probe_target.timeout_ms` CHECK | `BETWEEN 1000 AND 30000` |
| Thresholds | `failure_threshold`, `recovery_threshold` CHECK | `BETWEEN 1 AND 10` |
| Method | `probe_target.method` CHECK | `GET` or `HEAD` only |
| One enabled target per component | `idx_probe_target_enabled_component` | partial unique index |

The minimum interval exists because the scheduler runs once a minute; a target
configured faster than the cron can execute would be a promise the system cannot
keep. The timeout range keeps a probe from outliving the cron interval. The
one-enabled-target-per-component index exists because no multi-target aggregation
rule is defined yet, and forbidding the case is more honest than inventing one.

## The URL guard

A prober is a server-side request forgery primitive by construction: it fetches a
URL a human configured. `apps/api/src/lib/ssrf.ts` reduces that to a *bounded* risk
and nothing more. The checks are depth; the wall is that v1 probe targets are
configured by an operator behind `INTERNAL_KEY`, not by untrusted parties.

`assertProbeUrlAllowed` refuses, in order:

| Check | Refused | Reason code |
| --- | --- | --- |
| Parseable absolute URL | relative or unparseable input | `invalid_url` |
| Scheme | anything other than `http:` and `https:` (for example `ftp:`, `file:`, `gopher:`, `ws:`) | `scheme` |
| Embedded credentials | any `user:pass@` or bare `user@` userinfo | `credentials` |
| Hostname suffix | `localhost`, `.localhost`, `.local`, `.internal`, `.home.arpa`, `.invalid`, `.test`, `.example`, after lowercasing and stripping one trailing dot | `blocked_host` |
| Address literal | any address in a blocked range (below) | `blocked_address` |
| Port | any port outside the allowed set, which defaults to `[80, 443]` | `port` |

An explicitly allowed host, supplied through `allowedHosts` and matched exactly
after lowercasing, bypasses the suffix and address checks *for that host only*; it
does not widen the checks for any other host.

The blocked IPv4 ranges are `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT),
`127.0.0.0/8` (loopback), `169.254.0.0/16` (link-local, which includes the cloud
metadata service), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`,
`192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`,
`203.0.113.0/24`, `224.0.0.0/4` (multicast) and `240.0.0.0/4` (reserved). The IPv4
parser is deliberately strict — exactly one to three digits per octet with no
leading zeros — because the WHATWG URL parser has already normalised decimal,
octal, hex and integer forms such as `0177.0.0.1` and `2130706433` into dotted-quad
before this code sees them, and re-implementing a loose grammar would reintroduce
the ambiguity that normalisation removed.

IPv6 literals are expanded and classified: the unspecified address `::`, loopback
`::1`, `fc00::/7` unique-local, `fe80::/10` link-local, `ff00::/8` multicast,
`2001:db8::/32` documentation, and `64:ff9b::/96` NAT64 are all refused. IPv4-mapped
(`::ffff:a.b.c.d`) and IPv4-compatible forms are unwrapped and re-run through the
IPv4 rules, so an IPv6 spelling of a private address cannot slip past. A zone index
such as `fe80::1%eth0` is dropped before classification.

### Redirects, body size and timeouts

`fetchProbe` sends the request with `redirect: "manual"`, so a 3xx is returned to
the caller rather than followed. A permitted host must not be able to bounce the
request to somewhere the checks never saw, and re-validating every hop would also
work but refusing outright leaves no hop unvalidated. A 3xx is recorded as a probe
*failure*, as is a status code other than the configured `expected_status`. A
transport error is likewise a failure, never a thrown exception.

The response body is read and discarded, capped at `MAX_BODY_BYTES = 65536` bytes;
once the cap is reached the reader is cancelled rather than drained. The verdict
comes from the status code, so a server that streams without end must not be able
to hold the run open. Each request carries `AbortSignal.timeout(timeoutMs)` with the
target's configured timeout, and a fixed `user-agent` and `accept` header.

### The limitation, stated plainly

**Hostname-string validation cannot stop DNS rebinding.** A hostname that resolves
to a public address when the guard runs can resolve to `127.0.0.1` a moment later
when `fetch` resolves it, and it would pass every check in this file. Closing that
would require resolving the name in the guard and pinning the connection to the
validated address, which the Workers `fetch` API does not expose. The only defence
that removes the class of attack is not accepting URLs from untrusted parties, and
that is what v1 does. **Opening probe targets to third parties would require a
dedicated egress design — a resolver-and-pin step, or an egress proxy — before it
could be safe.** The guard is depth, not the wall, and this is written down rather
than implied by a passing test suite.

## Authenticated probes are not supported in v1

`probe_target.auth_ref` is a reference into a secret store and never a credential;
no credential value is ever stored in the table. The column exists so the schema
does not have to change when authenticated probes arrive, but v1 probes are
unauthenticated and the column is unused. There is no code path that reads it, and
the request headers are fixed.

## Retention of raw results

`probe_result` is append-only and grows with every observation. It is retained for
`RETENTION_DAYS = 30`; the daily retention pass folds them into `daily_uptime` and deletes expired results. The order —
**roll up, then delete** — is the whole point of `apps/api/src/lib/retention.ts`.
The boundary day, `now - 30 days`, is rolled up for every component first; the
delete of everything older is gated on that rollup having succeeded. If any
component's rollup fails, the delete is skipped entirely and the summary carries a
`skippedDeletionReason`, so the raw evidence survives to be retried next run. A
growing table is recoverable; a deleted observation behind a day that has no
`daily_uptime` row is not, because that day would report `unknown` forever and look
unmeasured rather than deleted.

The rollup function is injectable (`RetentionOptions.computeDay`) specifically so
the gate can be tested: there is no way to make the real rollup fail from a test
without breaking the database underneath it, and a safety property with no test is
one that gets removed the first time it is inconvenient. Production always takes
the default.

## The cron entry point

`apps/api/src/index.ts` runs one scheduled pass per cron tick. Every step is
isolated in its own try/catch, so a failure in one is logged and the rest still run.
The order is by dependency:

The independent cadences are:

1. Run due probes on each minute tick; preserve the configured intervals and
   120-second default freshness budget.
2. Refresh the D1 materialized summary for applied observations, not just impact
   transitions. A 30-second hot cache limits read work without extending probe
   freshness.
3. Recompute recent daily history every 300 seconds and record its own epoch-second
   computation time. This is not a recompute of all historical days.
4. Admit due two-key KV checkpoints every 600 seconds, within the shared budget.
5. Run retention daily, rolling up the boundary before deleting raw observations;
   keep raw evidence if the rollup fails. Prune other operational state separately.

No cadence is an observed production latency bound. Scheduling jitter, failures,
cache placement and checkpoint admission can delay visibility.

## What this does not claim

* **No measured production detection latency.** The nominal figure is arithmetic
  (`(failure_threshold − 1) × interval_seconds`); the real figure depends on cron
  behaviour on a real deployment and has not been measured here.
* **No multi-target aggregation rule.** At most one enabled target per component is
  permitted by a partial unique index, precisely because no aggregation rule exists.
* **No fairness guarantee beyond the hard cap.** Ordering by `next_check_at` favours
  the longest-waiting targets, but when more than twenty targets are due the
  remainder simply wait for the next tick, and no bound on that wait is claimed.
* **No authenticated probes.** `auth_ref` is unused; all probes are unauthenticated.
* **The DNS-rebinding limitation is real.** See above; hostname validation is not a
  solution, and third-party targets would need a dedicated egress design.
* **Free-tier capacity is unvalidated.** A twenty-target application cap is not
  evidence of provider quota compliance; validate complete scheduled workloads.
* **The guard is not claimed to be a complete blocklist.** A blocklist is never
  complete; the tests assert the *shape* of the rule, not the completeness of the
  ranges.
* **Probing is limited to one scheduler.** The design assumes each target is polled
  once per interval by one scheduler; overlapping cron runs are handled by the
  transition's compare-and-swap, but every sample of a synthetic N-way race is not
  guaranteed to be counted.

## Running

```bash
cd apps/api
npm test          # vitest run — scheduler, SSRF, transition, retention
npm run typecheck
```

The tests need no network and no credentials: `@cloudflare/vitest-plugin` starts
`workerd` locally, and the prober's `fetch` is injected with a stand-in so the
number of requests made can be asserted alongside what was recorded.
