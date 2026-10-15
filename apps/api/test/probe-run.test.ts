import { beforeEach, describe, expect, it } from "vitest";

import { runProbes } from "../src/probe/run";
import { testEnv as env } from "./env";
import { createComponent, createPage, createProbeTarget, fakeFetch, T0 } from "./helpers";

/**
 * The probe scheduler.
 *
 * `test/transition.test.ts` owns the correctness of the state machine, so these
 * tests are about the parts that only exist here: which targets a tick picks up,
 * what happens to one whose URL the guard refuses, and whether the schedule
 * actually advances.
 *
 * The scheduling assertions are not decoration. An earlier revision advanced a
 * `next_check_at` column on `probe_state` while the due query read the one on
 * `probe_target`, so `interval_seconds` had no effect and every enabled target
 * was polled on every tick. Nothing failed, nothing logged, and the only visible
 * symptom would have been a probe volume 60x the configured rate — which is
 * exactly the class of bug that has to be caught by asserting the column the
 * scheduler reads.
 */

/**
 * Disable every target that a previous test in this file left behind.
 *
 * Unlike the other suites, these tests cannot be isolated by seeding their own
 * rows: `runProbes` is a scheduler, so it selects *every* due target in the
 * database, and a leftover enabled target with `next_check_at = 0` would be
 * picked up and counted in `due`, `opened` and the page lists. The first version
 * of this file did exactly that and reported four failures that were all the
 * same fixture bug wearing different clothes.
 *
 * Disabling rather than deleting keeps the leftover rows' effects out of the
 * selection while leaving them intact for tests that assert on their own state.
 */
beforeEach(async () => {
  await env.DB.prepare("UPDATE probe_target SET enabled = 0").run();
});

async function cursor(targetId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT next_check_at FROM probe_target WHERE id = ?1")
    .bind(targetId)
    .first<{ next_check_at: number }>();
  return row!.next_check_at;
}

