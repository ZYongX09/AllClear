import { beforeEach, describe, expect, it } from "vitest";

import { applyRetention } from "../src/lib/retention";
import {
  computeDailyUptime,
  persistDailyUptime,
  recomputeRecentDays,
} from "../src/lib/uptime-recompute";
import { testEnv as env } from "./env";
import { createComponent, createPage, createProbeTarget } from "./helpers";

/**
 * Materialised uptime and probe-result retention.
 *
 * `daily_uptime` is the only precomputed aggregate in the project, so it is the
 * only place a stale or invented number can hide. These tests are mostly about
 * the two ways it could lie: crediting unmeasured time as healthy, and reporting
 * a number when there was nothing to measure.
 *
 * The window under test is the UTC day 2023-11-14, chosen because it is entirely
 * in the past relative to the `now` values used here. A day that straddled `now`
 * would exercise the partial-day path instead and make every expected number
 * depend on the wall clock.
 */

const DAY = "2023-11-14";
const DAY_START = 1_699_920_000;
const DAY_END = DAY_START + 86_400;
/** `now` a minute after the day ends, i.e. 2023-11-15T00:01:00Z. */
const AFTER = DAY_END + 60;

const BEFORE_DAY = DAY_START - 86_400;

/**
 * With a 30-day horizon and `now` on 2023-11-15, the day about to fall out of
 * the window is 2023-10-16 — not the 15th, which is the off-by-one the horizon
 * arithmetic would produce if the boundary were computed from `now` rather than
 * from the start of the day.
 */
const BOUNDARY_DAY = "2023-10-16";
const BOUNDARY_START = Date.parse(`${BOUNDARY_DAY}T00:00:00Z`) / 1000;

let resultCounter = 0;

/** Insert observations in batches, since a day's worth is hundreds of rows. */
async function insertResults(
  targetId: number,
  observedAt: readonly number[],
  ok = true,
): Promise<void> {
  const chunkSize = 200;
  for (let offset = 0; offset < observedAt.length; offset += chunkSize) {
    const chunk = observedAt.slice(offset, offset + chunkSize);
    await env.DB.batch(
      chunk.map((timestamp) => {
        resultCounter += 1;
        return env.DB.prepare(
          `INSERT INTO probe_result
             (public_id, probe_target_id, observed_at, ok, status_code, latency_ms, error, created_at)
           VALUES (?1, ?2, ?3, ?4, 200, 12, NULL, ?3)`,
        ).bind(`res-${resultCounter}`, targetId, timestamp, ok ? 1 : 0);
      }),
    );
  }
}

/** Every `interval` seconds from `from` up to but not including `to`. */
function every(interval: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += interval) out.push(t);
  return out;
}

async function insertProbeImpact(
  componentId: number,
  targetId: number,
  severity: string,
  startAt: number,
  endAt: number | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO impact
       (public_id, component_id, probe_target_id, change_id, severity,
        start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 1, NULL, ?5, ?5)`,
  )
    .bind(`imp-${componentId}-${startAt}`, componentId, targetId, severity, startAt, endAt)
    .run();
}

async function insertManualImpact(
  componentId: number,
  severity: string,
  startAt: number,
  endAt: number | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO impact
       (public_id, component_id, probe_target_id, change_id, severity,
        start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
     VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, 0, NULL, ?4, ?4)`,
  )
    .bind(`imp-manual-${componentId}-${startAt}`, componentId, severity, startAt, endAt)
    .run();
}

/** A maintenance window linked to the component, as the admin path creates it. */
async function insertMaintenance(
  pageId: number,
  componentId: number,
  startsAt: number,
  endsAt: number | null,
  status = "in_progress",
): Promise<string> {
  const publicId = `chg-maint-${componentId}-${startsAt}-${status}`;
  await env.DB.prepare(
    `INSERT INTO change
       (public_id, page_id, kind, status, title, body, severity, starts_at, ends_at,
        scheduled_start_at, scheduled_end_at, created_by, created_at, updated_at)
     VALUES (?1, ?2, 'maintenance', ?5, 'Planned work', NULL, 'none', ?3, ?4,
             NULL, NULL, NULL, ?3, ?3)`,
  )
    .bind(publicId, pageId, startsAt, endsAt, status)
    .run();
  const row = await env.DB.prepare("SELECT id FROM change WHERE public_id = ?1")
    .bind(publicId)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO change_component (change_id, component_id) VALUES (?1, ?2)",
  )
    .bind(row!.id, componentId)
    .run();
  return publicId;
}

