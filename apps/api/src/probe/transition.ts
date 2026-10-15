/**
 * Probe state machine: turning an observation into an impact.
 *
 * The whole file exists to make one operation correct under concurrency and
 * retry: "this probe target just failed (or recovered) — record it, and open or
 * close an impact if the thresholds say so."
 *
 * ## Why one D1 batch
 *
 * Four things must agree afterwards: the recorded observation, the counters on
 * `probe_state`, the open `impact` row, and the `probe_transition` log entry. If
 * they can disagree, the system will eventually report an outage that never
 * closed, or miss one that did. `db.batch()` runs its statements in a single
 * transaction, so they commit together or not at all.
 *
 * ## Why a compare-and-swap, and why a nonce on top of it
 *
 * `batch()` being transactional does not make it serialisable against *another*
 * batch: two cron invocations can both read `transition_seq = 5` and both decide
 * to open an impact. The counter update is therefore a compare-and-swap on the
 * sequence that was read, so a writer that lost the race matches zero rows.
 *
 * **A zero-row UPDATE is not an error in SQL** — it does not abort the batch —
 * so each dependent statement needs its own guard. The obvious guard,
 * `transition_seq = <the sequence I read> + 1`, is wrong, and the tests caught
 * it: that condition is satisfied both by *this* batch's write and by a
 * concurrent batch that started from the same sequence, so it cannot tell
 * "I won" from "someone else won". Two simultaneous deliveries of the same
 * observation both satisfied it and both tried to log the transition, which
 * surfaced as a `UNIQUE` violation rather than a lost update — lucky, but not a
 * design.
 *
 * The guard is instead a per-attempt nonce: the CAS writes
 * `last_batch_nonce = <token>`, and every dependent statement tests
 * `last_batch_nonce = <the same token>`. Only the batch whose CAS committed
 * finds its own token, so the guards are exact rather than merely suggestive.
 *
 * ## Statement order is part of the design
 *
 * The CAS runs **first**, and the observation is recorded **after** it, guarded
 * by the nonce. This is not stylistic. With the insert first, a batch that lost
 * the CAS still committed its `probe_result` row (zero-row guards make the
 * *other* statements no-ops, they do not roll the batch back), so a losing
 * observation was silently recorded without being counted. Worse, the retry
 * then re-ran the insert, saw `INSERT OR IGNORE` change nothing, and reported
 * the observation as a *replay* — a lost failure reported as a duplicate. That
 * bug is why the order is what it is, and `test/transition.test.ts` covers both
 * halves of it.
 *
 * With the insert after the CAS, a losing batch writes nothing at all, and
 * `probe_result` holds exactly the samples that were accepted into the state
 * machine. That is also the set the coverage maths should see.
 *
 * ## Why the observation id is the idempotency key
 *
 * The dangerous retry is not "the batch failed" (that rolls back cleanly) but
 * "the batch committed and the caller did not find out". Replaying then sees
 * counters that already include the observation. Guarding on `transition_seq`
 * alone would not catch that, because the sequence has legitimately moved on.
 * `last_result_id` does: it records which observation was last applied, so
 * "already applied" is a fact that can be read rather than inferred.
 *
 * ## Measured runtime behaviour
 *
 * Two assumptions were checked against the runtime rather than assumed, because
 * the design rests on them. Both are asserted in `test/d1-semantics.test.ts`:
 *
 *   * Two concurrent batches that each compare-and-swap the same row: exactly
 *     one applies. The CAS is not decorative.
 *   * Two concurrent batches inserting the same unique key: one is rejected.
 *     A constraint violation is therefore a *reachable* outcome of a race, not
 *     a sign of a bug, and is handled as such below.
 *
 * ## The backstops
 *
 * Three schema constraints are load-bearing. They exist so that a bug in the
 * guards above becomes a loud rollback instead of quiet corruption, and the
 * caller translates their violations into a retry rather than an error:
 *
 *   * `UNIQUE (probe_target_id) WHERE end_at IS NULL` on `impact` — a target
 *     cannot have two open impacts.
 *   * `UNIQUE (probe_target_id, transition_seq)` and `UNIQUE (probe_result_id)`
 *     on `probe_transition` — a transition cannot be logged twice.
 *
 * ## What this deliberately does not promise
 *
 * Losing the CAS is not always recoverable by retrying. An observation older
 * than one already processed is *rejected* (`out_of_order`) rather than counted,
 * because accepting it would rewind the counters; and under heavy contention a
 * caller can exhaust its attempts and receive `contended`. Both mean a real
 * sample went uncounted, and both are reported to the caller rather than
 * swallowed. In normal operation each target is polled once per interval by one
 * scheduler, so contention is limited to overlapping cron runs; the burst tests
 * exist to show the state stays consistent, not to show that every sample of an
 * artificial N-way race is counted.
 *
 * See docs/spec/state-machine.md for the reasoning and the test matrix.
 */

