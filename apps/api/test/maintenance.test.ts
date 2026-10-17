import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledMaintenance, FINALIZATION_GRACE_SECONDS } from "../src/lib/maintenance";
import { applyRetention } from "../src/lib/retention";
import { computeDailyUptime, computeDailyUptimeBatch, persistDailyUptime } from "../src/lib/uptime-recompute";
import { testEnv as env } from "./env";
import { createComponent, createPage, createProbeTarget } from "./helpers";

const DAY = 86_400;
const MIDNIGHT = Date.parse("2024-03-10T00:00:00Z") / 1000;
const NOW = MIDNIGHT + 3600;
let counter = 0;

function tracedDb(fail?: (sql: string) => boolean): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (query: string) => {
        sql.push(query);
        if (fail?.(query)) throw new Error("injected rollup failure");
        return target.prepare(query);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, sql };
}

async function seed() {
  const page = await createPage();
  const component = await createComponent(page.id, { availableSince: MIDNIGHT - 60 * DAY });
  const target = await createProbeTarget(component.id);
  return { component, target };
}

async function observe(targetId: number, at: number): Promise<string> {
  const id = `maintenance-result-${++counter}`;
  await env.DB.prepare(
    `INSERT INTO probe_result(public_id, probe_target_id, observed_at, ok, created_at)
       VALUES(?1, ?2, ?3, 1, ?3)`,
  ).bind(id, targetId, at).run();
  return id;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM page").run();
  await env.DB.prepare(
    `UPDATE maintenance_job SET next_run_at = 0, lease_until = 0,
       claim_token = NULL, completed_day = NULL, cursor_day = NULL, failures = 0, last_error = NULL`,
  ).run();
});