interface DailyRow {
  covered_seconds: number;
  unknown_seconds: number;
  downtime_weighted: number;
  uptime: number | null;
  worst_status: string;
  computed_at: number;
}

async function dailyRow(componentId: number, day = DAY): Promise<DailyRow | null> {
  return env.DB.prepare(
    `SELECT covered_seconds, unknown_seconds, downtime_weighted, uptime, worst_status, computed_at
       FROM daily_uptime WHERE component_id = ?1 AND day = ?2`,
  )
    .bind(componentId, day)
    .first<DailyRow>();
}

async function resultCountFor(targetId: number, from?: number): Promise<number> {
  const row =
    from === undefined
      ? await env.DB.prepare("SELECT COUNT(*) AS n FROM probe_result WHERE probe_target_id = ?1")
          .bind(targetId)
          .first<{ n: number }>()
      : await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM probe_result WHERE probe_target_id = ?1 AND observed_at >= ?2",
        )
          .bind(targetId, from)
          .first<{ n: number }>();
  return row!.n;
}

describe("computeDailyUptime", () => {
  it("returns nothing for a component that does not exist", async () => {
    expect(await computeDailyUptime(env.DB, 999_999_999, DAY, AFTER)).toBeNull();
  });

  it("reports an unmeasured day as unknown rather than as perfect", async () => {
    // The single most misleading number this system could print is 100% uptime
    // derived from never having measured anything.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    expect(row).not.toBeNull();
    expect(row!.uptime).toBeNull();
    expect(row!.coveredSeconds).toBe(0);
    expect(row!.unknownSeconds).toBe(86_400);
    expect(row!.worstStatus).toBe("unknown");
  });

  it("credits a fully covered healthy day as operational", async () => {
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    // 300 s spacing against a 300 s interval: `gapMax` is 600 s, so every
    // adjacent pair qualifies and the day is one continuous covered run.
    await insertResults(target.id, every(300, DAY_START, DAY_END));

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    // The final interval is uncovered: coverage is the union of gaps *between*
    // observations and deliberately does not extend past the last one, because
    // that would credit a prober that has stopped reporting.
    expect(row!.coveredSeconds).toBe(86_100);
    expect(row!.unknownSeconds).toBe(300);
    expect(row!.downtimeWeighted).toBe(0);
    expect(row!.uptime).toBe(1);
    expect(row!.worstStatus).toBe("operational");
  });

  it("counts only the covered part of a probe-sourced fault", async () => {
    // A probe samples. An impact it opened is bounded by two samples, and an
    // impact left open by a prober that stopped reporting must not be charged as
    // a full day of downtime.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    // Ten minutes of coverage at the start of the day.
    await insertResults(target.id, [DAY_START, DAY_START + 300, DAY_START + 600]);

    // A fault spanning the whole day, which is what an unclosed impact looks
    // like by the time anyone reads the calendar.
    await insertProbeImpact(component.id, target.id, "partial_outage", DAY_START - 3600, DAY_END);

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    expect(row!.coveredSeconds).toBe(600);
    expect(row!.unknownSeconds).toBe(86_400 - 600);
    // Half of the ten covered minutes, at the partial-outage weight of 0.5. The
    // other 85 800 seconds are unmeasured and are charged nothing.
    expect(row!.downtimeWeighted).toBe(300);
    expect(row!.uptime).toBeCloseTo(0.5, 10);
    expect(row!.worstStatus).toBe("partial_outage");
  });

  it("treats a hand-entered fault as evidence even with no coverage", async () => {
    // A human recording an outage is not a sample, so it counts wherever it
    // falls — including on a component with no probe target at all.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });

    await insertManualImpact(component.id, "full_outage", DAY_START, DAY_START + 3600);

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    expect(row!.coveredSeconds).toBe(3600);
    expect(row!.downtimeWeighted).toBe(3600);
    expect(row!.uptime).toBe(0);
    expect(row!.unknownSeconds).toBe(86_400 - 3600);
    expect(row!.worstStatus).toBe("full_outage");
  });

  it("returns null rather than 100% when maintenance excludes the whole day", async () => {
    // A window with a zero denominator has no uptime. Reporting 1.0 would turn
    // "nothing was measurable" into a perfect record.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    await insertMaintenance(page.id, component.id, DAY_START, DAY_END);

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    expect(row!.uptime).toBeNull();
    expect(row!.coveredSeconds).toBe(0);
    expect(row!.worstStatus).toBe("maintenance");
  });

  it("keeps a real fault in the denominator even when it falls inside maintenance", async () => {
    // A convenient maintenance window must not be able to launder real downtime
    // out of the record.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    await insertResults(target.id, every(300, DAY_START, DAY_END));
    await insertMaintenance(page.id, component.id, DAY_START, DAY_END);
    await insertManualImpact(component.id, "full_outage", DAY_START, DAY_START + 3600);

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    // The fault's hour is counted; the rest of the day is excluded.
    expect(row!.coveredSeconds).toBe(3600);
    expect(row!.downtimeWeighted).toBe(3600);
    expect(row!.uptime).toBe(0);
    expect(row!.worstStatus).toBe("full_outage");
  });

  it("still excludes a maintenance window after it is marked completed", async () => {
    // The window is a fact about that day; the change's present status is not.
    // Selecting windows by `status <> 'completed'` made a past day's uptime move
    // when someone closed the change: the same historical day reported a worse
    // number afterwards, and planned downtime inside an announced window was
    // charged as an outage once the window ended.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    await insertResults(target.id, every(300, DAY_START, DAY_END));
    const changePublicId = await insertMaintenance(
      page.id,
      component.id,
      DAY_START,
      DAY_END,
      "completed",
    );

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    expect(row!.uptime).toBeNull();
    expect(row!.coveredSeconds).toBe(0);
    expect(row!.worstStatus).toBe("maintenance");

    // And the same day computed with the change in any other state agrees, which
    // is the property the status filter broke.
    await env.DB.prepare("UPDATE change SET status = 'in_progress' WHERE public_id = ?1")
      .bind(changePublicId)
      .run();
    const reopened = await computeDailyUptime(env.DB, component.id, DAY, AFTER);
    expect(reopened!.uptime).toBe(row!.uptime);
    expect(reopened!.coveredSeconds).toBe(row!.coveredSeconds);
    expect(reopened!.worstStatus).toBe(row!.worstStatus);
  });

  it("excludes a scheduled window whose start has passed", async () => {
    // A window the operator announced and then never moved out of `scheduled`.
    // Its start time is what says whether it applies, and that start is in the
    // past, so the window applies. Nothing is hidden by saying so: a segment with
    // a real fault stays counted even inside a window.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    await insertResults(target.id, every(300, DAY_START, DAY_END));
    await insertMaintenance(page.id, component.id, DAY_START, DAY_END, "scheduled");

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    expect(row!.uptime).toBeNull();
    expect(row!.coveredSeconds).toBe(0);
    expect(row!.worstStatus).toBe("maintenance");
  });

  it("does not exclude a window that has not started yet", async () => {
    // The reason the status filter is not needed for the "announced but not
    // started" case: `starts_at` carries the announced start, so the overlap test
    // already excludes a future window. Today's span ends at `now`.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    const midday = DAY_START + 43_200;
    await insertResults(target.id, every(300, DAY_START, midday));
    // Starts at midday and runs for two hours — entirely after `now` below.
    await insertMaintenance(page.id, component.id, midday, midday + 7_200, "scheduled");

    const row = await computeDailyUptime(env.DB, component.id, DAY, DAY_START + 3_600);

    expect(row!.worstStatus).toBe("operational");
    expect(row!.coveredSeconds).toBe(3_600);
    expect(row!.unknownSeconds).toBe(0);
  });

  it("clips a window that predates the component", async () => {
    // A component that only came into existence at midday cannot have a full
    // day's uptime, and the missing morning is not an outage.
    const page = await createPage();
    const midday = DAY_START + 43_200;
    const component = await createComponent(page.id, { availableSince: midday });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    await insertResults(target.id, every(300, midday, DAY_END));

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    expect(row!.coveredSeconds).toBe(43_200 - 300);
    expect(row!.unknownSeconds).toBe(300);
    expect(row!.uptime).toBe(1);
  });

  it("never lets two overlapping severities be charged twice", async () => {
    // The reason the algorithm sweeps instead of unioning per severity: a
    // `partial_outage` and a `full_outage` overlapping in time must charge the
    // overlap once, at the worse weight. Summing the severities would produce
    // more downtime than the window contains.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    await insertResults(target.id, every(300, DAY_START, DAY_END));
    await insertManualImpact(component.id, "partial_outage", DAY_START, DAY_START + 7200);
    await insertManualImpact(component.id, "full_outage", DAY_START + 3600, DAY_START + 7200);

    const row = await computeDailyUptime(env.DB, component.id, DAY, AFTER);

    // 3600 s at 0.5 + 3600 s at 1.0 = 5400, not 3600x0.5 + 3600x1.0 counted
    // twice over the overlapping hour.
    expect(row!.downtimeWeighted).toBe(5400);
    expect(row!.uptime).toBeCloseTo(1 - 5400 / 86_100, 10);
  });
});