import { ulid } from "../lib/ulid";

/** One probe execution's result, as observed by the prober. */
export interface ProbeObservation {
  /**
   * Identifies this observation. Generated once by the caller and reused
   * verbatim across retries — this is what makes replay a no-op, so it must not
   * be regenerated on retry.
   */
  resultId: string;
  targetId: number;
  /** Epoch seconds. */
  observedAt: number;
  ok: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  error?: string | null;
}

export interface TransitionOptions {
  /** Override the id generator. Tests use this to make ids deterministic. */
  newId?: () => string;
  /**
   * How many times to re-read and re-apply after losing the CAS.
   *
   * Five covers the realistic case — two overlapping cron runs — with margin.
   * It is a bound, not a guarantee: under N-way contention a caller can still
   * run out and be told `contended`, which is visible and retriable.
   */
  maxAttempts?: number;
}

export type TransitionKind = "none" | "opened" | "closed";

export type TransitionOutcome =
  /** The observation was processed. */
  | { kind: "applied"; transition: TransitionKind; impactPublicId: string | null }
  /** This exact observation had already been applied. Nothing was written. */
  | { kind: "replay" }
  /**
   * The observation was not applied. `out_of_order` means a newer observation
   * had already been processed; `contended` means the CAS kept losing.
   */
  | { kind: "stale"; reason: "out_of_order" | "contended" }
  /** The target or its scheduler row is missing — a provisioning problem. */
  | { kind: "unconfigured"; detail: string }
  /**
   * The guards and the intended transition disagreed, or a constraint kept
   * rejecting the write. The batch has rolled back, so no partial write
   * survives; this is a bug report, not a state.
   */
  | { kind: "anomaly"; detail: string };

interface StateRow {
  failure_threshold: number;
  recovery_threshold: number;
  interval_seconds: number;
  consecutive_failures: number;
  consecutive_successes: number;
  transition_seq: number;
  last_probe_at: number | null;
  last_result_id: string | null;
  first_failed_at: number | null;
  first_recovery_at: number | null;
  open_impact_public_id: string | null;
}

/**
 * Read the target's configuration and scheduler state in one round trip.
 *
 * The open-impact lookup is deliberately taken from `impact` itself rather than
 * from the denormalised `probe_state.open_impact_id`. The SQL guards below test
 * `NOT EXISTS (SELECT 1 FROM impact ...)`, so reading the same source keeps the
 * JavaScript decision and the SQL guard in agreement; reading the cached pointer
 * would let them drift and turn a recoverable situation into a hard failure.
 */
const READ_STATE_SQL = `
SELECT t.failure_threshold,
       t.recovery_threshold,
       t.interval_seconds,
       s.consecutive_failures,
       s.consecutive_successes,
       s.transition_seq,
       s.last_probe_at,
       s.last_result_id,
       s.first_failed_at,
       s.first_recovery_at,
       (SELECT i.public_id
          FROM impact i
         WHERE i.probe_target_id = t.id AND i.end_at IS NULL
         ORDER BY i.id DESC
         LIMIT 1) AS open_impact_public_id
  FROM probe_target t
  JOIN probe_state  s ON s.probe_target_id = t.id
 WHERE t.id = ?1
`;

/**
 * S1 — the compare-and-swap, which also stamps this attempt's nonce.
 *
 * Three guards, catching three different things:
 *   * `transition_seq = ?10` rejects a concurrent writer that got there first.
 *   * `last_result_id IS NOT ?6` rejects our own replay, which the sequence
 *     guard cannot see because the sequence legitimately advanced.
 *   * `last_probe_at <= ?5` rejects an observation older than one already
 *     processed, so a delayed delivery cannot rewind the counters.
 */
