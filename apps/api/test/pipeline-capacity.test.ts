import { deriveSnapshotComponent, startOfUtcDay, utcDay, type ReadResult, type Snapshot } from "@allclear/shared";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { computeDailyUptime, persistDailyUptime } from "../src/lib/uptime-recompute";
import { applyProbeObservation } from "../src/probe/transition";
import { refreshLiveSummary } from "../src/publication";
import { testEnv as env } from "./env";
import { createComponent, createPage, createProbeTarget, DAY, workerEnv } from "./helpers";

interface Usage {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  gets: number;
  puts: number;
  errors: string[];
  queries: Record<string, { calls: number; rowsRead: number; rowsWritten: number }>;
}

function usage(): Usage {
  return { statements: 0, rowsRead: 0, rowsWritten: 0, gets: 0, puts: 0, errors: [], queries: {} };
}

function meteredDatabase(db: D1Database, counters: Usage): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
  function record(result: D1Result<unknown>, sql: string): void {
    counters.rowsRead += result.meta.rows_read ?? 0;
    counters.rowsWritten += result.meta.rows_written ?? 0;
    const item = counters.queries[sql] ??= { calls: 0, rowsRead: 0, rowsWritten: 0 };
    item.calls += 1;
    item.rowsRead += result.meta.rows_read ?? 0;
    item.rowsWritten += result.meta.rows_written ?? 0;
  }
  function statement(original: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(original, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => statement(target.bind(...values), sql);
        }
        if (property === "first") {
          return async (column?: string) => {
            counters.statements += 1;
            const result = await target.all<Record<string, unknown>>();
            record(result, sql);
            const row = result.results[0];
            if (row === undefined) return null;
            return column === undefined ? row : row[column];
          };
        }
        if (property === "all" || property === "run") {
          return async () => {
            counters.statements += 1;
            const result = await target[property]();
            record(result, sql);
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, original);
    sqlByStatement.set(wrapped, sql);
    return wrapped;
  }
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          counters.statements += statements.length;
          const results = await target.batch(statements.map((item) => originals.get(item) ?? item));
          results.forEach((result, index) => record(result, sqlByStatement.get(statements[index]!) ?? "batch"));
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function meteredKv(kv: KVNamespace, counters: Usage): KVNamespace {
  return new Proxy(kv, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "get" || property === "getWithMetadata") counters.gets += 1;
        if (property === "put") counters.puts += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM page").run();
  await env.DB.prepare("DELETE FROM snapshot_publish_budget").run();
  await env.DB.prepare("UPDATE maintenance_job SET next_run_at=0,lease_until=0,claim_token=NULL,completed_day=NULL,cursor_day=NULL,failures=0,last_error=NULL").run();
});
afterEach(() => vi.restoreAllMocks());

