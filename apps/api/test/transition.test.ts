import { describe, expect, it } from "vitest";

import {
  applyProbeObservation,
  CAS_STATE_SQL,
  type ProbeObservation,
} from "../src/probe/transition";
import { testEnv as env } from "./env";

/**
 * These are the M1 gate. The plan requires the state machine to be proven
 * against a database — including concurrency, duplicate confirmation, a failure
 * after the counter was updated, and retry — before any API or UI work starts.
 *
 * Everything below runs on a real `workerd` with a real D1 binding, so the
 * assertions are about SQLite's behaviour rather than about a mock's.
 */

const T0 = 1_700_000_000;
const MINUTE = 60;

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(8, "0")}`;
}

async function insertReturningId(sql: string, params: unknown[]): Promise<number> {
  const result = await env.DB.prepare(sql)
    .bind(...params)
    .run();
  return Number(result.meta.last_row_id);
}

interface TargetOptions {
  failureThreshold?: number;
  recoveryThreshold?: number;
  intervalSeconds?: number;
  severity?: string;
}

/** Creates a component, a probe target, and the matching probe_state row. */
async function seedTarget(options: TargetOptions = {}): Promise<number> {
  const {
    failureThreshold = 3,
    recoveryThreshold = 2,
    intervalSeconds = MINUTE,
    severity = "partial_outage",
  } = options;

  const page = await env.DB.prepare("SELECT id FROM page WHERE slug = ?1")
    .bind("example")
    .first<{ id: number }>();
  if (!page) throw new Error("seed: the migrated page row is missing");

  const componentPublicId = nextId("comp");
  const componentId = await insertReturningId(
    `INSERT INTO component (public_id, page_id, name, available_since, order_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?4, ?4)`,
    [componentPublicId, page.id, `Component ${componentPublicId}`, T0],
  );

  const targetId = await insertReturningId(
    `INSERT INTO probe_target
       (public_id, component_id, url, severity, failure_threshold, recovery_threshold,
        interval_seconds, enabled, next_check_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0, ?8, ?8)`,
    [
      nextId("tgt"),
      componentId,
      `https://example.test/${componentPublicId}`,
      severity,
      failureThreshold,
      recoveryThreshold,
      intervalSeconds,
      T0,
    ],
  );

  await env.DB.prepare(
    "INSERT INTO probe_state (probe_target_id, next_check_at, updated_at) VALUES (?1, 0, ?2)",
  )
    .bind(targetId, T0)
    .run();

  return targetId;
}

interface StateRow {
  consecutive_failures: number;
  consecutive_successes: number;
  transition_seq: number;
  last_probe_at: number | null;
  last_result_id: string | null;
  first_failed_at: number | null;
  first_recovery_at: number | null;
  open_impact_id: number | null;
  next_check_at: number;
}

async function readState(targetId: number): Promise<StateRow> {
  const row = await env.DB.prepare(
    `SELECT consecutive_failures, consecutive_successes, transition_seq, last_probe_at,
            last_result_id, first_failed_at, first_recovery_at, open_impact_id, next_check_at
       FROM probe_state WHERE probe_target_id = ?1`,
  )
    .bind(targetId)
    .first<StateRow>();
  if (!row) throw new Error(`no probe_state for target ${targetId}`);
  return row;
}

interface ImpactRow {
  public_id: string;
  severity: string;
  start_at: number;
  end_at: number | null;
  estimated: number;
  opened_by_result_id: string | null;
}

async function impacts(targetId: number): Promise<ImpactRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT public_id, severity, start_at, end_at, estimated, opened_by_result_id
       FROM impact WHERE probe_target_id = ?1 ORDER BY id`,
  )
    .bind(targetId)
    .all<ImpactRow>();
  return results;
}

interface TransitionRow {
  transition_seq: number;
  probe_result_id: string;
  from_state: string;
  to_state: string;
  detected_at: number | null;
  resolved_at: number | null;
  impact_id: number | null;
}

async function transitions(targetId: number): Promise<TransitionRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT transition_seq, probe_result_id, from_state, to_state, detected_at, resolved_at, impact_id
       FROM probe_transition WHERE probe_target_id = ?1 ORDER BY transition_seq`,
  )
    .bind(targetId)
    .all<TransitionRow>();
  return results;
}