async function stateOf(targetId: number): Promise<{
  consecutive_failures: number;
  consecutive_successes: number;
  transition_seq: number;
  first_failed_at: number | null;
  last_result_id: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT consecutive_failures, consecutive_successes, transition_seq,
            first_failed_at, last_result_id
       FROM probe_state WHERE probe_target_id = ?1`,
  )
    .bind(targetId)
    .first<{
      consecutive_failures: number;
      consecutive_successes: number;
      transition_seq: number;
      first_failed_at: number | null;
      last_result_id: string | null;
    }>();
  return row!;
}

async function resultCount(targetId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM probe_result WHERE probe_target_id = ?1",
  )
    .bind(targetId)
    .first<{ n: number }>();
  return row!.n;
}

async function openImpacts(targetId: number): Promise<Array<{ start_at: number; end_at: number | null }>> {
  const { results } = await env.DB.prepare(
    "SELECT start_at, end_at FROM impact WHERE probe_target_id = ?1 ORDER BY id",
  )
    .bind(targetId)
    .all<{ start_at: number; end_at: number | null }>();
  return results;
}

describe("selection", () => {
  it("reports an empty run rather than doing nothing silently", async () => {
    const summary = await runProbes(env.DB, { now: T0 });
    expect(summary.due).toBe(0);
    expect(summary.probed).toBe(0);
    expect(summary.affectedPageIds).toEqual([]);
    expect(summary.transitionedPageIds).toEqual([]);
  });

  it("ignores a disabled target", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    await createProbeTarget(component.id, { enabled: false });

    const { fetchImpl, calls } = fakeFetch();
    const summary = await runProbes(env.DB, { now: T0, fetchImpl });

    expect(summary.due).toBe(0);
    expect(calls).toEqual([]);
  });

  it("ignores a target whose next check is in the future", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    await createProbeTarget(component.id, { nextCheckAt: T0 + 600 });

    const { fetchImpl, calls } = fakeFetch();
    const summary = await runProbes(env.DB, { now: T0, fetchImpl });

    expect(summary.due).toBe(0);
    expect(calls).toEqual([]);
  });

  it("caps how many targets one run takes", async () => {
    const page = await createPage();
    for (let index = 0; index < 3; index += 1) {
      const component = await createComponent(page.id, { name: `Component ${index}` });
      await createProbeTarget(component.id);
    }

    const { fetchImpl, calls } = fakeFetch();
    const summary = await runProbes(env.DB, { now: T0, fetchImpl, maxTargetsPerRun: 2 });

    expect(summary.due).toBe(2);
    expect(calls).toHaveLength(2);
  });
});

describe("a refused URL is not an outage", () => {
  it("skips the target without making a request", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id, {
      url: "http://127.0.0.1:8080/health",
    });

    const { fetchImpl, calls } = fakeFetch({ ok: false });
    const summary = await runProbes(env.DB, { now: T0, fetchImpl });

    expect(summary.skippedConfiguration).toBe(1);
    expect(summary.probed).toBe(0);
    // The load-bearing assertion: the request was never attempted, so a
    // configuration typo cannot reach an internal service.
    expect(calls).toEqual([]);
    expect(await resultCount(target.id)).toBe(0);

    const state = await stateOf(target.id);
    expect(state.consecutive_failures).toBe(0);
    expect(state.transition_seq).toBe(0);
    // A skipped target has no impact, so the component derives as uncovered
    // rather than as down.
    expect(await openImpacts(target.id)).toEqual([]);
  });

  it("pushes the schedule forward so it is not retried in a tight loop", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id, {
      url: "https://10.0.0.1/health",
      intervalSeconds: 120,
    });

    const { fetchImpl } = fakeFetch();
    await runProbes(env.DB, { now: T0, fetchImpl });

    expect(await cursor(target.id)).toBe(T0 + 120);

    const second = await runProbes(env.DB, { now: T0 + 60, fetchImpl });
    expect(second.due).toBe(0);
  });
});

describe("scheduling", () => {
  it("does not re-probe a target before its interval has elapsed", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id, { intervalSeconds: 60 });

    const { fetchImpl, calls } = fakeFetch();
    const first = await runProbes(env.DB, { now: T0, fetchImpl });
    expect(first.due).toBe(1);
    expect(first.probed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await cursor(target.id)).toBe(T0 + 60);

    // Half an interval later the target is not due. This is the assertion that
    // fails if the cursor is written somewhere the due query does not read.
    const tooEarly = await runProbes(env.DB, { now: T0 + 30, fetchImpl });
    expect(tooEarly.due).toBe(0);
    expect(calls).toHaveLength(1);

    const onTime = await runProbes(env.DB, { now: T0 + 60, fetchImpl });
    expect(onTime.due).toBe(1);
    expect(calls).toHaveLength(2);
    expect(await cursor(target.id)).toBe(T0 + 120);
  });

  it("reports the page and component it touched", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    await createProbeTarget(component.id);

    const { fetchImpl } = fakeFetch();
    const summary = await runProbes(env.DB, { now: T0, fetchImpl });

    // Uptime is recomputed for every observation, because even a success is
    // coverage evidence; a snapshot is only republished when output changed.
    expect(summary.affectedPageIds).toEqual([page.id]);
    expect(summary.affectedComponentIds).toEqual([component.id]);
    expect(summary.transitionedPageIds).toEqual([]);
  });
});

describe("thresholds", () => {
  it("opens one impact only when the failure threshold is reached", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id, {
      failureThreshold: 3,
      intervalSeconds: 60,
    });

    const { fetchImpl } = fakeFetch({ ok: false, status: 503 });

    const first = await runProbes(env.DB, { now: T0, fetchImpl });
    expect(first.opened).toBe(0);
    expect(await openImpacts(target.id)).toEqual([]);

    const second = await runProbes(env.DB, { now: T0 + 60, fetchImpl });
    expect(second.opened).toBe(0);
    expect(await openImpacts(target.id)).toEqual([]);

    const third = await runProbes(env.DB, { now: T0 + 120, fetchImpl });
    expect(third.opened).toBe(1);
    expect(third.transitionedPageIds).toEqual([page.id]);

    const impacts = await openImpacts(target.id);
    expect(impacts).toHaveLength(1);
    // The outage began on the *first* failure, not on the confirming third
    // observation. Using the confirming time would under-report every outage by
    // (failure_threshold - 1) x interval.
    expect(impacts[0]!.start_at).toBe(T0);
    expect(impacts[0]!.end_at).toBeNull();

    // A fourth failure must not open a second impact.
    const fourth = await runProbes(env.DB, { now: T0 + 180, fetchImpl });
    expect(fourth.opened).toBe(0);
    expect(fourth.transitionedPageIds).toEqual([]);
    expect(await openImpacts(target.id)).toHaveLength(1);
  });

  it("closes the impact when the recovery threshold is reached", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id, {
      failureThreshold: 1,
      recoveryThreshold: 2,
      intervalSeconds: 60,
    });

    const failing = fakeFetch({ ok: false, status: 500 });
    await runProbes(env.DB, { now: T0, fetchImpl: failing.fetchImpl });
    expect(await openImpacts(target.id)).toHaveLength(1);

    const healthy = fakeFetch({ ok: true });
    const firstSuccess = await runProbes(env.DB, { now: T0 + 60, fetchImpl: healthy.fetchImpl });
    expect(firstSuccess.closed).toBe(0);
    expect((await openImpacts(target.id))[0]!.end_at).toBeNull();

    const secondSuccess = await runProbes(env.DB, { now: T0 + 120, fetchImpl: healthy.fetchImpl });
    expect(secondSuccess.closed).toBe(1);
    expect(secondSuccess.transitionedPageIds).toEqual([page.id]);

    const impacts = await openImpacts(target.id);
    expect(impacts[0]!.end_at).toBe(T0 + 60);
  });

  it("treats a transport failure as a failed probe rather than an error", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id, { failureThreshold: 1 });

    const { fetchImpl } = fakeFetch({ throw: "socket hang up" });
    const summary = await runProbes(env.DB, { now: T0, fetchImpl });

    expect(summary.probed).toBe(1);
    expect(summary.opened).toBe(1);
    const row = await env.DB.prepare(
      "SELECT ok, error FROM probe_result WHERE probe_target_id = ?1",
    )
      .bind(target.id)
      .first<{ ok: number; error: string | null }>();
    expect(row!.ok).toBe(0);
    expect(row!.error).toBe("socket hang up");
  });
});

describe("replay", () => {
  it("does not double-count an observation that was already applied", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id, { failureThreshold: 1 });

    const { fetchImpl } = fakeFetch({ ok: true });
    // A constant id generator makes the second run reuse the first run's
    // observation id, which is what a redelivered-but-already-committed
    // observation looks like. The schedule is rewound so the target is due
    // again, because in reality the redelivery would arrive on a later tick.
    const newId = () => "fixed-id-for-replay";

    const first = await runProbes(env.DB, { now: T0, fetchImpl, newId });
    expect(first.applied).toBe(1);

    await env.DB.prepare("UPDATE probe_target SET next_check_at = 0 WHERE id = ?1")
      .bind(target.id)
      .run();

    const second = await runProbes(env.DB, { now: T0 + 60, fetchImpl, newId });
    expect(second.replay).toBe(1);
    expect(second.applied).toBe(0);
    expect(second.affectedPageIds).toEqual([]);

    const state = await stateOf(target.id);
    // The counter did not move twice, and the observation was not stored twice.
    expect(state.consecutive_successes).toBe(1);
    expect(await resultCount(target.id)).toBe(1);
  });
});

describe("provisioning problems", () => {
  it("reports a target with no state row instead of throwing", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id);

    await env.DB.prepare("DELETE FROM probe_state WHERE probe_target_id = ?1")
      .bind(target.id)
      .run();

    const { fetchImpl } = fakeFetch();
    const summary = await runProbes(env.DB, { now: T0, fetchImpl });

    // The request is still made — the target is configured and enabled, and
    // refusing to probe it would hide the problem rather than report it.
    expect(summary.probed).toBe(1);
    expect(summary.unconfigured).toBe(1);
    expect(summary.applied).toBe(0);
    expect(await cursor(target.id)).toBe(0);
  });
});