export const CAS_STATE_SQL = `
UPDATE probe_state
   SET consecutive_failures  = ?1,
       consecutive_successes = ?2,
       transition_seq        = transition_seq + 1,
       first_failed_at       = ?3,
       first_recovery_at     = ?4,
       last_probe_at         = ?5,
       last_result_id        = ?6,
       last_batch_nonce      = ?7,
       next_check_at         = ?8,
       updated_at            = ?5
 WHERE probe_target_id = ?9
   AND transition_seq = ?10
   AND last_result_id IS NOT ?6
   AND (last_probe_at IS NULL OR last_probe_at <= ?5)
`;

/**
 * S2 — record the observation, but only if this batch's CAS applied.
 *
 * Deliberately *after* the CAS and guarded by the nonce: see "Statement order
 * is part of the design" above. No `OR IGNORE` — a collision here would mean the
 * batch applied twice, which should abort the transaction loudly rather than be
 * silently dropped.
 */
export const INSERT_RESULT_SQL = `
INSERT INTO probe_result
  (public_id, probe_target_id, observed_at, ok, status_code, latency_ms, error, created_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?3
  FROM probe_state
 WHERE probe_target_id = ?2
   AND last_batch_nonce = ?8
`;

/**
 * S3 — open an impact, but only if this batch's CAS applied and the failure
 * threshold is met and nothing is open already.
 *
 * `start_at` is `first_failed_at`, not the confirming observation: the outage
 * began on the first failure of the run, and using the confirming time would
 * under-report every outage by (failure_threshold - 1) x interval.
 */
export const OPEN_IMPACT_SQL = `
INSERT INTO impact
  (public_id, component_id, probe_target_id, change_id, severity,
   start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
SELECT ?1, t.component_id, t.id, NULL, t.severity,
       ?2, NULL, 1, ?3, ?4, ?4
  FROM probe_target t
 WHERE t.id = ?5
   AND (SELECT last_batch_nonce FROM probe_state WHERE probe_target_id = ?5) = ?6
   AND (SELECT consecutive_failures FROM probe_state WHERE probe_target_id = ?5) >= t.failure_threshold
   AND NOT EXISTS (SELECT 1 FROM impact i WHERE i.probe_target_id = ?5 AND i.end_at IS NULL)
`;

/**
 * S4 — close the open impact once the recovery threshold is met.
 *
 * `end_at` is `first_recovery_at`, the first success of the recovery run, for
 * the same reason S3 uses the first failure: the probe samples, and the
 * confirming observation is later than the event.
 */
export const CLOSE_IMPACT_SQL = `
UPDATE impact
   SET end_at = ?1, updated_at = ?2
 WHERE probe_target_id = ?3
   AND end_at IS NULL
   AND (SELECT last_batch_nonce FROM probe_state WHERE probe_target_id = ?3) = ?4
   AND (SELECT consecutive_successes FROM probe_state WHERE probe_target_id = ?3) >= ?5
`;

/**
 * S5 — re-derive the cached pointer from the truth.
 *
 * Runs after the open and close statements, so it cannot be folded into the CAS
 * update (which runs before them). Recomputing rather than incrementing means it
 * also repairs any drift that accumulated earlier.
 */
export const MIRROR_OPEN_IMPACT_SQL = `
UPDATE probe_state
   SET open_impact_id = (SELECT i.id
                           FROM impact i
                          WHERE i.probe_target_id = ?1 AND i.end_at IS NULL
                          ORDER BY i.id DESC
                          LIMIT 1)
 WHERE probe_target_id = ?1
   AND last_batch_nonce = ?2
`;

/**
 * S6 — log the transition, only when one actually happened.
 *
 * `?4 <> ?3` compares the target states; when they are equal (a counter change
 * with no state change) nothing is written. The `UNIQUE` constraints on
 * `probe_transition` are the backstop if this guard is ever wrong.
 */
export const LOG_TRANSITION_SQL = `
INSERT INTO probe_transition
  (public_id, probe_target_id, transition_seq, probe_result_id,
   from_state, to_state, impact_id, detected_at, resolved_at, created_at)
SELECT ?1, s.probe_target_id, s.transition_seq, ?2, ?3, ?4,
       (SELECT i.id FROM impact i WHERE i.public_id = ?5),
       ?6, ?7, ?8
  FROM probe_state s
 WHERE s.probe_target_id = ?9
   AND s.last_batch_nonce = ?10
   AND ?4 <> ?3
`;