describe("persisted scheduled maintenance", () => {
  it("refreshes today at 300 elapsed seconds, not a modulo minute", async () => {
    await seed();
    const first = await runScheduledMaintenance(env.DB, NOW + 17);
    expect(first.errors).toEqual([]);
    expect(first.historyComputedAt).toBe(NOW + 17);
    // Keep other jobs out of this cadence test.
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at = ?1 WHERE job <> 'today'").bind(NOW + DAY).run();
    expect((await runScheduledMaintenance(env.DB, NOW + 316)).historyChanged).toBe(false);
    expect((await runScheduledMaintenance(env.DB, NOW + 317)).historyChanged).toBe(true);
    // A missed exact slot is still due on the next invocation.
    expect((await runScheduledMaintenance(env.DB, NOW + 1000)).historyChanged).toBe(true);
  });

  it("finalizes yesterday once after grace and does not scan retention again that UTC day", async () => {
    await seed();
    const trace = tracedDb();
    await runScheduledMaintenance(trace.db, MIDNIGHT + 60); // today
    await runScheduledMaintenance(trace.db, MIDNIGHT + 120); // pin finalization candidate before grace
    await runScheduledMaintenance(trace.db, MIDNIGHT + 180); // no expired retention
    const beforeGrace = await env.DB.prepare("SELECT completed_day FROM maintenance_job WHERE job = 'finalize'").first<{completed_day: string | null}>();
    expect(beforeGrace!.completed_day).toBeNull();
    await runScheduledMaintenance(trace.db, MIDNIGHT + FINALIZATION_GRACE_SECONDS); // today is due
    await runScheduledMaintenance(trace.db, MIDNIGHT + FINALIZATION_GRACE_SECONDS + 60); // finalize
    const finalized = await env.DB.prepare("SELECT completed_day FROM maintenance_job WHERE job = 'finalize'").first<{completed_day: string}>();
    expect(finalized!.completed_day).toBe("2024-03-09");
    const readsBefore = trace.sql.filter((s) => s.includes("MIN(first_at)")).length;
    for (let tick = 15; tick < 30; tick++) await runScheduledMaintenance(trace.db, MIDNIGHT + tick * 60);
    expect(trace.sql.filter((s) => s.includes("MIN(first_at)")).length).toBe(readsBefore);
    const yesterdayWrites = trace.sql.filter((s) => s.includes("INSERT INTO daily_uptime")).length;
    expect(yesterdayWrites).toBeLessThan(10);
    const row = await env.DB.prepare("SELECT computed_at FROM daily_uptime WHERE day = '2024-03-09'").first<{computed_at: number}>();
    expect(row!.computed_at).toBe(MIDNIGHT + FINALIZATION_GRACE_SECONDS + 60);
  });

  it("anchors a daily-interval finalization candidate until its eventual grace", async () => {
    const { component, target } = await seed();
    await env.DB.prepare("UPDATE probe_target SET interval_seconds=?2 WHERE id=?1").bind(target.id, DAY).run();
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at=?1 WHERE job <> 'finalize'").bind(MIDNIGHT + 10 * DAY).run();
    await observe(target.id, MIDNIGHT - DAY / 2);
    await observe(target.id, MIDNIGHT + DAY + DAY / 2);
    const trace = tracedDb();
    expect((await runScheduledMaintenance(trace.db, MIDNIGHT + 60)).rolledUp).toBe(0);
    expect(trace.sql).toHaveLength(2); // claim pins candidate; completion defers it
    expect(await env.DB.prepare("SELECT cursor_day, next_run_at FROM maintenance_job WHERE job='finalize'").first())
      .toEqual({ cursor_day: "2024-03-09", next_run_at: MIDNIGHT + 2 * DAY });
    expect((await runScheduledMaintenance(env.DB, MIDNIGHT + DAY + 600)).rolledUp).toBe(0);
    expect((await runScheduledMaintenance(env.DB, MIDNIGHT + 2 * DAY - 1)).rolledUp).toBe(0);
    trace.sql.length = 0;
    const finalized = await runScheduledMaintenance(trace.db, MIDNIGHT + 2 * DAY);
    expect(finalized.errors).toEqual([]);
    expect(finalized.rolledUp).toBe(1);
    expect(trace.sql).toHaveLength(7); // same routine statement budget
    expect(await env.DB.prepare("SELECT covered_seconds, computed_at FROM daily_uptime WHERE component_id=?1 AND day='2024-03-09'").bind(component.id).first())
      .toEqual({ covered_seconds: DAY / 2, computed_at: MIDNIGHT + 2 * DAY });
    expect(await env.DB.prepare("SELECT completed_day, cursor_day FROM maintenance_job WHERE job='finalize'").first())
      .toEqual({ completed_day: "2024-03-09", cursor_day: "2024-03-10" });
  });

  it("catches up two missed finalization days one per tick using actual observations", async () => {
    const { component, target } = await seed();
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at=?1 WHERE job <> 'finalize'").bind(NOW + DAY).run();
    await env.DB.prepare("UPDATE maintenance_job SET completed_day='2024-03-07' WHERE job='finalize'").run();
    for (const midnight of [MIDNIGHT - DAY, MIDNIGHT]) {
      await observe(target.id, midnight - 30);
      await observe(target.id, midnight + 30);
    }
    // The successor is too distant, not evidence that the earlier gap is covered.
    await observe(target.id, MIDNIGHT - DAY + 151);
    const first = await runScheduledMaintenance(env.DB, NOW);
    expect(first.errors).toEqual([]);
    expect(first.rolledUp).toBe(1);
    expect(await env.DB.prepare("SELECT day, covered_seconds FROM daily_uptime WHERE component_id=?1 ORDER BY day").bind(component.id).all())
      .toMatchObject({ results: [{ day: "2024-03-08", covered_seconds: 30 }] });
    expect((await runScheduledMaintenance(env.DB, NOW + 59)).rolledUp).toBe(0);
    const second = await runScheduledMaintenance(env.DB, NOW + 60);
    expect(second.errors).toEqual([]);
    expect(second.rolledUp).toBe(1);
    expect(await env.DB.prepare("SELECT day, covered_seconds FROM daily_uptime WHERE component_id=?1 ORDER BY day").bind(component.id).all())
      .toMatchObject({ results: [
        { day: "2024-03-08", covered_seconds: 30 },
        { day: "2024-03-09", covered_seconds: 60 },
      ] });
    expect(await env.DB.prepare("SELECT completed_day FROM maintenance_job WHERE job='finalize'").first())
      .toEqual({ completed_day: "2024-03-09" });
  });

  it("persists bounded retry and recovers a missed execution", async () => {
    await seed();
    const broken = tracedDb((sql) => sql.includes("SELECT c.id, c.available_since"));
    const failed = await runScheduledMaintenance(broken.db, NOW);
    expect(failed.errors[0]).toContain("injected rollup failure");
    const job = await env.DB.prepare("SELECT failures, next_run_at, lease_until FROM maintenance_job WHERE job='today'")
      .first<{failures: number; next_run_at: number; lease_until: number}>();
    expect(job).toEqual({ failures: 1, next_run_at: NOW + 60, lease_until: 0 });
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at = ?1 WHERE job <> 'today'").bind(NOW + DAY).run();
    expect((await runScheduledMaintenance(env.DB, NOW + 59)).historyChanged).toBe(false);
    expect((await runScheduledMaintenance(env.DB, NOW + 67)).historyChanged).toBe(true);
  });

  it("claims concurrent jobs once and recovers an abandoned lease", async () => {
    await seed();
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at = ?1 WHERE job <> 'today'").bind(NOW + DAY).run();
    const results = await Promise.all([runScheduledMaintenance(env.DB, NOW), runScheduledMaintenance(env.DB, NOW)]);
    expect(results.filter((r) => r.historyChanged)).toHaveLength(1);
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at=0, lease_until=?1, claim_token='abandoned' WHERE job='today'").bind(NOW + 120).run();
    expect((await runScheduledMaintenance(env.DB, NOW + 119)).historyChanged).toBe(false);
    expect((await runScheduledMaintenance(env.DB, NOW + 121)).historyChanged).toBe(true);
  });

  it("bounds bulk evidence reads by the requested day with 1440 observations per target", async () => {
    const fixtures = [await seed(), await seed()];
    for (const { target } of fixtures) {
      const observations = Array.from({ length: 1440 }, (_, index) => ({
        id: `maintenance-capacity-${target.id}-${index}`, at: MIDNIGHT - DAY + index * 60,
      }));
      await env.DB.prepare(
        `INSERT INTO probe_result(public_id, probe_target_id, observed_at, ok, created_at)
         SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.at'), 1, json_extract(value, '$.at')
         FROM json_each(?2)`,
      ).bind(target.id, JSON.stringify(observations)).run();
    }
    const reads: number[] = [];
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          reads.push(...results.map((result) => result.meta.rows_read));
          return results;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Only the midnight predecessor window is relevant, not yesterday's 2880 rows.
    const rows = await computeDailyUptimeBatch(db, null, MIDNIGHT + 60, ["2024-03-10"]);
    expect(rows).toHaveLength(2);
    console.log("maintenance bulk 1440/target D1 rows_read (impact, maintenance, results)", reads);
    expect(reads).toHaveLength(3);
    expect(reads[2]).toBeLessThan(50);
  });

  it("bulk recomputes only urgent components and defers background work", async () => {
    const a = await seed();
    const b = await seed();
    const trace = tracedDb();
    const summary = await runScheduledMaintenance(trace.db, NOW, [a.component.id, a.component.id]);
    expect(summary.errors).toEqual([]);
    expect(summary.rolledUp).toBe(2);
    expect(trace.sql).toHaveLength(5);
    const untouched = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_uptime WHERE component_id=?1").bind(b.component.id).first<{n:number}>();
    expect(untouched!.n).toBe(0);
  });
});

