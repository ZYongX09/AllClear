import { deriveSnapshotComponent, type ReadResult } from "@allclear/shared";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
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
  it("preserves minute sampling within a measured one-page daily storage budget", async () => {
    const start = Math.floor(Date.parse("2026-01-12T00:05:20Z") / 1000);
    const page = await createPage("Capacity acceptance");
    const targetIds: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const component = await createComponent(page.id, { availableSince: start - 2 * DAY });
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
    expect(counters.errors).toEqual([]);
    expect(counters.puts).toBeLessThanOrEqual(292);
    expect(counters.gets).toBe(0);
    expect(counters.rowsRead).toBeLessThan(3_000_000);
    expect(counters.rowsWritten).toBeLessThan(80_000);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(50);
    log.mockRestore();
    console.log("pipeline capacity evidence", {
      ticks: perTick.length,
      maxStatementsPerTick: Math.max(...perTick),
      ...counters,
      queries: Object.entries(counters.queries).sort((a, b) => b[1].rowsRead - a[1].rowsRead).slice(0, 5).map(([sql, count]) => ({ sql: sql.slice(0, 100), ...count })),
    });
  }, 600_000);

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