describe("pipeline capacity", () => {
  it("preserves minute sampling and ninety-day history within a measured one-page daily storage budget", async () => {
    const start = Math.floor(Date.parse("2026-01-12T00:05:20Z") / 1000);
    const page = await createPage("Capacity acceptance");
    const targetIds: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const component = await createComponent(page.id, { availableSince: start - 100 * DAY });
      const target = await createProbeTarget(component.id);
      targetIds.push(target.id);
      await env.DB.prepare(
        `INSERT INTO probe_result
           (public_id, probe_target_id, observed_at, ok, status_code, latency_ms, error, created_at)
         WITH RECURSIVE samples(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM samples WHERE n < 1440
         )
         SELECT ?1 || '-' || n, ?2, ?3 - n * 60, 1, 200, 1, NULL, ?3 - n * 60
           FROM samples`,
      ).bind(`capacity-${target.id}`, target.id, start).run();
      await env.DB.prepare("UPDATE component SET rollup_dirty=0,rollup_dirty_from=NULL WHERE id=?1")
        .bind(component.id).run();
      await env.DB.prepare(
        `INSERT INTO daily_uptime
           (component_id, day, covered_seconds, unknown_seconds, downtime_weighted,
            uptime, worst_status, computed_at, archived, rollup_revision)
         WITH RECURSIVE days(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM days WHERE n < 90
         )
         SELECT c.id, date(?2 - n * 86400, 'unixepoch'), 86400, 0, 0,
                1, 'operational', ?2 - n * 86400, CASE WHEN n > 30 THEN 1 ELSE 0 END,
                c.rollup_revision
           FROM days CROSS JOIN component c WHERE c.id=?1`,
      ).bind(component.id, start).run();
    }

    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const counters = usage();
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      counters.errors.push(args.map(String).join(" "));
    });
    const bindings = {
      ...workerEnv,
      DB: meteredDatabase(env.DB, counters),
      SNAPSHOT_KV: meteredKv(env.SNAPSHOT_KV, counters),
    };
    const perTick: number[] = [];
    for (let tick = 0; tick < 1440; tick += 1) {
      now = start + tick * 60;
      const before = counters.statements;
      await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
      perTick.push(counters.statements - before);
      expect(counters.errors, `scheduled errors at tick ${tick}`).toEqual([]);
      if (tick === 0 || (tick + 1) % 360 === 0) {
        console.info("daily capacity progress", { ticks: tick + 1, rowsRead: counters.rowsRead, rowsWritten: counters.rowsWritten, puts: counters.puts,
          hotspots: Object.entries(counters.queries).sort((a, b) => b[1].rowsRead - a[1].rowsRead).slice(0, 3).map(([sql, count]) => ({ sql: sql.slice(0, 100), ...count })) });
      }
    }

    const counts = await env.DB.prepare(
      `SELECT probe_target_id, COUNT(*) AS n, MAX(observed_at) AS last_at
         FROM probe_result WHERE observed_at >= ?1
         GROUP BY probe_target_id ORDER BY probe_target_id`,
    ).bind(start).all<{ probe_target_id: number; n: number; last_at: number }>();
    expect(counts.results).toHaveLength(5);
    expect(counts.results.every((row) => targetIds.includes(row.probe_target_id) && row.n === 1440)).toBe(true);
    expect(counts.results.every((row) => row.last_at === now)).toBe(true);
    const materialized = await env.DB.prepare(
      `SELECT d.component_id,d.day,d.covered_seconds,d.unknown_seconds,d.downtime_weighted,
              d.uptime,d.worst_status,d.computed_at
         FROM daily_uptime d JOIN component c ON c.id=d.component_id
        WHERE c.page_id=?1 AND d.day=date(?2,'unixepoch')`,
    ).bind(page.id, now).all<{
      component_id: number; day: string; covered_seconds: number; unknown_seconds: number;
      downtime_weighted: number; uptime: number | null; worst_status: string; computed_at: number;
    }>();
    expect(materialized.results).toHaveLength(5);
    for (const row of materialized.results) {
      const exact = await computeDailyUptime(env.DB, row.component_id, row.day, row.computed_at);
      expect(exact).not.toBeNull();
      expect(row.covered_seconds).toBe(exact!.coveredSeconds);
      expect(row.unknown_seconds).toBe(exact!.unknownSeconds);
      expect(row.downtime_weighted).toBeCloseTo(exact!.downtimeWeighted, 10);
      expect(row.uptime).toBe(exact!.uptime);
      expect(row.worst_status).toBe(exact!.worstStatus);
    }
    expect(counters.errors).toEqual([]);
    expect(counters.puts).toBeLessThanOrEqual(292);
    expect(counters.gets).toBe(0);
    expect(counters.rowsRead).toBeLessThan(500_000);
    expect(counters.rowsWritten).toBeLessThan(80_000);
    const historyQuery = Object.entries(counters.queries).find(([sql]) => sql.includes("FROM daily_uptime d JOIN component c ON c.id=d.component_id"));
    if (historyQuery) expect(historyQuery[1].rowsRead).toBeLessThan(15_000);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(50);
    log.mockRestore();
    console.log("pipeline capacity evidence", {
      ticks: perTick.length,
      maxStatementsPerTick: Math.max(...perTick),
      ...counters,
      queries: Object.entries(counters.queries).sort((a, b) => b[1].rowsRead - a[1].rowsRead).slice(0, 5).map(([sql, count]) => ({ sql: sql.slice(0, 100), ...count })),
    });
  }, 600_000);

  it("keeps disabled targets and retained history within a measured cron-only daily idle budget", async () => {
    const start = Date.parse("2026-03-10T00:05:20Z") / 1000;
    const page = await createPage("Disabled capacity acceptance");
    const components: { id: number; publicId: string }[] = [];
    for (let index = 0; index < 5; index += 1) {
      const component = await createComponent(page.id, { availableSince: start - 100 * DAY });
      components.push(component);
      const target = await createProbeTarget(component.id, { enabled: false });
      // Historical import is outside the measured cron workload, as in the
      // enabled fixture. Preserve a real last-accepted row, not just a timestamp.
      await env.DB.prepare(`INSERT INTO probe_result
        (public_id,probe_target_id,observed_at,ok,status_code,latency_ms,created_at)
        WITH RECURSIVE samples(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM samples WHERE n<1440)
        SELECT ?1||'-'||n,?2,?3-n*60,1,200,1,?3-n*60 FROM samples`)
        .bind(`disabled-${target.id}`, target.id, start).run();
      await env.DB.prepare(`UPDATE probe_state SET last_result_id=?2,last_probe_at=?3,
        consecutive_successes=1440,transition_seq=1440,updated_at=?3 WHERE probe_target_id=?1`)
        .bind(target.id, `disabled-${target.id}-1`, start - 60).run();
      await env.DB.prepare("UPDATE component SET rollup_dirty=0,rollup_dirty_from=NULL WHERE id=?1")
        .bind(component.id).run();
      await env.DB.prepare(`INSERT INTO daily_uptime
        (component_id,day,covered_seconds,unknown_seconds,downtime_weighted,uptime,
         worst_status,computed_at,archived,rollup_revision)
        WITH RECURSIVE days(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM days WHERE n<90)
        SELECT c.id,date(?2-n*86400,'unixepoch'),86400,0,0,1,'operational',?2-n*86400,
          CASE WHEN n>30 THEN 1 ELSE 0 END,c.rollup_revision
        FROM days CROSS JOIN component c WHERE c.id=?1`).bind(component.id, start).run();
    }
    const accepted = (await env.DB.prepare("SELECT * FROM probe_state ORDER BY probe_target_id").all()).results;
    const raw = (await env.DB.prepare(`SELECT probe_target_id,COUNT(*) AS n,MAX(observed_at) AS last_at
      FROM probe_result GROUP BY probe_target_id ORDER BY probe_target_id`).all()).results;
    const targets = (await env.DB.prepare("SELECT * FROM probe_target ORDER BY id").all()).results;
    // Capture the exact old-day oracle before midnight retention seals it. The
    // full-day reader correctly refuses to recompute an already archived day.
    const archiveOracles = new Map<number, Awaited<ReturnType<typeof computeDailyUptime>>>();
    for (const component of components) archiveOracles.set(component.id,
      await computeDailyUptime(env.DB, component.id, utcDay(start - 30 * DAY), start));
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("a disabled target must never be probed");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));

    async function verifyHistory(): Promise<void> {
      const stored = await env.DB.prepare("SELECT body,history_valid_until FROM snapshot_summary WHERE page_id=?1")
        .bind(page.id).first<{ body: string; history_valid_until: number }>();
      expect(stored).not.toBeNull();
      expect(stored!.history_valid_until).toBe(startOfUtcDay(now) + DAY);
      const snapshot = JSON.parse(stored!.body) as Snapshot;
      const days = await env.DB.prepare(`SELECT component_id,day,uptime,worst_status,
        covered_seconds,unknown_seconds,computed_at,archived FROM daily_uptime
        WHERE day>=?1 ORDER BY day`).bind(utcDay(now - 89 * DAY)).all<{
        component_id: number; day: string; uptime: number | null; worst_status: string;
        covered_seconds: number; unknown_seconds: number; computed_at: number; archived: number;
      }>();
      expect(snapshot.components).toHaveLength(5);
      expect(snapshot.historyComputedAt).toBe(Math.max(...days.results.map((row) => row.computed_at)));
      for (const component of components) {
        const publicComponent = snapshot.components.find((row) => row.publicId === component.publicId)!;
        expect(publicComponent.probe).toBeNull();
        expect(deriveSnapshotComponent(publicComponent, now).status).toBe("unknown");
        expect(publicComponent.days).toEqual(days.results.filter((row) => row.component_id === component.id)
          .map((row) => ({ day: row.day, uptime: row.uptime, status: row.worst_status,
            coveredSeconds: row.covered_seconds, unknownSeconds: row.unknown_seconds })));
        // Check the actual materialization times, not an oracle evaluated later.
        for (const row of days.results.filter((row) => row.component_id === component.id && row.computed_at >= start)) {
          const exact = row.archived ? archiveOracles.get(component.id)
            : await computeDailyUptime(env.DB, component.id, row.day, row.computed_at);
          expect(exact).not.toBeNull();
          expect(row.covered_seconds).toBe(exact!.coveredSeconds);
          expect(row.unknown_seconds).toBe(exact!.unknownSeconds);
          expect(row.uptime).toBe(exact!.uptime);
          expect(row.worst_status).toBe(exact!.worstStatus);
        }
      }
      expect((await env.DB.prepare("SELECT * FROM probe_state ORDER BY probe_target_id").all()).results).toEqual(accepted);
      expect((await env.DB.prepare("SELECT * FROM probe_target ORDER BY id").all()).results).toEqual(targets);
      expect((await env.DB.prepare(`SELECT probe_target_id,COUNT(*) AS n,MAX(observed_at) AS last_at
        FROM probe_result GROUP BY probe_target_id ORDER BY probe_target_id`).all()).results).toEqual(raw);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshot_history_dirty").first()).toEqual({ n: 0 });
      expect(errors).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }

    async function measure(ticks: number, from: number) {
      const counters = usage();
      const bindings = { ...workerEnv, DB: meteredDatabase(env.DB, counters),
        SNAPSHOT_KV: meteredKv(env.SNAPSHOT_KV, counters) };
      const perTick: number[] = [];
      for (let tick = 0; tick < ticks; tick += 1) {
        now = from + tick * 60;
        const before = counters.statements;
        await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
        perTick.push(counters.statements - before);
        expect(errors, `disabled scheduled errors at tick ${tick}`).toEqual([]);
      }
      return { ticks, maxStatementsPerTick: Math.max(...perTick), ...counters,
        queries: Object.entries(counters.queries).sort((a, b) => b[1].rowsRead - a[1].rowsRead)
          .slice(0, 10).map(([sql, count]) => ({ sql: sql.slice(0, 180), ...count })) };
    }
    // No summaries/fragments or completed job cursors exist at cold start. Its
    // ten-minute work is reported separately, never projected into a daily rate.
    const cold = await measure(10, start);
    await verifyHistory();
    const steady = await measure(1440, start + 600);
    await verifyHistory();
    console.info("disabled pipeline capacity evidence", JSON.stringify({ cold, steady }));
    expect(utcDay(now)).toBe("2026-03-11");
    expect(steady.rowsRead).toBeLessThanOrEqual(100_000);
    expect(steady.rowsWritten).toBeLessThanOrEqual(20_000);
    expect(steady.gets).toBe(0);
    expect(steady.puts).toBeLessThanOrEqual(292);
    expect(steady.maxStatementsPerTick).toBeLessThanOrEqual(50);
  }, 600_000);

  it("drains actual disable revision repairs separately from the steady idle budget", async () => {
    const start = Date.parse("2026-03-12T12:05:20Z") / 1000;
    const page = await createPage("Disable repair backlog acceptance");
    const components: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const component = await createComponent(page.id, { availableSince: start - 100 * DAY });
      components.push(component.id);
      const target = await createProbeTarget(component.id, { intervalSeconds: DAY });
      // The disabled 60s fallback gap must invalidate historical coverage that
      // was valid with the former daily interval, not just rewrite its revision.
      for (const [n, at] of [start - 2 * DAY, start - DAY, start - 60].entries()) {
        expect((await applyProbeObservation(env.DB, { targetId: target.id, observedAt: at,
          ok: true, resultId: `disable-repair-${target.id}-${n}` })).kind).toBe("applied");
      }
      for (let offset = 30; offset >= 1; offset -= 1) {
        const exact = await computeDailyUptime(env.DB, component.id, utcDay(start - offset * DAY), start);
        await persistDailyUptime(env.DB, exact!, start);
      }
      await env.DB.prepare("UPDATE component SET rollup_dirty=0,rollup_dirty_from=NULL WHERE id=?1")
        .bind(component.id).run();
    }
    await refreshLiveSummary(env.DB, page.slug, start);
    const revisions = (await env.DB.prepare("SELECT rollup_revision FROM component ORDER BY id").all<{ rollup_revision: number }>()).results;
    const raw = (await env.DB.prepare("SELECT * FROM probe_result ORDER BY id").all()).results;
    const accepted = (await env.DB.prepare("SELECT * FROM probe_state ORDER BY probe_target_id").all()).results;
    const previouslyCovered = await env.DB.prepare("SELECT SUM(covered_seconds) AS n FROM daily_uptime").first<{ n: number }>();
    expect(previouslyCovered!.n).toBeGreaterThan(0);
    // The actual mutation fires target_rollup_update; do not clear dirtiness or
    // rewrite revisions afterward. Setup/import costs are not cron costs.
    await env.DB.prepare("UPDATE probe_target SET enabled=0").run();
    expect((await env.DB.prepare("SELECT rollup_revision,rollup_dirty,rollup_dirty_from FROM component ORDER BY id").all()).results)
      .toEqual(revisions.map((row) => ({ rollup_revision: row.rollup_revision + 1, rollup_dirty: 1, rollup_dirty_from: "0000-01-01" })));
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("disabled probe"); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const counters = usage();
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => counters.errors.push(args.map(String).join(" ")));
    const bindings = { ...workerEnv, DB: meteredDatabase(env.DB, counters),
      SNAPSHOT_KV: meteredKv(env.SNAPSHOT_KV, counters) };
    const perTick: number[] = [];
    let ticks = 0;
    for (; ticks < 240; ticks += 1) {
      now = start + ticks * 60;
      const before = counters.statements;
      await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
      perTick.push(counters.statements - before);
      expect(counters.errors).toEqual([]);
      const dirty = await env.DB.prepare("SELECT COUNT(*) AS n FROM component WHERE rollup_dirty=1").first<{ n: number }>();
      if (dirty!.n === 0) { ticks += 1; break; }
    }
    expect(ticks).toBeLessThan(240);
    const materialized = await env.DB.prepare(`SELECT d.component_id,d.day,d.rollup_revision,d.computed_at,
      d.covered_seconds,d.unknown_seconds,d.downtime_weighted,d.uptime,d.worst_status,
      c.rollup_revision AS evidence_revision FROM daily_uptime d JOIN component c ON c.id=d.component_id`)
      .all<{ component_id: number; day: string; rollup_revision: number; evidence_revision: number;
        computed_at: number; covered_seconds: number; unknown_seconds: number; downtime_weighted: number;
        uptime: number | null; worst_status: string }>();
    expect(materialized.results).toHaveLength(5 * 31);
    for (const row of materialized.results) {
      expect(components).toContain(row.component_id);
      expect(row.rollup_revision).toBe(row.evidence_revision);
      const exact = await computeDailyUptime(env.DB, row.component_id, row.day, row.computed_at);
      expect(row.covered_seconds).toBe(exact!.coveredSeconds);
      expect(row.unknown_seconds).toBe(exact!.unknownSeconds);
      expect(row.downtime_weighted).toBe(exact!.downtimeWeighted);
      expect(row.uptime).toBe(exact!.uptime);
      expect(row.worst_status).toBe(exact!.worstStatus);
    }
    expect(materialized.results.every((row) => row.covered_seconds === 0)).toBe(true);
    expect((await env.DB.prepare("SELECT * FROM probe_state ORDER BY probe_target_id").all()).results).toEqual(accepted);
    expect((await env.DB.prepare("SELECT * FROM probe_result ORDER BY id").all()).results).toEqual(raw);
    expect(fetch).not.toHaveBeenCalled();
    expect(Math.max(...perTick)).toBeLessThanOrEqual(50);
    expect(counters.gets).toBe(0);
    console.info("disabled repair backlog capacity evidence", JSON.stringify({ ticks,
      maxStatementsPerTick: Math.max(...perTick), ...counters,
      queries: Object.entries(counters.queries).sort((a, b) => b[1].rowsRead - a[1].rowsRead)
        .slice(0, 5).map(([sql, count]) => ({ sql: sql.slice(0, 180), ...count })) }));
  }, 180_000);

  it("retries disabled-target retention without losing accepted or predecessor anchors", async () => {
    const start = Date.parse("2026-04-15T12:05:20Z") / 1000;
    const cutoff = startOfUtcDay(start) - 30 * DAY;
    const page = await createPage("Disabled retention retry acceptance");
    const component = await createComponent(page.id, { availableSince: cutoff - 2 * DAY });
    const target = await createProbeTarget(component.id, { enabled: false });
    const samples = [cutoff - DAY + 60, cutoff - DAY + 120, cutoff - 120, cutoff - 60, cutoff + 60];
    for (const [n, at] of samples.entries()) await env.DB.prepare(`INSERT INTO probe_result
      (public_id,probe_target_id,observed_at,ok,created_at) VALUES(?1,?2,?3,1,?3)`)
      .bind(`disabled-retention-${n}`, target.id, at).run();
    // Keep an accepted row older than the predecessor, proving the two guards
    // independently. No new accepted observations are allowed during cron.
    await env.DB.prepare(`UPDATE probe_state SET last_result_id='disabled-retention-0',
      last_probe_at=?2,updated_at=?2 WHERE probe_target_id=?1`).bind(target.id, samples[0]).run();
    const accepted = (await env.DB.prepare("SELECT * FROM probe_state").all()).results;
    const exact = await computeDailyUptime(env.DB, component.id, utcDay(cutoff - DAY), start);
    await env.DB.prepare("UPDATE maintenance_job SET next_run_at=?1 WHERE job<>'retention'").bind(start + DAY).run();
    await env.DB.prepare(`CREATE TRIGGER disabled_retention_test_failure BEFORE DELETE ON probe_result
      BEGIN SELECT RAISE(ABORT,'injected disabled purge failure'); END`).run();
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("disabled probe"); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
    const counters = usage();
    const bindings = { ...workerEnv, DB: meteredDatabase(env.DB, counters),
      SNAPSHOT_KV: meteredKv(env.SNAPSHOT_KV, counters) };
    try {
      await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("injected disabled purge failure");
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_uptime WHERE archived=1").first()).toEqual({ n: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM probe_result").first()).toEqual({ n: 5 });
      expect(await env.DB.prepare("SELECT failures,next_run_at,lease_until FROM maintenance_job WHERE job='retention'").first())
        .toEqual({ failures: 1, next_run_at: start + 60, lease_until: 0 });
    } finally { await env.DB.prepare("DROP TRIGGER disabled_retention_test_failure").run(); }
    errors.length = 0;
    now = start + 59;
    await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM probe_result").first()).toEqual({ n: 5 });
    now = start + 60;
    await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
    expect(await env.DB.prepare(`SELECT covered_seconds,unknown_seconds,downtime_weighted,
      uptime,worst_status,archived FROM daily_uptime WHERE component_id=?1 AND day=?2`)
      .bind(component.id, exact!.day).first()).toEqual({ covered_seconds: exact!.coveredSeconds,
        unknown_seconds: exact!.unknownSeconds, downtime_weighted: exact!.downtimeWeighted,
        uptime: exact!.uptime, worst_status: exact!.worstStatus, archived: 1 });
    expect((await env.DB.prepare("SELECT public_id FROM probe_result ORDER BY observed_at").all()).results)
      .toEqual([{ public_id: "disabled-retention-0" }, { public_id: "disabled-retention-3" }, { public_id: "disabled-retention-4" }]);
    // Preserved predecessor still brackets midnight with the retained successor.
    expect((await computeDailyUptime(env.DB, component.id, utcDay(cutoff), now))!.coveredSeconds).toBe(60);
    now = start + 120;
    await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
    expect(await env.DB.prepare("SELECT failures,completed_day,next_run_at FROM maintenance_job WHERE job='retention'").first())
      .toEqual({ failures: 0, completed_day: utcDay(start), next_run_at: startOfUtcDay(start) + DAY });
    expect((await env.DB.prepare("SELECT * FROM probe_state").all()).results).toEqual(accepted);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM probe_result WHERE observed_at>=?1").bind(start).first()).toEqual({ n: 0 });
    expect(errors).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    console.info("disabled retention retry evidence", JSON.stringify({ ticks: 4, ...counters,
      note: "failed D1 batch has no returned meta; successful statements only, not a daily budget measurement" }));
  });

  it("keeps simultaneous failures, confirmed outages, and recovery within the invocation limit", async () => {
    const start = Math.floor(Date.parse("2026-02-03T23:56:20Z") / 1000);
    const page = await createPage("Fault capacity acceptance");
    for (let index = 0; index < 5; index += 1) {
      const component = await createComponent(page.id, { availableSince: start });
      await createProbeTarget(component.id);
    }
    let now = start;
    let healthy = true;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(healthy ? "ok" : "unavailable", { status: healthy ? 200 : 503 }),
    );
    const counters = usage();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      counters.errors.push(args.map(String).join(" "));
    });
    const bindings = {
      ...workerEnv,
      DB: meteredDatabase(env.DB, counters),
      SNAPSHOT_KV: meteredKv(env.SNAPSHOT_KV, counters),
    };
    const counts: number[] = [];
    const states: string[][] = [];
    for (const [tick, ok] of [true, false, false, false, true, true].entries()) {
      now = start + tick * 60;
      healthy = ok;
      const before = counters.statements;
      await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
      counts.push(counters.statements - before);
      const response = await worker.fetch(
        new Request(`https://api.test/api/status/${page.slug}`),
        workerEnv,
        createExecutionContext(),
      );
      const result = await response.json() as ReadResult;
      expect(result.stale).toBe(false);
      expect(result.snapshot?.components).toHaveLength(5);
      states.push(result.snapshot!.components.map((component) => deriveSnapshotComponent(component, now).status));
    }
    expect(states[0]).toEqual(Array(5).fill("operational"));
    expect(states[1]).toEqual(Array(5).fill("unknown"));
    expect(states[2]).toEqual(Array(5).fill("unknown"));
    expect(states[3]).toEqual(Array(5).fill("partial_outage"));
    expect(states[4]).toEqual(Array(5).fill("partial_outage"));
    expect(states[5]).toEqual(Array(5).fill("operational"));
    expect(counters.errors).toEqual([]);
    expect(Math.max(...counts)).toBeLessThanOrEqual(50);
    log.mockRestore();
    console.log("fault pipeline capacity evidence", { statementsPerTick: counts, ...counters });
  });

  it("handles a realistic retained horizon without scanning it on every maintenance tick", async () => {
    const start = Math.floor(Date.parse("2026-04-15T12:05:20Z") / 1000);
    const page = await createPage("Retention capacity acceptance");
    const targets: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const component = await createComponent(page.id, { availableSince: start - 32 * DAY });
      const target = await createProbeTarget(component.id);
      targets.push(target.id);
      await env.DB.prepare(
        `INSERT INTO probe_result
           (public_id, probe_target_id, observed_at, ok, status_code, latency_ms, error, created_at)
         WITH RECURSIVE samples(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM samples WHERE n < 44640
         )
         SELECT ?1 || '-' || n, ?2, ?3 - n * 60, 1, 200, 1, NULL, ?3 - n * 60
           FROM samples`,
      ).bind(`retained-${target.id}`, target.id, start).run();
      await env.DB.prepare("UPDATE component SET rollup_dirty=0,rollup_dirty_from=NULL WHERE id=?1")
        .bind(component.id).run();
    }
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const counters = usage();
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      counters.errors.push(args.map(String).join(" "));
    });
    const bindings = {
      ...workerEnv,
      DB: meteredDatabase(env.DB, counters),
      SNAPSHOT_KV: meteredKv(env.SNAPSHOT_KV, counters),
    };
    const perTick: number[] = [];
    for (let tick = 0; tick < 30; tick += 1) {
      now = start + tick * 60;
      const before = counters.statements;
      await worker.scheduled(createScheduledController(), bindings, createExecutionContext());
      perTick.push(counters.statements - before);
    }
    const placeholders = targets.map(() => "?").join(",");
    const retained = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM probe_result WHERE probe_target_id IN (${placeholders})`,
    ).bind(...targets).first<{ n: number }>();
    console.info("retention capacity checkpoint", { retainedResults: retained!.n, errors: counters.errors,
      jobs: (await env.DB.prepare("SELECT * FROM maintenance_job").all()).results,
      hotspots: Object.entries(counters.queries).sort((a, b) => b[1].rowsRead - a[1].rowsRead).slice(0, 4).map(([sql, count]) => ({ sql: sql.slice(0, 100), ...count })) });
    expect(counters.errors).toEqual([]);
    expect(retained!.n).toBeLessThan(5 * 44640);
    expect(counters.rowsRead).toBeLessThan(500_000);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(50);
    log.mockRestore();
    console.log("retained horizon capacity evidence", {
      ticks: perTick.length,
      maxStatementsPerTick: Math.max(...perTick),
      retainedResults: retained!.n,
      ...counters,
      queries: Object.entries(counters.queries).sort((a, b) => b[1].rowsRead - a[1].rowsRead).slice(0, 5).map(([sql, count]) => ({ sql: sql.slice(0, 100), ...count })),
    });
  }, 180_000);
});
