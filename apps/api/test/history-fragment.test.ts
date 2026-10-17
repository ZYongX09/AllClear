import { beforeEach, describe, expect, it } from "vitest";
import { startOfUtcDay, type Snapshot } from "@allclear/shared";
import { refreshHistoryFragment } from "../src/history-fragment";
import { buildSnapshot, readSnapshot } from "../src/snapshot";
import { refreshLiveSummary, repairAndPublishSnapshots } from "../src/publication";
import { purgeSnapshotFromCache } from "../src/cache";
import { applyProbeObservation } from "../src/probe/transition";
import { testEnv as env } from "./env";
import { createPage, createComponent, createProbeTarget, DAY, T0 } from "./helpers";

beforeEach(async () => { await env.DB.prepare("DELETE FROM page").run(); });

async function putDay(componentId: number, day: string, computedAt = T0, uptime = 1) {
  await env.DB.prepare(`INSERT INTO daily_uptime(component_id,day,covered_seconds,unknown_seconds,
    downtime_weighted,uptime,worst_status,computed_at)
    VALUES(?1,?2,60,0,0,?4,'operational',?3)
    ON CONFLICT(component_id,day) DO UPDATE SET uptime=excluded.uptime,computed_at=excluded.computed_at`)
    .bind(componentId, day, computedAt, uptime).run();
}

async function fragment(pageId: number) {
  return (await env.DB.prepare("SELECT * FROM snapshot_history WHERE page_id=?1").bind(pageId)
    .first<{ body: string; history_revision: number; computed_at: number | null; valid_until: number }>())!;
}