describe("persistDailyUptime", () => {
  it("replaces the row instead of accumulating", async () => {
    // Idempotence is what makes a missed cron run recoverable: the next run
    // recomputes the day from raw data and overwrites, so there is no
    // incremental state that can drift.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });

    const base = {
      componentId: component.id,
      day: DAY,
      coveredSeconds: 100,
      unknownSeconds: 200,
      downtimeWeighted: 25,
      uptime: 0.75,
      worstStatus: "degraded_performance" as const,
    };

    await persistDailyUptime(env.DB, base, AFTER);
    await persistDailyUptime(env.DB, base, AFTER);

    const first = await dailyRow(component.id);
    expect(first!.covered_seconds).toBe(100);
    expect(first!.computed_at).toBe(AFTER);

    await persistDailyUptime(
      env.DB,
      { ...base, coveredSeconds: 400, downtimeWeighted: 0, uptime: 1, worstStatus: "operational" },
      AFTER + 60,
    );

    const second = await dailyRow(component.id);
    expect(second!.covered_seconds).toBe(400);
    expect(second!.downtime_weighted).toBe(0);
    expect(second!.uptime).toBe(1);
    expect(second!.worst_status).toBe("operational");
    expect(second!.computed_at).toBe(AFTER + 60);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM daily_uptime WHERE component_id = ?1 AND day = ?2",
    )
      .bind(component.id, DAY)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("computes the same value twice when nothing changed", async () => {
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });
    await insertResults(target.id, every(300, DAY_START, DAY_END));

    const first = await computeDailyUptime(env.DB, component.id, DAY, AFTER);
    await persistDailyUptime(env.DB, first!, AFTER);
    const second = await computeDailyUptime(env.DB, component.id, DAY, AFTER);
    await persistDailyUptime(env.DB, second!, AFTER + 120);

    expect(second).toEqual(first);
  });
});

