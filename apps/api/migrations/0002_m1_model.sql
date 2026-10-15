-- allclear — M1 full data model.
--
-- 0001 was deliberately the smallest schema that let M0 prove its deployment
-- claims. This migration lands the real model: sections, changes and their
-- timeline, per-component impact intervals, the probe scheduler's tables, and
-- the subscription tables.
--
-- Two conventions run through the whole file:
--
--   * ID roles. Entities exposed through the API carry both an internal
--     `id INTEGER PRIMARY KEY` (foreign keys, indexes, cheap joins) and a
--     `public_id` ULID which is the only identifier that ever appears in a URL
--     or a response body. Pure join tables have integer keys only.
--
--   * `impact` is the single source of truth for downtime. Probe-driven and
--     hand-entered outages both produce rows there, so uptime is always
--     computed from recorded intervals rather than asserted. Nothing else in
--     the schema stores a duration to be summed.
--
-- Applied with `wrangler d1 migrations apply`, which records each file in
-- `d1_migrations`. 0001 is written with IF NOT EXISTS / INSERT OR IGNORE guards,
-- so the first tracked run may safely re-apply it.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Admin accounts. `password_hash` only ever holds a hash; no credential is
-- stored, and none is seeded here — the first admin is provisioned out of band.
CREATE TABLE IF NOT EXISTS admin_user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'owner')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Page structure
-- ---------------------------------------------------------------------------

