# Data model (M1)

**Status: schema landed, applied to local D1 only.** Migration
`apps/api/migrations/0002_m1_model.sql` has been applied and inspected against a
local database. It has **not** been applied to production — see
[Deployment](#deployment).

This document explains what the schema is for and which parts of it are
load-bearing. It is not a column-by-column reference; the migration is commented
and is the reference. What is here is the reasoning that would otherwise have to
be reverse-engineered from `ALTER TABLE` statements.

## Two conventions

### ID roles

Every entity reachable through the API carries two identifiers:

| Column | Type | Role |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Foreign keys, indexes, joins. Never leaves the database. |
| `public_id` | `TEXT NOT NULL UNIQUE` (ULID) | The only identifier that appears in a URL or a response body. |

Pure join tables (`change_component`, `change_update_component`,
`subscriber_component`) have integer keys only — they are not addressable.

The split exists so that the public identifier is not an enumeration of the
business. Sequential integers in URLs leak how many components exist and invite
probing; ULIDs are sortable by creation time without being guessable.

`probe_result.public_id` is a special case worth noting: it is not just an
external name, it is **the idempotency key for the whole state transition**. The
prober generates it once and reuses it across retries, which is what makes a
replayed observation a no-op. See [state-machine.md](state-machine.md).

### `impact` is the single source of truth for downtime

Probe-driven outages and hand-entered ones both produce `impact` rows. Nothing
else in the schema stores a duration to be summed. Uptime is therefore always
*computed from recorded intervals* rather than asserted, and a component cannot
report 100% while an incident is open.

This is why `component.status` from migration 0001 is **dropped rather than
deprecated**. A stored per-component status cannot express the property the
system needs — resolving incident A must not clear a component that incident B is
still affecting — so the status is derived at read time from the set of currently
active impacts (`packages/shared/src/status.ts`). Leaving the column in place
would invite a future reader to trust it, which is worse than its absence.

## Table groups

### Identity

`admin_user` — accounts for the management UI. `password_hash` only ever holds a
hash, and **no credential is seeded by any migration**; the first admin is
provisioned out of band.

### Page structure

`section` → `component`. A component sits either inside a section
(`section_id` set) or directly under the page (`section_id IS NULL`). The section
level is optional in the schema rather than required, because a flat page is a
legitimate status page and forcing a synthetic section on one would be noise.

### Changes: incidents and maintenance windows

`change` is one row per incident or maintenance window; `kind` selects which
lifecycle applies. Incidents move `in_progress → verifying → resolved`;
maintenance moves `scheduled → in_progress → completed`. Both share one `status`
column and therefore one `CHECK` list, so a single column stays queryable across
both kinds.

`change_update` is the timeline. `change_update_component` holds per-component
status overrides attached to a single timeline entry, for incidents that hit some
components harder than others.

Two severities exist and they are not duplicates:

* `change.severity` describes the change as a whole, for the timeline.
* `impact.severity` is the authoritative per-component severity, and is what the
  uptime maths weights.

A change announced as a `full_outage` may in practice impact three components at
`degraded_performance`; the timeline should say the former and uptime must use
the latter.

**`scheduled` maintenance contributes nothing to derived status.** Announcing a
window for next week must not paint the component as under maintenance today.
Only `in_progress` inside its own window counts. This is a schema-level
consequence of `change.starts_at` plus the derivation rule, not a stored flag.

### Probes

`probe_target` (configuration) → `probe_state` (mutable scheduler state, one row
per target) → `probe_result` (append-only observations) → `probe_transition`
(append-only state changes).

The split between configuration and state is deliberate: `probe_target` is
admin-edited and rarely written, `probe_state` is written on every observation.
Keeping them apart means an admin edit cannot race a probe's counter update.

`probe_state` holds the counters, `transition_seq`, the denormalised
`open_impact_id`, the last processed observation, and `last_batch_nonce`. Each of
those is explained in [state-machine.md](state-machine.md) — none is derivable
cheaply, which is why they are persisted rather than recomputed.

### Rollups

`daily_uptime` is keyed `(component_id, day)`. `uptime` is **nullable**, and NULL
means "no covered time in this window". It is deliberately not 100: a day with no
measurement is not a perfect day, and defaulting to 1.0 here would quietly
manufacture uptime. `downtime_weighted` is a sum over segments of
`seconds × most severe active weight`, not a union of per-severity totals — the
difference matters when faults of different severities overlap. The algorithm
itself is M3 and will be written up in `docs/spec/uptime-math.md`.

### Subscriptions

`subscriber` requires `confirmed_at` before anything is sent (double opt-in), and
carries `version` so that incrementing it revokes every outstanding unsubscribe
link for that subscriber at once. `confirm_token` is indexed because the confirm
endpoint looks up by token alone.

`email_quota` is a global daily send counter, checked before sending and
incremented after, so a runaway notification loop hits a wall instead of a bill.

### Operations

`audit_log` records admin actions. `public_id` is present because audit entries
are referenced from the UI.

## Constraints that are load-bearing

Most constraints are ordinary hygiene. These four are not — removing them would
silently break a correctness property, so they are listed together.

| Constraint | What breaks without it |
| --- | --- |
| `idx_impact_open_per_target`: `UNIQUE (probe_target_id) WHERE end_at IS NULL` | A lost race could leave two open impacts for one target, so recovery would close only one and the component would stay down forever. |
| `probe_transition` `UNIQUE (probe_target_id, transition_seq)` | A replayed transition would be logged twice, double-counting a state change in the timeline. |
| `probe_transition` `UNIQUE (probe_result_id)` | The same observation could produce two transitions. |
| `idx_probe_target_enabled_component`: `UNIQUE (component_id) WHERE enabled = 1` | Two enabled targets on one component would require an aggregation rule that does not exist yet. |

The first three are **backstops, not the primary guard**: the transition batch is
expected to be correct on its own. Their job is to convert a bug in that logic
into a loud rollback instead of quiet corruption.

## Capacity boundaries, enforced in the schema

These encode what the system can actually do, rather than what would be
convenient to allow.

* `interval_seconds >= 60`. The scheduler runs once a minute. A target configured
  faster than the cron can execute would be a promise the system cannot keep.
* At most one *enabled* target per component (above).
* `timeout_ms BETWEEN 1000 AND 30000` — a probe that outlives the cron interval
  cannot be scheduled sanely.
* `failure_threshold` and `recovery_threshold` between 1 and 10.

The plan's v1 limit of 20 enabled targets is **not** a schema constraint, because
it is a scheduling decision (`max_targets_per_run`) rather than a structural one.
It is not implemented yet; it belongs to M3's prober.

`probe_target.auth_ref` is a reference into a secret store, never a credential.
v1 probes are unauthenticated and the column is unused.

## What this migration does not do

Stated plainly, because a complete-looking schema is easy to over-read.

* **No retention job.** `probe_result` is documented as retained for 30 days and
  then folded into `daily_uptime` and deleted. Nothing deletes it yet.
* **`daily_uptime` is never written.** The table exists; the computation is M3.
* **No subscription flow.** The tables exist; confirmation, unsubscribe and
  sending are M5.
* **No admin, no API, no UI.** Nothing reads or writes these tables outside the
  test suite.
* **`change` and `impact` are not yet linked to `probe_transition`** in any code
  path — the link columns exist, the code is M2.
* **No measurement of D1 read-subrequest limits.** The Free-tier ceiling (50 read
  subrequests per invocation) constrains how many targets one cron tick can
  process, and it is still an estimate. M3 must measure it.

## Deployment

```bash
# local
cd apps/api && npm run db:migrate:local

# production — deliberate and manual, never part of a push
cd apps/api && npm run db:migrate:remote
```

`0001_init.sql` is written with `IF NOT EXISTS` / `INSERT OR IGNORE` guards so
the first tracked run may safely re-apply it.

`0002_m1_model.sql` is **not** idempotent in the same way: it uses
`ALTER TABLE ... ADD COLUMN` and `ALTER TABLE component DROP COLUMN status`.
Those statements have no `IF NOT EXISTS` form in SQLite, and `d1_migrations`
records each file as applied, so a given database applies it once. Amending the
file after it has been applied locally therefore requires deleting the local
state directory (`apps/api/.wrangler/state`) rather than re-running the
migration — a plain re-apply silently skips it. This bit once while adding
`probe_state.last_batch_nonce`.