describe("recomputeRecentDays", () => {
  it("writes today and yesterday, counting only elapsed time for today", async () => {
    // Two days rather than one, because an impact opened just before midnight
    // and closed just after it touches both.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });
    await insertResults(target.id, every(300, DAY_START, DAY_END + 300));

    await recomputeRecentDays(env.DB, component.id, AFTER);

    const yesterday = await dailyRow(component.id, "2023-11-14");
    const today = await dailyRow(component.id, "2023-11-15");

    expect(yesterday).not.toBeNull();
    expect(yesterday!.uptime).toBe(1);
    // Fully covered, including the last interval of the day: the observation
    // three hundred seconds into the 15th brackets it.
    expect(yesterday!.covered_seconds).toBe(86_400);
    expect(yesterday!.unknown_seconds).toBe(0);

    // `now` is one minute into the 15th, so today's row is one minute wide —
    // and it is `unknown`, not `operational`. The last observation of the run
    // is at midnight, and coverage deliberately does not extend past the final
    // observation, so nothing brackets the new day yet. Reporting a healthy
    // minute here would be crediting time no probe has reported on.
    expect(today).not.toBeNull();
    expect(today!.covered_seconds).toBe(0);
    expect(today!.unknown_seconds).toBe(60);
    expect(today!.uptime).toBeNull();
  });
});