function beforeBatch(action: () => Promise<void>): D1Database {
  let injected = false;
  return new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!injected) { injected = true; await action(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function meter() {
  const reads: number[] = [];
  let writes = 0;
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      function wrap(statement: D1PreparedStatement): D1PreparedStatement {
        return new Proxy(statement, { get(item, property) {
          if (property === "bind") return (...values: unknown[]) => wrap(item.bind(...values));
          if (property === "first") return async () => {
            const result = await item.all(); reads.push(result.meta.rows_read); writes += result.meta.rows_written;
            return result.results[0] ?? null;
          };
          const value = Reflect.get(item, property);
          return typeof value === "function" ? value.bind(item) : value;
        } });
      }
      return wrap(target.prepare(sql));
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db, reads, writes: () => writes };
}

const kv = { async get() { return null; }, async put() { throw new Error("unexpected visitor KV write"); } } as unknown as KVNamespace;

describe("sparse D1 daily-history fragment", () => {
  it("patches inserts, updates and deletion tombstones; retains the true maximum computation time", async () => {
    const page = await createPage(), c = await createComponent(page.id);
    await putDay(c.id, "2026-10-01", T0);
    await refreshHistoryFragment(env.DB, page.slug, T0);
    await putDay(c.id, "2026-10-02", T0 + 20, 0.8);
    await putDay(c.id, "2026-10-01", T0 + 10, 0.9);
    await refreshHistoryFragment(env.DB, page.slug, T0 + 30);
    expect(JSON.parse((await fragment(page.id)).body).map((r: { uptime: number }) => r.uptime)).toEqual([0.9, 0.8]);
    await env.DB.prepare("DELETE FROM daily_uptime WHERE component_id=?1 AND day=?2").bind(c.id, "2026-10-02").run();
    await refreshHistoryFragment(env.DB, page.slug, T0 + 40);
    expect((await fragment(page.id)).computed_at).toBe(T0 + 10);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshot_history_dirty").first()).toEqual({ n: 0 });
    await env.DB.prepare("DELETE FROM daily_uptime WHERE component_id=?1").bind(c.id).run();
    await refreshHistoryFragment(env.DB, page.slug, T0 + 50);
    expect((await fragment(page.id)).computed_at).toBeNull();
    expect(JSON.parse((await fragment(page.id)).body)).toEqual([]);
  });

  it("keeps newer same-day invalidation when a fill loses the revision CAS", async () => {
    const page = await createPage(), c = await createComponent(page.id);
    await putDay(c.id, "2026-10-01");
    await refreshHistoryFragment(env.DB, page.slug, T0);
    await putDay(c.id, "2026-10-01", T0 + 10, 0.9);
    const previous = await fragment(page.id);
    await refreshHistoryFragment(beforeBatch(() => putDay(c.id, "2026-10-01", T0 + 20, 0.5)), page.slug, T0 + 20);
    expect(await fragment(page.id)).toEqual(previous);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshot_history_dirty").first()).toEqual({ n: 1 });
    await refreshHistoryFragment(env.DB, page.slug, T0 + 30);
    expect(JSON.parse((await fragment(page.id)).body)[0].uptime).toBe(0.5);
  });

  it("expires the UTC horizon even without mutations and never overwrites a newer horizon with an old fill", async () => {
    const page = await createPage(), c = await createComponent(page.id);
    const midnight = startOfUtcDay(T0), before = midnight + DAY - 1;
    const oldest = new Date((midnight - 89 * DAY) * 1000).toISOString().slice(0, 10);
    await putDay(c.id, oldest);
    const race = beforeBatch(() => refreshHistoryFragment(env.DB, page.slug, before + 1));
    await refreshHistoryFragment(race, page.slug, before);
    const saved = await fragment(page.id);
    expect(saved.valid_until).toBe(midnight + 2 * DAY);
    expect(JSON.parse(saved.body)).toEqual([]);
    const snapshot = await buildSnapshot(env.DB, page.slug, { now: before + 1 });
    expect(snapshot.components[0]!.days).toEqual([]);
  });

  it("repairs persisted history dirtiness after a crash without an in-memory historyChanged flag", async () => {
    const page = await createPage(), c = await createComponent(page.id);
    const bodies = new Map<string, string>();
    const store = { async get(key: string) { return bodies.get(key) ?? null; }, async put(key: string, body: string) { bodies.set(key, body); } } as unknown as KVNamespace;
    await refreshLiveSummary(env.DB, page.slug, T0);
    await putDay(c.id, "2026-10-01", T0 + 1, 0.9);
    await repairAndPublishSnapshots(env.DB, store, T0 + 1);
    await purgeSnapshotFromCache(page.slug);
    const result = await readSnapshot(env.DB, store, page.slug, { now: T0 + 1 });
    expect(result.source).toBe("d1-live");
    expect(result.snapshot!.historyComputedAt).toBe(T0 + 1);
    expect(result.snapshot!.components[0]!.days[0]!.uptime).toBe(0.9);
  });

  it("invalidates deleted component membership and both sides of a page move", async () => {
    const a = await createPage(), b = await createPage(), c = await createComponent(a.id);
    await putDay(c.id, "2026-10-01");
    await refreshHistoryFragment(env.DB, a.slug, T0);
    await refreshHistoryFragment(env.DB, b.slug, T0);
    await env.DB.prepare("UPDATE component SET page_id=?2 WHERE id=?1").bind(c.id, b.id).run();
    await refreshHistoryFragment(env.DB, a.slug, T0);
    await refreshHistoryFragment(env.DB, b.slug, T0);
    expect(JSON.parse((await fragment(a.id)).body)).toEqual([]);
    expect(JSON.parse((await fragment(b.id)).body)).toHaveLength(1);
    await env.DB.prepare("DELETE FROM component WHERE id=?1").bind(c.id).run();
    await refreshHistoryFragment(env.DB, b.slug, T0);
    expect(JSON.parse((await fragment(b.id)).body)).toEqual([]);
  });

  it("reuses 450 history rows without scanning them for each minute or each public cache miss", async () => {
    const page = await createPage();
    for (let n = 0; n < 5; n++) {
      const c = await createComponent(page.id);
      await env.DB.prepare(`INSERT INTO daily_uptime(component_id,day,covered_seconds,unknown_seconds,downtime_weighted,uptime,worst_status,computed_at)
        WITH RECURSIVE days(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM days WHERE n<89)
        SELECT ?1,date(?2,'unixepoch','-'||n||' days'),60,0,0,1,'operational',?2 FROM days`)
        .bind(c.id, T0).run();
    }
    await refreshLiveSummary(env.DB, page.slug, T0);
    const metered = meter();
    for (let minute = 1; minute <= 10; minute++) {
      const snapshot = await refreshLiveSummary(metered.db, page.slug, T0 + minute * 60);
      expect(snapshot.components.reduce((n, c) => n + c.days.length, 0)).toBe(450);
    }
    expect(Math.max(...metered.reads)).toBeLessThan(100);
    await purgeSnapshotFromCache(page.slug);
    const publicMeter = meter();
    const result = await readSnapshot(publicMeter.db, kv, page.slug, { now: T0 + 600 });
    expect(result.source).toBe("d1-live");
    expect(publicMeter.reads).toHaveLength(1);
    expect(publicMeter.reads[0]).toBeLessThan(10);
    expect(publicMeter.writes()).toBe(0);
    // One dirty day must not cause the 450-day baseline path to execute again.
    const c = await env.DB.prepare("SELECT id FROM component WHERE page_id=?1 LIMIT 1").bind(page.id).first<{ id: number }>();
    await putDay(c!.id, new Date(T0 * 1000).toISOString().slice(0, 10), T0 + 660, 0.5);
    const patchMeter = meter();
    await refreshHistoryFragment(patchMeter.db, page.slug, T0 + 660);
    expect(Math.max(...patchMeter.reads)).toBeLessThan(30);
  });

  it("expires both hot and materialized public summaries at midnight without repairing storage on reads", async () => {
    const page = await createPage(), c = await createComponent(page.id);
    const midnight = startOfUtcDay(T0), before = midnight + DAY - 1;
    const oldest = new Date((midnight - 89 * DAY) * 1000).toISOString().slice(0, 10);
    await putDay(c.id, oldest);
    await refreshLiveSummary(env.DB, page.slug, before);
    const stored = await fragment(page.id);
    // The local hot cache was just written, but it belongs to the old UTC day.
    const result = await readSnapshot(env.DB, kv, page.slug, { now: before + 1 });
    expect(result.source).toBe("d1-rebuild");
    expect(result.snapshot!.components[0]!.days).toEqual([]);
    expect(result.snapshot!.historyComputedAt).toBeNull();
    expect(await fragment(page.id)).toEqual(stored);
    const summary = await env.DB.prepare("SELECT generated_at FROM snapshot_summary WHERE page_id=?1").bind(page.id).first();
    expect(summary).toEqual({ generated_at: before });
  });

  it("a visitor's mismatched history fallback is raw, coherent and entirely read-only", async () => {
    const page = await createPage(), c = await createComponent(page.id);
    await putDay(c.id, "2026-10-01", T0);
    await refreshLiveSummary(env.DB, page.slug, T0);
    const stored = await fragment(page.id);
    await putDay(c.id, "2026-10-01", T0 + 10, 0.5);
    await purgeSnapshotFromCache(page.slug);
    const measured = meter();
    const result = await readSnapshot(measured.db, kv, page.slug, { now: T0 + 10 });
    expect(result.source).toBe("d1-rebuild");
    expect(result.snapshot!.components[0]!.days[0]!.uptime).toBe(0.5);
    expect(result.snapshot!.historyComputedAt).toBe(T0 + 10);
    expect(measured.writes()).toBe(0);
    expect(await fragment(page.id)).toEqual(stored);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshot_history_dirty").first()).toEqual({ n: 1 });
  });

  it("keeps recovered probes and closed impacts in one coherent live evidence statement", async () => {
    const page = await createPage(), c = await createComponent(page.id);
    const t = await createProbeTarget(c.id, { failureThreshold: 1, recoveryThreshold: 1 });
    await applyProbeObservation(env.DB, { targetId: t.id, resultId: "history-fail", observedAt: T0, ok: false });
    await refreshLiveSummary(env.DB, page.slug, T0);
    await applyProbeObservation(env.DB, { targetId: t.id, resultId: "history-recover", observedAt: T0 + 60, ok: true });
    await purgeSnapshotFromCache(page.slug);
    const result = await readSnapshot(env.DB, kv, page.slug, { now: T0 + 61 });
    const live = result.snapshot as Snapshot;
    expect(live.components[0]!.probe).toMatchObject({ ok: true, lastProbeAt: T0 + 60 });
    expect(live.components[0]!.impacts).toEqual([]);
    expect(result.source).toBe("d1-rebuild");
    expect(await env.DB.prepare("SELECT live_revision FROM snapshot_summary WHERE page_id=?1").bind(page.id).first())
      .not.toEqual(await env.DB.prepare("SELECT live_revision FROM page WHERE id=?1").bind(page.id).first());
  });
});