-- Optional grouping level. A component may sit directly under a page
-- (`component.section_id IS NULL`) or inside a section.
CREATE TABLE IF NOT EXISTS section (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT    NOT NULL UNIQUE,
  page_id     INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT,
  order_id    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_section_page ON section(page_id, order_id);

-- `component.status` from 0001 is dropped, not deprecated.
--
-- A stored per-component status cannot express the property this system needs:
-- resolving incident A must not clear a component that incident B is still
-- affecting. The status is derived at read time from the set of currently
-- active `impact` rows (see packages/shared/src/status.ts), so there is nothing
-- to store. Leaving the column in place would invite a future reader to trust
-- it, which is worse than its absence.
ALTER TABLE component ADD COLUMN section_id INTEGER REFERENCES section(id) ON DELETE SET NULL;
ALTER TABLE component ADD COLUMN description TEXT;
ALTER TABLE component DROP COLUMN status;

CREATE INDEX IF NOT EXISTS idx_component_section ON component(section_id, order_id);

-- ---------------------------------------------------------------------------
-- Changes: incidents and maintenance windows
-- ---------------------------------------------------------------------------

-- One row per incident or maintenance window. `kind` selects which status
-- lifecycle applies: incidents move in_progress -> verifying -> resolved, while
-- maintenance moves scheduled -> in_progress -> completed. Both lifecycles share
-- one CHECK list so that a single status column stays queryable.
--
-- `scheduled` maintenance contributes nothing to a component's derived status:
-- announcing a window for next week must not paint the component as under
-- maintenance today. Only `in_progress` inside its own window counts.
CREATE TABLE IF NOT EXISTS change (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT    NOT NULL UNIQUE,
  page_id            INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  kind               TEXT    NOT NULL CHECK (kind IN ('incident', 'maintenance')),
  status             TEXT    NOT NULL CHECK (status IN (
                       'scheduled', 'in_progress', 'verifying', 'resolved', 'completed'
                     )),
  title              TEXT    NOT NULL,
  body               TEXT,
  -- Severity of the change as a whole, for the timeline. The authoritative
  -- per-component severity lives on `impact.severity`.
  severity           TEXT    NOT NULL DEFAULT 'none' CHECK (severity IN (
                       'none', 'degraded_performance', 'partial_outage', 'full_outage'
                     )),
  -- Effective start. For maintenance this is when the window opens.
  starts_at          INTEGER NOT NULL,
  -- NULL while the change is still open.
  ends_at            INTEGER,
  -- What was announced, which may differ from what happened. Kept separate so
  -- that "the window ran long" is visible instead of silently overwritten.
  scheduled_start_at INTEGER,
  scheduled_end_at   INTEGER,
  created_by         INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_page_time ON change(page_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_open ON change(page_id, kind, status);

CREATE TABLE IF NOT EXISTS change_component (
  change_id    INTEGER NOT NULL REFERENCES change(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  PRIMARY KEY (change_id, component_id)
);

CREATE TABLE IF NOT EXISTS change_update (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id  TEXT    NOT NULL UNIQUE,
  change_id  INTEGER NOT NULL REFERENCES change(id) ON DELETE CASCADE,
  status     TEXT    NOT NULL CHECK (status IN (
               'scheduled', 'in_progress', 'verifying', 'resolved', 'completed'
             )),
  body       TEXT    NOT NULL,
  created_by INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_update_change ON change_update(change_id, created_at);

-- Per-component status overrides attached to a single timeline entry, for
-- incidents that hit some components harder than others.
CREATE TABLE IF NOT EXISTS change_update_component (
  change_update_id INTEGER NOT NULL REFERENCES change_update(id) ON DELETE CASCADE,
  component_id     INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  status           TEXT    NOT NULL CHECK (status IN (
                     'operational', 'degraded_performance', 'partial_outage',
                     'full_outage', 'maintenance'
                   )),
  PRIMARY KEY (change_update_id, component_id)
);

-- ---------------------------------------------------------------------------
-- Probes
-- ---------------------------------------------------------------------------

-- v1 capacity boundaries are enforced by the schema, not only by the API:
--
--   * `interval_seconds >= 60`, because the scheduler runs once a minute. A
--     target configured faster than the cron can execute would be a promise the
--     system cannot keep.
--   * at most one *enabled* target per component (partial unique index below),
--     because no multi-target aggregation rule is defined yet. Forbidding the
--     case is honest; inventing an aggregation would not be.
--
-- `auth_ref` is a reference into a secret store, never a credential. v1 probes
-- are unauthenticated and this column is unused.
CREATE TABLE IF NOT EXISTS probe_target (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT    NOT NULL UNIQUE,
  component_id       INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  url                TEXT    NOT NULL,
  method             TEXT    NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'HEAD')),
  -- Severity to record when this target fails. A probe can tell you *that* a
  -- URL is failing, not how bad it is for users, so an operator states it here.
  severity           TEXT    NOT NULL DEFAULT 'partial_outage' CHECK (severity IN (
                       'degraded_performance', 'partial_outage', 'full_outage'
                     )),
  expected_status    INTEGER NOT NULL DEFAULT 200,
  timeout_ms         INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  interval_seconds   INTEGER NOT NULL DEFAULT 60 CHECK (interval_seconds >= 60),
  failure_threshold  INTEGER NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 10),
  recovery_threshold INTEGER NOT NULL DEFAULT 2 CHECK (recovery_threshold BETWEEN 1 AND 10),
  auth_ref           TEXT,
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- The scheduler's cursor, and the only one. The due query reads this column,
  -- which is what `idx_probe_target_due` below indexes, and both the transition
  -- batch and the configuration-rejection path advance it. It lives on the
  -- target rather than on `probe_state` because the index that makes the due
  -- query cheap has to sit alongside `enabled`.
  --
  -- An earlier revision also carried a `probe_state.next_check_at` that the
  -- state machine advanced while the due query read this one. The two never
  -- disagreed visibly, because the column the scheduler reads was simply never
  -- updated — so every enabled target was probed on every cron tick and
  -- `interval_seconds` was decorative. One column, one writer per path.
  next_check_at      INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_probe_target_enabled_component
  ON probe_target(component_id) WHERE enabled = 1;

CREATE INDEX IF NOT EXISTS idx_probe_target_due ON probe_target(enabled, next_check_at);

-- Every recorded observation. Retained for 30 days, then folded into
-- `daily_uptime` and deleted (retention job lands in M3).
CREATE TABLE IF NOT EXISTS probe_result (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The idempotency key for the whole transition. The caller generates this
  -- ULID once and reuses it across retries, so replaying a result is a no-op
  -- rather than a second transition.
  public_id       TEXT    NOT NULL UNIQUE,
  probe_target_id INTEGER NOT NULL REFERENCES probe_target(id) ON DELETE CASCADE,
  observed_at     INTEGER NOT NULL,
  ok              INTEGER NOT NULL CHECK (ok IN (0, 1)),
  status_code     INTEGER,
  latency_ms      INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_probe_result_target_time
  ON probe_result(probe_target_id, observed_at);

-- Mutable per-target scheduler state. One row per target, created alongside it.
CREATE TABLE IF NOT EXISTS probe_state (
  probe_target_id       INTEGER PRIMARY KEY REFERENCES probe_target(id) ON DELETE CASCADE,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  -- Monotonic per-target counter, incremented by every applied observation.
  -- Mirrored into `probe_transition` so a replay collides on a unique key
  -- instead of double-applying.
  transition_seq        INTEGER NOT NULL DEFAULT 0,
  -- The impact this target currently has open, if any. Denormalised from
  -- `impact` for cheap guarded reads inside the transition batch.
  open_impact_id        INTEGER REFERENCES impact(id) ON DELETE SET NULL,
  -- Last *processed* observation. `last_result_id` is what makes the counter
  -- update idempotent under retry; `last_probe_at` also rejects out-of-order
  -- deliveries, so a stale result cannot rewind the counters.
  last_probe_at         INTEGER,
  last_result_id        TEXT,
  -- Per-attempt token, written by the compare-and-swap and tested by every
  -- statement that depends on it having applied.
  --
  -- This is not redundant with `transition_seq`. A guard of the form
  -- "transition_seq = <seq I read> + 1" is satisfied both by *this* batch's
  -- write and by a concurrent batch that started from the same sequence, so it
  -- cannot tell "I won" from "someone else won". The nonce can: only the batch
  -- whose CAS committed finds its own token in the row.
  last_batch_nonce      TEXT,
  -- Start of the current failure run and of the current success run.
  --
  -- These exist because a probe *samples*: with failure_threshold = 3 and a
  -- 60 s interval, the impact is confirmed on the third failure but the outage
  -- began on the first, so `impact.start_at` is taken from here rather than
  -- from the confirming observation. Conflating the two would under-report
  -- every outage by (failure_threshold - 1) x interval. The confirming times
  -- are recorded separately on `probe_transition`.
  first_failed_at       INTEGER,
  first_recovery_at     INTEGER,
  updated_at            INTEGER NOT NULL
);

-- The downtime intervals everything else is computed from.
--
-- `estimated` marks boundaries that came from probe sampling rather than from a
-- human. For automated impacts `start_at` is the probe's `first_failed_at` and
-- `end_at` its `first_recovery_success_at`; both are samples at the probe
-- interval, so they bound the fault rather than pinpoint it. Uptime maths
-- intersects these with valid coverage so that an unmonitored stretch is
-- reported as `unknown_duration` instead of being counted as downtime.
CREATE TABLE IF NOT EXISTS impact (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT    NOT NULL UNIQUE,
  component_id       INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  -- NULL for hand-entered impacts.
  probe_target_id    INTEGER REFERENCES probe_target(id) ON DELETE SET NULL,
  change_id          INTEGER REFERENCES change(id) ON DELETE SET NULL,
  severity           TEXT    NOT NULL CHECK (severity IN (
                       'degraded_performance', 'partial_outage', 'full_outage', 'maintenance'
                     )),
  start_at           INTEGER NOT NULL,
  end_at             INTEGER,
  estimated          INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  -- The observation that opened this impact. Together with the partial unique
  -- index below, this is what turns a lost race into a rollback rather than a
  -- second open incident for the same target.
  opened_by_result_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_impact_component ON impact(component_id, start_at);
CREATE INDEX IF NOT EXISTS idx_impact_open ON impact(component_id) WHERE end_at IS NULL;

-- At most one open impact per probe target. This is a backstop, not the primary
-- guard: the transition batch's guarded insert is expected to be correct on its
-- own. If a race ever slips past it, this index makes the second insert fail
-- and roll the whole batch back, which is the failure mode we want.
CREATE UNIQUE INDEX IF NOT EXISTS idx_impact_open_per_target
  ON impact(probe_target_id) WHERE end_at IS NULL AND probe_target_id IS NOT NULL;

-- Append-only log of state transitions. Written inside the same batch as the
-- `probe_state` update and the impact it produced, so the log cannot disagree
-- with the state it describes.
CREATE TABLE IF NOT EXISTS probe_transition (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT    NOT NULL UNIQUE,
  probe_target_id INTEGER NOT NULL REFERENCES probe_target(id) ON DELETE CASCADE,
  transition_seq  INTEGER NOT NULL,
  -- The observation that caused this transition.
  probe_result_id TEXT    NOT NULL,
  from_state      TEXT    NOT NULL,
  to_state        TEXT    NOT NULL,
  impact_id       INTEGER REFERENCES impact(id) ON DELETE SET NULL,
  -- When the transition was *confirmed*, which is not when the fault started or
  -- ended. With the default thresholds these lag the real event by
  -- (threshold - 1) x interval plus one scheduling jitter. Kept here rather
  -- than on `impact` so the fault interval stays a clean estimate and the
  -- detection delay stays separately measurable.
  detected_at     INTEGER,
  resolved_at     INTEGER,
  created_at      INTEGER NOT NULL,
  -- Replaying a transition collides here rather than applying twice.
  UNIQUE (probe_target_id, transition_seq),
  UNIQUE (probe_result_id)
);

-- ---------------------------------------------------------------------------
-- Rollups
-- ---------------------------------------------------------------------------

-- `uptime` is NULL when `covered_seconds = 0`, which is the "window entirely
-- excluded" case. It must not be 100: a day with no measurement is not a
-- perfect day, and defaulting to 1.0 here would quietly manufacture uptime.
CREATE TABLE IF NOT EXISTS daily_uptime (
  component_id     INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  day              TEXT    NOT NULL,
  covered_seconds  INTEGER NOT NULL,
  unknown_seconds  INTEGER NOT NULL,
  -- Sum over segments of (seconds x most severe active weight), not a union of
  -- per-severity totals. See docs/spec/uptime-math.md.
  downtime_weighted REAL   NOT NULL,
  uptime           REAL,
  worst_status     TEXT    NOT NULL,
  computed_at      INTEGER NOT NULL,
  PRIMARY KEY (component_id, day)
);

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------

-- `confirmed_at` NULL means the address was submitted but never verified, so it
-- receives nothing. Unsubscribe links carry `version`; incrementing it revokes
-- every outstanding link for that subscriber at once.
CREATE TABLE IF NOT EXISTS subscriber (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT    NOT NULL UNIQUE,
  page_id         INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  email           TEXT    NOT NULL,
  confirmed_at    INTEGER,
  confirm_token   TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  unsubscribed_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_page_email ON subscriber(page_id, email);
CREATE INDEX IF NOT EXISTS idx_subscriber_confirm_token ON subscriber(confirm_token);

CREATE TABLE IF NOT EXISTS subscriber_component (
  subscriber_id INTEGER NOT NULL REFERENCES subscriber(id) ON DELETE CASCADE,
  component_id  INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  PRIMARY KEY (subscriber_id, component_id)
);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id           TEXT    NOT NULL UNIQUE,
  actor_admin_user_id INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  action              TEXT    NOT NULL,
  entity_type         TEXT    NOT NULL,
  entity_id           TEXT,
  detail              TEXT,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

-- Global daily send counter. Incremented and checked in one atomic statement
-- (see `consumeEmailQuota`), so a runaway notification loop hits a wall instead
-- of a bill. The count is taken before the send, so a failed send still consumes
-- quota: the ceiling can be reached early, never exceeded.
CREATE TABLE IF NOT EXISTS email_quota (
  day        TEXT    PRIMARY KEY,
  sent       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