async function countRows(table: string, targetId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE probe_target_id = ?1`,
  )
    .bind(targetId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

function observation(targetId: number, over: Partial<ProbeObservation> = {}): ProbeObservation {
  return { resultId: nextId("res"), targetId, observedAt: T0, ok: true, ...over };
}

/** Sends `count` results, one interval apart, returning the last outcome. */
async function run(
  targetId: number,
  count: number,
  ok: boolean,
  startAt = T0,
): Promise<Awaited<ReturnType<typeof applyProbeObservation>>> {
  let outcome = await applyProbeObservation(
    env.DB,
    observation(targetId, { observedAt: startAt, ok }),
  );
  for (let i = 1; i < count; i += 1) {
    outcome = await applyProbeObservation(
      env.DB,
      observation(targetId, { observedAt: startAt + i * MINUTE, ok }),
    );
  }
  return outcome;
}

describe("opening an impact", () => {
  it("records failures below the threshold without opening anything", async () => {
    const target = await seedTarget({ failureThreshold: 3 });

    const first = await run(target, 1, false, T0);
    const second = await run(target, 1, false, T0 + MINUTE);

    expect(first).toEqual({ kind: "applied", transition: "none", impactPublicId: null });
    expect(second).toEqual({ kind: "applied", transition: "none", impactPublicId: null });

    expect(await impacts(target)).toHaveLength(0);
    expect(await countRows("probe_transition", target)).toBe(0);

    const state = await readState(target);
    expect(state.consecutive_failures).toBe(2);
    expect(state.consecutive_successes).toBe(0);
    // The failure run started at the first failure, and is carried forward.
    expect(state.first_failed_at).toBe(T0);
    expect(state.transition_seq).toBe(2);
  });

  it("opens exactly one impact when the threshold is reached", async () => {
    const target = await seedTarget({ failureThreshold: 3 });

    await run(target, 2, false, T0);
    const third = await applyProbeObservation(
      env.DB,
      observation(target, { observedAt: T0 + 2 * MINUTE, ok: false }),
    );

    expect(third.kind).toBe("applied");
    expect(third.kind === "applied" && third.transition).toBe("opened");

    const rows = await impacts(target);
    expect(rows).toHaveLength(1);
    // The outage began on the first failure of the run, not on the observation
    // that confirmed it. Using the confirming time would under-report this
    // outage by (failure_threshold - 1) x interval = 120 s.
    expect(rows[0]!.start_at).toBe(T0);
    expect(rows[0]!.end_at).toBeNull();
    expect(rows[0]!.severity).toBe("partial_outage");
    expect(rows[0]!.estimated).toBe(1);
  });

  it("does not open a second impact while one is already open", async () => {
    const target = await seedTarget({ failureThreshold: 1 });

    const first = await applyProbeObservation(env.DB, observation(target, { ok: false }));
    expect(first.kind === "applied" && first.transition).toBe("opened");

    const again = await run(target, 3, false, T0 + MINUTE);
    expect(again).toEqual({ kind: "applied", transition: "none", impactPublicId: null });

    expect(await impacts(target)).toHaveLength(1);
    // Only the opening transition is logged; continued failures are not events.
    expect(await countRows("probe_transition", target)).toBe(1);
  });

  it("logs the transition with the confirmation time kept apart from the fault start", async () => {
    const target = await seedTarget({ failureThreshold: 2 });
    await run(target, 2, false, T0);

    const logged = await transitions(target);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.transition_seq).toBe(2);
    expect(logged[0]!.from_state).toBe("up");
    expect(logged[0]!.to_state).toBe("down");
    expect(logged[0]!.detected_at).toBe(T0 + MINUTE);
    expect(logged[0]!.resolved_at).toBeNull();
    expect(logged[0]!.impact_id).not.toBeNull();
  });
});

describe("closing an impact", () => {
  it("does not close before the recovery threshold is reached", async () => {
    const target = await seedTarget({ failureThreshold: 1, recoveryThreshold: 3 });
    await applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 }));

    await run(target, 2, true, T0 + MINUTE);

    const rows = await impacts(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.end_at).toBeNull();

    const state = await readState(target);
    expect(state.consecutive_successes).toBe(2);
    expect(state.first_recovery_at).toBe(T0 + MINUTE);
  });

  it("closes at the recovery threshold using the first recovery time", async () => {
    const target = await seedTarget({ failureThreshold: 1, recoveryThreshold: 2 });
    await applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 }));

    await run(target, 2, true, T0 + MINUTE);

    const rows = await impacts(target);
    expect(rows).toHaveLength(1);
    // The fault ended on the first success of the recovery run, not on the
    // observation that confirmed recovery.
    expect(rows[0]!.end_at).toBe(T0 + MINUTE);

    const logged = await transitions(target);
    expect(logged).toHaveLength(2);
    expect(logged[1]!.from_state).toBe("down");
    expect(logged[1]!.to_state).toBe("up");
    expect(logged[1]!.resolved_at).toBe(T0 + 2 * MINUTE);

    const state = await readState(target);
    expect(state.open_impact_id).toBeNull();
  });

  it("opens a new impact when the target fails again", async () => {
    const target = await seedTarget({ failureThreshold: 1, recoveryThreshold: 1 });

    await applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 }));
    await applyProbeObservation(env.DB, observation(target, { ok: true, observedAt: T0 + MINUTE }));
    await applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 + 2 * MINUTE }));

    const rows = await impacts(target);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.end_at).toBe(T0 + MINUTE);
    expect(rows[1]!.start_at).toBe(T0 + 2 * MINUTE);
    expect(rows[1]!.end_at).toBeNull();
  });
});

describe("thresholds count consecutive results", () => {
  it("resets the failure run when a success intervenes", async () => {
    const target = await seedTarget({ failureThreshold: 3 });

    await run(target, 2, false, T0);
    await run(target, 1, true, T0 + 2 * MINUTE);
    expect(await impacts(target)).toHaveLength(0);

    const state = await readState(target);
    expect(state.consecutive_failures).toBe(0);
    expect(state.first_failed_at).toBeNull();

    // The third failure of the *new* run is the one that opens the impact, and
    // the run began at T0 + 3 x interval, not at the original T0.
    const outcome = await run(target, 3, false, T0 + 3 * MINUTE);
    expect(outcome.kind === "applied" && outcome.transition).toBe("opened");

    const rows = await impacts(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.start_at).toBe(T0 + 3 * MINUTE);
  });
});

describe("idempotency and retry", () => {
  it("treats a repeated observation as a replay", async () => {
    const target = await seedTarget({ failureThreshold: 3 });
    const obs = observation(target, { ok: false, observedAt: T0 });

    const first = await applyProbeObservation(env.DB, obs);
    const second = await applyProbeObservation(env.DB, obs);
    const third = await applyProbeObservation(env.DB, obs);

    expect(first.kind).toBe("applied");
    expect(second).toEqual({ kind: "replay" });
    expect(third).toEqual({ kind: "replay" });

    // The counter advanced once, not three times.
    const state = await readState(target);
    expect(state.consecutive_failures).toBe(1);
    expect(state.transition_seq).toBe(1);
    expect(await countRows("probe_result", target)).toBe(1);
  });

  it("does not re-transition when the observation that opened the impact is replayed", async () => {
    const target = await seedTarget({ failureThreshold: 1 });
    const obs = observation(target, { ok: false, observedAt: T0 });

    const first = await applyProbeObservation(env.DB, obs);
    const replay = await applyProbeObservation(env.DB, obs);

    expect(first.kind === "applied" && first.transition).toBe("opened");
    expect(replay).toEqual({ kind: "replay" });

    expect(await impacts(target)).toHaveLength(1);
    expect(await countRows("probe_transition", target)).toBe(1);
    expect((await readState(target)).transition_seq).toBe(1);
  });

  it("rejects an out-of-order observation instead of rewinding the counters", async () => {
    const target = await seedTarget({ failureThreshold: 3 });

    await applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 + 5 * MINUTE }));
    const late = await applyProbeObservation(
      env.DB,
      observation(target, { ok: true, observedAt: T0 }),
    );

    expect(late).toEqual({ kind: "stale", reason: "out_of_order" });

    const state = await readState(target);
    expect(state.consecutive_failures).toBe(1);
    expect(state.consecutive_successes).toBe(0);
    expect(state.last_probe_at).toBe(T0 + 5 * MINUTE);
  });
});

describe("concurrency", () => {
  it("produces one impact when two observations for the same target race", async () => {
    const target = await seedTarget({ failureThreshold: 2 });

    const outcomes = await Promise.all([
      applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 })),
      applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 })),
    ]);

    expect(await impacts(target)).toHaveLength(1);
    // Both distinct observations are applied — two failures, one impact. This is
    // the regression guard for a real bug: when the observation was recorded
    // before the compare-and-swap, the call that lost the race committed its
    // `probe_result` row, then on retry saw its own insert change nothing and
    // reported the observation as a *replay*. A lost failure was reported as a
    // duplicate, and its counter was never incremented.
    expect(outcomes.filter((o) => o.kind === "applied")).toHaveLength(2);
    expect(outcomes.filter((o) => o.kind === "replay")).toHaveLength(0);
    expect(outcomes.filter((o) => o.kind === "anomaly")).toHaveLength(0);

    const state = await readState(target);
    // Both observations were counted, and the sequence advanced exactly twice.
    expect(state.consecutive_failures).toBe(2);
    expect(state.transition_seq).toBe(2);
    expect(state.open_impact_id).not.toBeNull();
    expect(await countRows("probe_result", target)).toBe(2);
    expect(await countRows("probe_transition", target)).toBe(1);
  });

  it("applies a doubly delivered observation only once", async () => {
    const target = await seedTarget({ failureThreshold: 1 });
    const obs = observation(target, { ok: false, observedAt: T0 });

    const outcomes = await Promise.all([
      applyProbeObservation(env.DB, obs),
      applyProbeObservation(env.DB, obs),
    ]);

    const applied = outcomes.filter((o) => o.kind === "applied");
    const replayed = outcomes.filter((o) => o.kind === "replay");
    expect(applied).toHaveLength(1);
    expect(replayed).toHaveLength(1);

    expect(await impacts(target)).toHaveLength(1);
    expect(await countRows("probe_result", target)).toBe(1);
    expect((await readState(target)).transition_seq).toBe(1);
  });

  it("never leaves two open impacts after a burst of concurrent failures", async () => {
    const target = await seedTarget({ failureThreshold: 1 });

    const burst = Array.from({ length: 8 }, (_, i) =>
      applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 + i })),
    );
    const outcomes = await Promise.all(burst);

    // What is asserted here is *consistency*, not that all eight samples were
    // counted. Under N-way contention a caller can lose the CAS, retry, and find
    // a later observation already applied, at which point counting it would
    // rewind the counters — so it is rejected as out of order instead. That is
    // the documented trade-off, and the numbers below hold either way.
    expect(outcomes.filter((o) => o.kind === "anomaly")).toHaveLength(0);

    const state = await readState(target);

    // The invariant that matters: one open impact, one logged transition, and
    // the cached pointer agreeing with `impact`.
    const open = (await impacts(target)).filter((i) => i.end_at === null);
    expect(open).toHaveLength(1);
    expect(await countRows("probe_transition", target)).toBe(1);
    expect(state.open_impact_id).not.toBeNull();

    // Every observation that was accepted advanced the sequence and was
    // recorded exactly once; none was accepted without being recorded.
    expect(state.transition_seq).toBeGreaterThanOrEqual(1);
    expect(state.transition_seq).toBeLessThanOrEqual(8);
    expect(state.consecutive_failures).toBe(state.transition_seq);
    expect(await countRows("probe_result", target)).toBe(state.transition_seq);

    // Anything not applied was reported as such, not silently dropped.
    const unapplied = outcomes.filter((o) => o.kind !== "applied");
    expect(unapplied.every((o) => o.kind === "stale")).toBe(true);
  });
});

describe("transactionality", () => {
  it("rolls the counter update back when a later statement in the batch fails", async () => {
    // This is the assumption the whole design rests on: `batch()` is one
    // transaction, so "counter updated, impact insert failed" cannot persist.
    // The plan asks for it explicitly, and asserting it against a real D1
    // binding is the only way to know.
    const target = await seedTarget({ failureThreshold: 1 });

    await env.DB.prepare(
      `INSERT INTO probe_transition
         (public_id, probe_target_id, transition_seq, probe_result_id, from_state, to_state, created_at)
       VALUES ('collide-with-me', ?1, 999, 'res-collide', 'up', 'down', ?2)`,
    )
      .bind(target, T0)
      .run();

    const before = await readState(target);

    // The batch must fail on the *primary key collision*, not on a malformed
    // binding — otherwise this test would pass for the wrong reason and prove
    // nothing about transactionality.
    await expect(
      env.DB.batch([
        // A perfectly valid compare-and-swap, nonce and all.
        env.DB.prepare(CAS_STATE_SQL).bind(
          1,
          0,
          T0,
          null,
          T0 + MINUTE,
          "res-does-not-commit",
          "nonce-does-not-commit",
          T0 + 2 * MINUTE,
          target,
          before.transition_seq,
        ),
        // ...followed by a statement that must fail on the primary key.
        env.DB.prepare(
          `INSERT INTO probe_transition
             (public_id, probe_target_id, transition_seq, probe_result_id, from_state, to_state, created_at)
           VALUES ('collide-with-me', ?1, ?2, 'res-other', 'up', 'down', ?3)`,
        ).bind(target, before.transition_seq + 1, T0),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed|SQLITE_CONSTRAINT/);

    const after = await readState(target);
    expect(after.transition_seq).toBe(before.transition_seq);
    expect(after.consecutive_failures).toBe(before.consecutive_failures);
    expect(after.last_result_id).toBe(before.last_result_id);
  });

  it("forbids a second open impact for the same target", async () => {
    // The backstop behind the guarded insert in the transition batch.
    const target = await seedTarget();

    const openAnother = () =>
      env.DB.prepare(
        `INSERT INTO impact (public_id, component_id, probe_target_id, severity, start_at, estimated, created_at, updated_at)
         SELECT ?1, t.component_id, t.id, 'partial_outage', ?2, 1, ?2, ?2
           FROM probe_target t WHERE t.id = ?3`,
      )
        .bind(nextId("imp"), T0, target)
        .run();

    await openAnother();
    await expect(openAnother()).rejects.toThrow();
  });

  it("accepts a new open impact once the previous one is closed", async () => {
    const target = await seedTarget({ failureThreshold: 1, recoveryThreshold: 1 });

    await applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 }));
    await applyProbeObservation(env.DB, observation(target, { ok: true, observedAt: T0 + MINUTE }));
    await applyProbeObservation(env.DB, observation(target, { ok: false, observedAt: T0 + 2 * MINUTE }));

    expect(await impacts(target)).toHaveLength(2);
    expect((await readState(target)).open_impact_id).not.toBeNull();
  });
});

describe("misconfiguration", () => {
  it("reports a missing target rather than throwing", async () => {
    const outcome = await applyProbeObservation(env.DB, {
      resultId: nextId("res"),
      targetId: 987654321,
      observedAt: T0,
      ok: false,
    });

    expect(outcome.kind).toBe("unconfigured");
  });
});

describe("scheduling", () => {
  it("advances next_check_at by one interval from the observation", async () => {
    const target = await seedTarget({ intervalSeconds: 120 });
    await applyProbeObservation(env.DB, observation(target, { observedAt: T0 }));

    expect((await readState(target)).next_check_at).toBe(T0 + 120);
  });

  it("records the observation itself with its status code and latency", async () => {
    const target = await seedTarget();
    await applyProbeObservation(
      env.DB,
      observation(target, { ok: false, statusCode: 503, latencyMs: 812, error: "bad gateway" }),
    );

    const row = await env.DB.prepare(
      "SELECT ok, status_code, latency_ms, error, observed_at FROM probe_result WHERE probe_target_id = ?1",
    )
      .bind(target)
      .first<{
        ok: number;
        status_code: number;
        latency_ms: number;
        error: string;
        observed_at: number;
      }>();

    expect(row).toEqual({
      ok: 0,
      status_code: 503,
      latency_ms: 812,
      error: "bad gateway",
      observed_at: T0,
    });
  });
});