describe("bounded retention catch-up", () => {
  it("seals every missed evidence day, preserves the predecessor and accepted observation, and never recomputes sealed days", async () => {
    const { component, target } = await seed();
    const cutoff = MIDNIGHT - 30 * DAY;
    const accepted = await observe(target.id, cutoff - 4 * DAY + 10);
    await env.DB.prepare("UPDATE probe_state SET last_result_id=?2 WHERE probe_target_id=?1").bind(target.id, accepted).run();
    for (const offset of [3, 2, 1]) {
      await observe(target.id, cutoff - offset * DAY + 60);
      await observe(target.id, cutoff - offset * DAY + 120);
    }
    const predecessor = await observe(target.id, cutoff - 60);
    await observe(target.id, cutoff + 60);
    let chunks = 0;
    for (; chunks < 8; chunks++) {
      const result = await applyRetention(env.DB, NOW, { maxDays: 1 });
      expect(result.rollupFailures).toBe(0);
      if (result.complete) break;
      expect(result.rolledUp).toBe(1);
    }
    expect(chunks).toBe(4);
    const rows = await env.DB.prepare("SELECT day FROM daily_uptime WHERE component_id=?1 AND archived=1 ORDER BY day").bind(component.id).all();
    expect(rows.results).toHaveLength(4);
    const raw = await env.DB.prepare("SELECT public_id FROM probe_result WHERE probe_target_id=?1 ORDER BY observed_at").bind(target.id).all<{public_id:string}>();
    expect(raw.results.map((r) => r.public_id)).toContain(accepted);
    expect(raw.results.map((r) => r.public_id)).toContain(predecessor);
    expect(raw.results).toHaveLength(3);
    expect(await computeDailyUptime(env.DB, component.id, "2024-02-08", NOW)).toBeNull();
    const before = await env.DB.prepare("SELECT SUM(covered_seconds) AS n FROM daily_uptime WHERE component_id=?1").bind(component.id).first();
    await persistDailyUptime(env.DB, { componentId: component.id, day: "2024-02-08", coveredSeconds: 0, unknownSeconds: DAY, downtimeWeighted: 0, uptime: null, worstStatus: "unknown" }, NOW + 60);
    expect(await env.DB.prepare("SELECT SUM(covered_seconds) AS n FROM daily_uptime WHERE component_id=?1").bind(component.id).first()).toEqual(before);
    expect((await applyRetention(env.DB, NOW + 60)).rolledUp).toBe(0);
  });

  it("archives a sample-free day covered by neighbours before deleting either anchor", async () => {
    const { component, target } = await seed();
    const cutoff = MIDNIGHT - 30 * DAY;
    const firstDay = cutoff - 3 * DAY;
    await env.DB.prepare("UPDATE component SET available_since=?2 WHERE id=?1").bind(component.id, firstDay - 3650 * DAY).run();
    await env.DB.prepare("UPDATE probe_target SET interval_seconds=?2 WHERE id=?1").bind(target.id, DAY).run();
    const left = await observe(target.id, firstDay + DAY / 2);
    await observe(target.id, firstDay + 2 * DAY + DAY / 2);
    const expected = await computeDailyUptime(env.DB, component.id, "2024-02-07", NOW);
    expect(expected!.coveredSeconds).toBe(DAY);
    const trace = tracedDb();
    const first = await applyRetention(trace.db, NOW, { maxDays: 1 });
    expect(first.rollupFailures).toBe(0);
    expect(first.rolledUp).toBe(1);
    expect(trace.sql).toHaveLength(7); // candidate + four reads + atomic seal/purge
    expect(await env.DB.prepare("SELECT public_id FROM probe_result WHERE public_id=?1").bind(left).first()).not.toBeNull();
    const second = await applyRetention(env.DB, NOW, { maxDays: 1 });
    expect(second.rollupFailures).toBe(0);
    expect(second.rolledUp).toBe(1);
    expect(await env.DB.prepare("SELECT day, covered_seconds, archived FROM daily_uptime WHERE component_id=?1 ORDER BY day").bind(component.id).all())
      .toMatchObject({ results: [
        { day: "2024-02-06", covered_seconds: DAY / 2, archived: 1 },
        { day: "2024-02-07", covered_seconds: DAY, archived: 1 },
      ] });
    expect((await applyRetention(env.DB, NOW, { maxDays: 1 })).rolledUp).toBe(1);
    expect((await applyRetention(env.DB, NOW, { maxDays: 1 })).complete).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_uptime WHERE component_id=?1").bind(component.id).first()).toEqual({ n: 3 });
  });

  it("preserves disabled-target anchors using the component's enabled coverage gap", async () => {
    const { component, target } = await seed();
    const cutoff = MIDNIGHT - 30 * DAY;
    const firstDay = cutoff - 2 * DAY;
    await env.DB.prepare("UPDATE probe_target SET enabled=0 WHERE id=?1").bind(target.id).run();
    await createProbeTarget(component.id, { intervalSeconds: DAY });
    const predecessor = await observe(target.id, firstDay + DAY / 2);
    const accepted = await observe(target.id, firstDay + DAY + DAY / 2);
    await env.DB.prepare("UPDATE probe_state SET last_result_id=?2 WHERE probe_target_id=?1").bind(target.id, accepted).run();
    const before = await computeDailyUptime(env.DB, component.id, "2024-02-08", NOW);
    expect(before!.coveredSeconds).toBe(DAY / 2);

    const trace = tracedDb();
    const first = await applyRetention(trace.db, NOW, { maxDays: 1 });
    expect(first.rollupFailures).toBe(0);
    expect(first.rolledUp).toBe(1);
    expect(trace.sql).toHaveLength(7);
    expect(await env.DB.prepare("SELECT public_id FROM probe_result WHERE public_id=?1").bind(predecessor).first())
      .toEqual({ public_id: predecessor });
    expect(await computeDailyUptime(env.DB, component.id, "2024-02-08", NOW)).toEqual(before);

    const second = await applyRetention(env.DB, NOW, { maxDays: 1 });
    expect(second.rollupFailures).toBe(0);
    expect(second.rolledUp).toBe(1);
    expect(await env.DB.prepare("SELECT day, covered_seconds, archived FROM daily_uptime WHERE component_id=?1 ORDER BY day").bind(component.id).all())
      .toMatchObject({ results: [
        { day: "2024-02-07", covered_seconds: DAY / 2, archived: 1 },
        { day: "2024-02-08", covered_seconds: DAY / 2, archived: 1 },
      ] });
    expect(await env.DB.prepare("SELECT public_id FROM probe_result WHERE public_id=?1").bind(accepted).first())
      .toEqual({ public_id: accepted });
  });

  it("seeds manual-only evidence and keeps empty intervening days continuous", async () => {
    const page = await createPage();
    const cutoff = MIDNIGHT - 30 * DAY;
    const component = await createComponent(page.id, { availableSince: cutoff - 3650 * DAY });
    await env.DB.prepare(
      `INSERT INTO impact(public_id, component_id, severity, start_at, end_at, created_at, updated_at)
       VALUES ('manual-retention-seed', ?1, 'full_outage', ?2, ?3, ?2, ?2)`,
    ).bind(component.id, cutoff - 3 * DAY + 60, cutoff - 3 * DAY + 120).run();
    const result = await applyRetention(env.DB, NOW);
    expect(result.rollupFailures).toBe(0);
    expect(result.rolledUp).toBe(3);
    expect(result.complete).toBe(true);
    expect(await env.DB.prepare("SELECT covered_seconds, downtime_weighted, archived FROM daily_uptime WHERE component_id=?1 ORDER BY day").bind(component.id).all())
      .toMatchObject({ results: [
        { covered_seconds: 60, downtime_weighted: 60, archived: 1 },
        { covered_seconds: 0, downtime_weighted: 0, archived: 1 },
        { covered_seconds: 0, downtime_weighted: 0, archived: 1 },
      ] });
  });

  it("does not seed old availability without actual evidence", async () => {
    const page = await createPage();
    const component = await createComponent(page.id, { availableSince: MIDNIGHT - 3650 * DAY });
    const target = await createProbeTarget(component.id);
    await observe(target.id, MIDNIGHT - DAY); // entirely inside retained horizon
    const result = await applyRetention(env.DB, NOW);
    expect(result.rolledUp).toBe(0);
    expect(result.complete).toBe(true);
  });

  it("rolls back the materialization and seal if the atomic purge fails", async () => {
    const { component, target } = await seed();
    const cutoff = MIDNIGHT - 30 * DAY;
    await observe(target.id, cutoff - DAY + 60);
    await observe(target.id, cutoff - DAY + 120);
    await env.DB.prepare(`CREATE TRIGGER retention_test_failure BEFORE DELETE ON probe_result
      BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END`).run();
    try {
      const result = await applyRetention(env.DB, NOW, { maxDays: 1 });
      expect(result.rollupFailures).toBe(1);
      expect(result.deleted).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_uptime WHERE component_id=?1").bind(component.id).first()).toEqual({ n: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM probe_result WHERE probe_target_id=?1").bind(target.id).first()).toEqual({ n: 2 });
    } finally {
      await env.DB.prepare("DROP TRIGGER retention_test_failure").run();
    }
    expect((await applyRetention(env.DB, NOW, { maxDays: 1 })).rolledUp).toBe(1);
  });

  it("a failed rollup protects all its evidence, then retry catches up", async () => {
    const { target } = await seed();
    const cutoff = MIDNIGHT - 30 * DAY;
    await observe(target.id, cutoff - DAY + 60);
    await observe(target.id, cutoff - DAY + 120);
    const failed = await applyRetention(env.DB, NOW, { maxDays: 1, computeDay: async () => { throw new Error("fail"); } });
    expect(failed.deleted).toBe(0);
    expect(failed.rollupFailures).toBe(1);
    expect((await applyRetention(env.DB, NOW, { maxDays: 1 })).rolledUp).toBe(1);
  });
});

it("uses an actual post-midnight successor but rejects future or too-distant evidence", async () => {
  const { component, target } = await seed();
  await observe(target.id, MIDNIGHT - 30);
  await observe(target.id, MIDNIGHT + 30);
  const before = await computeDailyUptime(env.DB, component.id, "2024-03-09", MIDNIGHT + 29);
  expect(before!.coveredSeconds).toBe(0);
  const after = await computeDailyUptime(env.DB, component.id, "2024-03-09", MIDNIGHT + 30);
  expect(after!.coveredSeconds).toBe(30);
  await env.DB.prepare("DELETE FROM probe_result WHERE observed_at > ?1").bind(MIDNIGHT).run();
  await observe(target.id, MIDNIGHT + 121);
  expect((await computeDailyUptime(env.DB, component.id, "2024-03-09", NOW))!.coveredSeconds).toBe(0);
});