describe("applyRetention", () => {
  // Retention is inherently global: it rolls up and deletes across every
  // component. Clearing the raw observations first is what makes the counts
  // below exact rather than "at least".
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM probe_result").run();
  });

  it("rolls expired evidence up and preserves the retained boundary predecessor", async () => {
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BOUNDARY_START - 86_400 });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    const boundaryObservations = every(300, BOUNDARY_START, BOUNDARY_START + 86_400);
    await insertResults(target.id, boundaryObservations);

    // Older than the horizon, so these are the deletion candidates.
    const ancient = [BOUNDARY_START - 3600, BOUNDARY_START - 300];
    await insertResults(target.id, ancient);

    const summary = await applyRetention(env.DB, AFTER);

    expect(summary.cutoffDay).toBe(BOUNDARY_DAY);
    expect(summary.rollupFailures).toBe(0);
    expect(summary.skippedDeletionReason).toBeUndefined();
    // The predecessor within gapMax must survive for the retained day's first
    // covered second; older evidence was sealed before deletion.
    expect(summary.deleted).toBe(ancient.length - 1);
    const rolled = await dailyRow(component.id, "2023-10-15");
    expect(rolled).not.toBeNull();
    const boundary = await computeDailyUptime(env.DB, component.id, BOUNDARY_DAY, AFTER);
    expect(boundary!.coveredSeconds).toBe(86_100);
    expect(await resultCountFor(target.id, BOUNDARY_START)).toBe(boundaryObservations.length);
    expect(await resultCountFor(target.id)).toBe(boundaryObservations.length + 1);
  });

  it("deletes nothing when a rollup fails", async () => {
    // A growing table is recoverable; missing evidence is not. The delete is
    // gated on the rollup having succeeded for the boundary day.
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BOUNDARY_START - 86_400 });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    const ancient = [BOUNDARY_START - 3600, BOUNDARY_START - 300];
    await insertResults(target.id, ancient);

    const summary = await applyRetention(env.DB, AFTER, {
      computeDay: async () => {
        throw new Error("d1 unavailable");
      },
    });

    expect(summary.rollupFailures).toBeGreaterThan(0);
    expect(summary.skippedDeletionReason).toContain("raw results retained");
    expect(summary.deleted).toBe(0);
    expect(await resultCountFor(target.id)).toBe(ancient.length);
  });

  it("honours a custom horizon", async () => {
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: BEFORE_DAY - 60 * 86_400 });
    const target = await createProbeTarget(component.id, { intervalSeconds: 300 });

    // Two days before the boundary of a one-day horizon: inside a seven-day
    // window, outside a one-day one.
    const twoDaysBack = Date.parse("2023-11-14T00:00:00Z") / 1000 - 2 * 86_400;
    const observations = [twoDaysBack, twoDaysBack + 300];
    await insertResults(target.id, observations);

    const wide = await applyRetention(env.DB, AFTER, { retentionDays: 7 });
    expect(wide.deleted).toBe(0);

    const narrow = await applyRetention(env.DB, AFTER, { retentionDays: 1 });
    expect(narrow.deleted).toBe(observations.length);
  });
});