/** Internal signals that never reach a caller directly. */
type Attempt =
  | TransitionOutcome
  /** Lost the CAS to a concurrent writer: re-read and try again. */
  | { kind: "retry" }
  /** A backstop constraint rejected the write: another attempt won the race. */
  | { kind: "constraint"; detail: string };

function changesOf(result: D1Result<unknown> | undefined): number {
  return result?.meta.changes ?? 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an error is one of the schema backstops firing.
 *
 * This is treated as "another attempt won" rather than as a failure because a
 * concurrent batch inserting the same unique key is a measured, expected
 * outcome of two crons touching one target — see `test/d1-semantics.test.ts`.
 */
function isConstraintViolation(error: unknown): boolean {
  return /SQLITE_CONSTRAINT|constraint failed/i.test(describe(error));
}

async function readState(db: D1Database, targetId: number): Promise<StateRow | null> {
  return db.prepare(READ_STATE_SQL).bind(targetId).first<StateRow>();
}

/**
 * Decide what an observation that was *not* applied means.
 *
 * Called before each attempt and again after a zero-row CAS. The three cases are
 * distinguishable from persisted state alone, which is the point: nothing here
 * relies on remembering what a previous attempt did, so a caller that lost the
 * race decides the same way the caller that won it would.
 */
function classifyUnapplied(state: StateRow, observation: ProbeObservation): Attempt {
  if (state.last_result_id === observation.resultId) return { kind: "replay" };
  if (state.last_probe_at !== null && state.last_probe_at > observation.observedAt) {
    return { kind: "stale", reason: "out_of_order" };
  }
  return { kind: "retry" };
}

async function attemptTransition(
  db: D1Database,
  observation: ProbeObservation,
  newId: () => string,
): Promise<Attempt> {
  const state = await readState(db, observation.targetId);

  if (!state) {
    return {
      kind: "unconfigured",
      detail: `no probe_target/probe_state for id ${observation.targetId}`,
    };
  }

  // Cheap answers for the two cases that need no write at all, so a redelivered
  // or stale observation costs one read instead of a batch.
  const early = classifyUnapplied(state, observation);
  if (early.kind === "replay" || early.kind === "stale") return early;

  const failing = !observation.ok;

  // Counters for the *current* run. Both reset when the outcome flips, which is
  // what makes `failure_threshold` count consecutive failures rather than total.
  const consecutiveFailures = failing ? state.consecutive_failures + 1 : 0;
  const consecutiveSuccesses = failing ? 0 : state.consecutive_successes + 1;

  // The start of each run, carried forward while the run continues.
  const firstFailedAt = failing
    ? state.consecutive_failures === 0
      ? observation.observedAt
      : state.first_failed_at
    : null;
  const firstRecoveryAt = failing
    ? null
    : state.consecutive_successes === 0
      ? observation.observedAt
      : state.first_recovery_at;

  const hasOpenImpact = state.open_impact_public_id !== null;

  const shouldOpen =
    failing && !hasOpenImpact && consecutiveFailures >= state.failure_threshold;
  const shouldClose =
    !failing && hasOpenImpact && consecutiveSuccesses >= state.recovery_threshold;

  const transition: TransitionKind = shouldOpen ? "opened" : shouldClose ? "closed" : "none";
  const fromState = hasOpenImpact ? "down" : "up";
  const toState = shouldOpen ? "down" : shouldClose ? "up" : fromState;

  // For an open this is the new impact's id; for a close it identifies the
  // impact being closed, so the transition log can point at the right row.
  const impactPublicId = shouldOpen
    ? newId()
    : shouldClose
      ? state.open_impact_public_id
      : null;

  const nonce = newId();
  const nextCheckAt = observation.observedAt + state.interval_seconds;
  const observedAt = observation.observedAt;
  const targetId = observation.targetId;
  const expectedSeq = state.transition_seq;
  const ok = observation.ok ? 1 : 0;

  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      // S1 — the CAS, which is also what decides whether S2..S6 apply at all.
      db
        .prepare(CAS_STATE_SQL)
        .bind(
          consecutiveFailures,
          consecutiveSuccesses,
          firstFailedAt,
          firstRecoveryAt,
          observedAt,
          observation.resultId,
          nonce,
          nextCheckAt,
          targetId,
          expectedSeq,
        ),

      db
        .prepare(INSERT_RESULT_SQL)
        .bind(
          observation.resultId,
          targetId,
          observedAt,
          ok,
          observation.statusCode ?? null,
          observation.latencyMs ?? null,
          observation.error ?? null,
          nonce,
        ),

      db
        .prepare(OPEN_IMPACT_SQL)
        .bind(impactPublicId, firstFailedAt, observation.resultId, observedAt, targetId, nonce),

      db
        .prepare(CLOSE_IMPACT_SQL)
        .bind(firstRecoveryAt, observedAt, targetId, nonce, state.recovery_threshold),

      db.prepare(MIRROR_OPEN_IMPACT_SQL).bind(targetId, nonce),

      db
        .prepare(LOG_TRANSITION_SQL)
        .bind(
          transition === "none" ? null : newId(),
          observation.resultId,
          fromState,
          toState,
          impactPublicId,
          transition === "opened" ? observedAt : null,
          transition === "closed" ? observedAt : null,
          observedAt,
          targetId,
          nonce,
        ),
    ]);
  } catch (error) {
    if (isConstraintViolation(error)) return { kind: "constraint", detail: describe(error) };
    throw error;
  }

  const [cas, inserted, opened, closed] = results;

  if (changesOf(cas) === 0) {
    // Nothing else in the batch applied either — every later statement is
    // nonce-guarded — so the state is exactly as it was read, and re-reading it
    // says whether to give up or try again.
    const after = await readState(db, targetId);
    if (!after) {
      return { kind: "unconfigured", detail: `probe_state vanished for id ${targetId}` };
    }
    return classifyUnapplied(after, observation);
  }

  // The CAS applied, so the counters are exactly what the guards below test. If
  // a statement that depends on those counters did something other than what
  // this same arithmetic predicted, the guards are wrong — surface it rather
  // than letting a half-correct state stand.
  if (changesOf(inserted) !== 1) {
    return {
      kind: "anomaly",
      detail: `CAS applied but the observation was not recorded (target ${targetId})`,
    };
  }

  const openedRows = changesOf(opened);
  const closedRows = changesOf(closed);

  if (transition === "opened" && openedRows !== 1) {
    return {
      kind: "anomaly",
      detail: `expected 1 impact opened, got ${openedRows} (target ${targetId})`,
    };
  }
  if (transition === "closed" && closedRows !== 1) {
    return {
      kind: "anomaly",
      detail: `expected 1 impact closed, got ${closedRows} (target ${targetId})`,
    };
  }
  if (transition === "none" && (openedRows !== 0 || closedRows !== 0)) {
    return {
      kind: "anomaly",
      detail: `expected no transition, got ${openedRows} opened / ${closedRows} closed (target ${targetId})`,
    };
  }

  return { kind: "applied", transition, impactPublicId };
}

/**
 * Apply one probe observation.
 *
 * Safe to call twice with the same `resultId`, and safe to call concurrently for
 * the same target. Losing the compare-and-swap is not a failure: the attempt is
 * re-read and re-applied, up to `maxAttempts` times.
 */
export async function applyProbeObservation(
  db: D1Database,
  observation: ProbeObservation,
  options: TransitionOptions = {},
): Promise<TransitionOutcome> {
  const maxAttempts = options.maxAttempts ?? 5;
  const newId = options.newId ?? (() => ulid());

  let lastConstraint: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const outcome = await attemptTransition(db, observation, newId);
    if (outcome.kind === "retry") continue;
    if (outcome.kind === "constraint") {
      lastConstraint = outcome.detail;
      continue;
    }
    return outcome;
  }

  // Exhausting the attempts after a constraint violation is different from
  // ordinary contention: it means a backstop kept rejecting this write, which
  // is worth surfacing rather than reporting as a busy target.
  return lastConstraint !== null
    ? { kind: "anomaly", detail: `constraint rejected the write on every attempt: ${lastConstraint}` }
    : { kind: "stale", reason: "contended" };
}
