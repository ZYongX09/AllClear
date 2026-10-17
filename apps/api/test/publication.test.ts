import { beforeEach, describe, expect, it } from "vitest";
import { deriveSnapshotComponent, type Snapshot } from "@allclear/shared";
import { publishCheckpoint, refreshLiveSummary, repairAndPublishSnapshots } from "../src/publication";
import { applyProbeObservation, CAS_STATE_SQL, INSERT_RESULT_SQL } from "../src/probe/transition";
import { readSnapshot } from "../src/snapshot";
import { updatePage } from "../src/admin/service";
import { purgeSnapshotFromCache } from "../src/cache";
import { testEnv as env } from "./env";
import { createPage, createComponent, createProbeTarget, T0 } from "./helpers";

function memoryKv(failAt = -1) {
  const bodies = new Map<string, string>();
  let puts = 0, gets = 0;
  const kv = {
    async put(key: string, body: string) { puts++; if (puts === failAt) throw new Error("injected put failure"); bodies.set(key, body); },
    async get(key: string) { gets++; return bodies.get(key) ?? null; },
  } as unknown as KVNamespace;
  return { kv, bodies, puts: () => puts, gets: () => gets };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM snapshot_publish_budget").run();
  await env.DB.prepare("UPDATE page SET published_urgent_revision=urgent_revision,published_content_revision=snapshot_version,next_checkpoint_at=?1").bind(T0 + 200000).run();
});

async function fixture() {
  const page = await createPage();
  const component = await createComponent(page.id, { availableSince: T0 });
  const target = await createProbeTarget(component.id, { failureThreshold: 2, recoveryThreshold: 1 });
  let sequence = 0;
  const observe = (now: number, ok = true) => applyProbeObservation(env.DB, {
    targetId: target.id, resultId: `publication-${target.id}-${++sequence}`, observedAt: now, ok,
  });
  return { page, component, target, observe };
}

async function revisions(pageId: number) {
  return (await env.DB.prepare("SELECT live_revision,urgent_revision FROM page WHERE id=?1")
    .bind(pageId).first<{ live_revision: number; urgent_revision: number }>())!;
}

describe("live summary and checkpoint publication", () => {
  it("bounds predecessor and accepted-insert reads independently of retained history", async () => {
    const evidence: unknown[] = [];
    for (const history of [1, 1440, 44_640]) {
      const f = await fixture();
      // Seed newest first, like the capacity fixture. These inserts themselves
      // fire the revision trigger; only the following observation is metered.
      await env.DB.prepare(`INSERT INTO probe_result
        (public_id,probe_target_id,observed_at,ok,created_at)
        WITH RECURSIVE samples(n) AS (
          SELECT 1 UNION ALL SELECT n+1 FROM samples WHERE n < ?1
        )
        SELECT ?2 || '-' || n,?3,?4-n*60,1,?4-n*60 FROM samples`)
        .bind(history, `revision-profile-${f.target.id}`, f.target.id, T0).run();
      const latest = await env.DB.prepare(
        "SELECT id FROM probe_result WHERE probe_target_id=?1 ORDER BY observed_at DESC,id DESC LIMIT 1",
      ).bind(f.target.id).first<{ id: number }>();
      const queries = {
        max: "SELECT MAX(r.observed_at) FROM probe_result r WHERE r.probe_target_id=?1 AND r.id<>?2",
        ordered: "SELECT r.observed_at FROM probe_result r WHERE r.probe_target_id=?1 AND r.id<>?2 ORDER BY r.observed_at DESC,r.id DESC LIMIT 1",
      };
      const predecessors: Record<string, unknown> = {};
      for (const [name, sql] of Object.entries(queries)) {
        const result = await env.DB.prepare(sql).bind(f.target.id, latest!.id).all();
        const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(f.target.id, latest!.id).all();
        expect(result.meta.rows_read).toBeLessThanOrEqual(2);
        expect(plan.results.some((row) => String(row.detail).includes("USING COVERING INDEX idx_probe_result_target_time"))).toBe(true);
        const value = Object.values(result.results[0] ?? {})[0] ?? null;
        expect(value).toBe(history > 1 ? T0 - 120 : null);
        predecessors[name] = { rowsRead: result.meta.rows_read, plan: plan.results };
      }
      const statements: { sql: string; rowsRead: number; rowsWritten: number }[] = [];
      // Meter each real batch result, including trigger work, without changing
      // the transition's statement order, nonce guards or transaction boundary.
      const db = new Proxy(env.DB, {
        get(target, property) {
          if (property === "batch") return async (batch: D1PreparedStatement[]) => {
            const results = await target.batch(batch);
            results.forEach((result, index) => statements.push({
              sql: ["CAS", "INSERT_RESULT + revision trigger", "ADVANCE_NEXT_CHECK"][index]!,
              rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written,
            }));
            return results;
          };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      expect((await applyProbeObservation(db, {
        targetId: f.target.id, resultId: `profile-accepted-${f.target.id}`, observedAt: T0, ok: true,
      })).kind).toBe("applied");
      expect(statements).toHaveLength(3);
      expect(statements[0]!.rowsRead).toBeLessThanOrEqual(1);
      expect(statements[1]!.rowsRead).toBeLessThanOrEqual(24);
      expect(statements[2]!.rowsRead).toBeLessThanOrEqual(2);
      evidence.push({ history, predecessors, statements });
    }
    console.log("revision trigger local D1 evidence", JSON.stringify(evidence));
  });

  it("revises only accepted samples and preserves first, outcome-flip and strict gap urgency", async () => {
    const f = await fixture();
    const steps = [
      { at: T0, ok: true, urgent: 1 },
      { at: T0 + 60, ok: true, urgent: 0 },
      { at: T0 + 180, ok: true, urgent: 0 }, // exactly two intervals is not a gap
      { at: T0 + 301, ok: true, urgent: 1 },
      { at: T0 + 361, ok: false, urgent: 1 }, // below the impact threshold
      { at: T0 + 361, ok: true, urgent: 1 }, // same timestamp, newer internal id
      { at: T0 + 421, ok: true, urgent: 0 },
    ];
    for (const step of steps) {
      const before = await revisions(f.page.id);
      expect((await f.observe(step.at, step.ok)).kind).toBe("applied");
      expect(await revisions(f.page.id)).toEqual({
        live_revision: before.live_revision + 1,
        urgent_revision: before.urgent_revision + step.urgent,
      });
    }
    const before = await revisions(f.page.id);
    expect(await applyProbeObservation(env.DB, {
      targetId: f.target.id, resultId: `publication-${f.target.id}-${steps.length}`,
      observedAt: steps.at(-1)!.at, ok: true,
    })).toEqual({ kind: "replay" });
    expect(await f.observe(T0 + 1, false)).toEqual({ kind: "stale", reason: "out_of_order" });
    expect(await revisions(f.page.id)).toEqual(before);
  });

  it("keeps revision-trigger writes inside the winning observation CAS transaction", async () => {
    const f = await fixture();
    await f.observe(T0);
    const before = await revisions(f.page.id);
    const state = await env.DB.prepare("SELECT transition_seq,last_probe_at,last_result_id FROM probe_state WHERE probe_target_id=?1")
      .bind(f.target.id).first<{ transition_seq: number; last_probe_at: number; last_result_id: string }>();
    const cas = (expected: number, nonce: string, id: string) => env.DB.prepare(CAS_STATE_SQL)
      .bind(0, 2, null, T0, T0 + 60, id, nonce, f.target.id, expected);
    const insert = (nonce: string, id: string) => env.DB.prepare(INSERT_RESULT_SQL)
      .bind(id, f.target.id, T0 + 60, 1, null, null, null, nonce);
    const lost = await env.DB.batch([
      cas(state!.transition_seq - 1, "lost-revision-cas", "lost-revision-result"),
      insert("lost-revision-cas", "lost-revision-result"),
    ]);
    expect(lost.map((result) => result.meta.changes)).toEqual([0, 0]);
    expect(await revisions(f.page.id)).toEqual(before);
    // The insert and its page trigger execute, then a later duplicate result
    // forces the entire batch to roll back, including the CAS and revisions.
    await expect(env.DB.batch([
      cas(state!.transition_seq, "rollback-revision-cas", "rollback-revision-result"),
      insert("rollback-revision-cas", "rollback-revision-result"),
      insert("rollback-revision-cas", "rollback-revision-result"),
    ])).rejects.toThrow(/UNIQUE constraint failed|SQLITE_CONSTRAINT/);
    expect(await revisions(f.page.id)).toEqual(before);
    expect(await env.DB.prepare("SELECT transition_seq,last_probe_at,last_result_id FROM probe_state WHERE probe_target_id=?1")
      .bind(f.target.id).first()).toEqual(state);
    expect(await env.DB.prepare("SELECT id FROM probe_result WHERE public_id IN (?1,?2)")
      .bind("lost-revision-result", "rollback-revision-result").first()).toBeNull();
  });

  it("keeps sixty-second evidence fresh while quiet KV checkpoints take two puts per ten minutes", async () => {
    const f = await fixture(), store = memoryKv();
    for (let minute = 0; minute <= 10; minute++) {
      const now = T0 + minute * 60;
      await f.observe(now);
      await repairAndPublishSnapshots(env.DB, store.kv, now);
      const result = await readSnapshot(env.DB, store.kv, f.page.slug, { now });
      expect(["cache-live", "d1-live"]).toContain(result.source);
      expect(result.snapshot!.components[0]!.probe!.lastProbeAt).toBe(now);
      expect(deriveSnapshotComponent(result.snapshot!.components[0]!, now + 120).status).toBe("operational");
      expect(deriveSnapshotComponent(result.snapshot!.components[0]!, now + 121).status).toBe("unknown");
      expect(store.puts()).toBe(minute < 10 ? 2 : 4);
    }
    expect(store.gets()).toBe(0);
  });

  it("persists urgency before publication, including pending failure, recovery and stale-gap resume", async () => {
    const f = await fixture(), store = memoryKv();
    for (const [now, ok] of [[T0, true], [T0 + 60, false], [T0 + 120, false], [T0 + 180, true], [T0 + 360, true]] as const) {
      await f.observe(now, ok);
      // No affected-page list is supplied: persisted revision repair survives a
      // crash after the winning observation batch but before publication.
      await repairAndPublishSnapshots(env.DB, store.kv, now);
      const snapshot = JSON.parse(store.bodies.get(`snapshot:${f.page.slug}`)!) as Snapshot;
      expect(snapshot.components[0]!.probe).toMatchObject({ lastProbeAt: now, ok });
    }
    expect(store.puts()).toBe(10);
  });

  it("a public materialization miss builds read-only without any KV puts", async () => {
    const f = await fixture(), store = memoryKv();
    const result = await readSnapshot(env.DB, store.kv, f.page.slug, { now: T0 });
    expect(result.source).toBe("d1-rebuild");
    expect(store.puts()).toBe(0);
    expect(await env.DB.prepare("SELECT page_id FROM snapshot_summary WHERE page_id=?1").bind(f.page.id).first()).toBeNull();
  });

  it("does not trust a summary whose accepted-result revision fell behind", async () => {
    const f = await fixture(), store = memoryKv();
    await refreshLiveSummary(env.DB, f.page.slug, T0);
    await f.observe(T0 + 60);
    await purgeSnapshotFromCache(f.page.slug);
    const result = await readSnapshot(env.DB, store.kv, f.page.slug, { now: T0 + 60 });
    expect(result.source).toBe("d1-rebuild");
    expect(result.snapshot!.components[0]!.probe!.lastProbeAt).toBe(T0 + 60);
    expect(store.puts()).toBe(0);
  });

  it("one concurrent claim publishes; a partial put remains dirty and respects backoff", async () => {
    const f = await fixture(), store = memoryKv(2);
    await f.observe(T0);
    await refreshLiveSummary(env.DB, f.page.slug, T0);
    const results = await Promise.all([publishCheckpoint(env.DB, store.kv, f.page.slug, T0), publishCheckpoint(env.DB, store.kv, f.page.slug, T0)]);
    expect(results.filter((r) => r.error)).toHaveLength(1);
    expect(store.puts()).toBe(2);
    expect((await publishCheckpoint(env.DB, store.kv, f.page.slug, T0 + 1)).deferred).toBe(true);
    expect(store.puts()).toBe(2);
    expect((await publishCheckpoint(env.DB, store.kv, f.page.slug, T0 + 30)).published).toBe(true);
    expect(store.puts()).toBe(4);
  });

  it("reserves failed attempts against a global daily budget and resets only on a new UTC day", async () => {
    const f = await fixture(), store = memoryKv();
    await refreshLiveSummary(env.DB, f.page.slug, T0);
    await env.DB.prepare("INSERT INTO snapshot_publish_budget(day,puts,periodic_puts) VALUES (?1,800,288)").bind(new Date(T0 * 1000).toISOString().slice(0, 10)).run();
    expect((await publishCheckpoint(env.DB, store.kv, f.page.slug, T0)).error).toContain("budget");
    expect(store.puts()).toBe(0);
    // A new UTC horizon also requires a current history-bearing document.
    await refreshLiveSummary(env.DB, f.page.slug, T0 + 86400);
    expect((await publishCheckpoint(env.DB, store.kv, f.page.slug, T0 + 86400)).published).toBe(true);
    expect(store.puts()).toBe(2);
  });

  it("acknowledges only the built document when an admin mutation arrives during a put", async () => {
    const f = await fixture();
    await refreshLiveSummary(env.DB, f.page.slug, T0);
    let injected = false;
    const store = memoryKv();
    const kv = { async put(key: string, body: string) {
      if (!injected) {
        injected = true;
        await env.DB.prepare("UPDATE page SET name='new',snapshot_version=snapshot_version+1,urgent_revision=urgent_revision+1 WHERE id=?1").bind(f.page.id).run();
      }
      await store.kv.put(key, body);
    } } as unknown as KVNamespace;
    await publishCheckpoint(env.DB, kv, f.page.slug, T0);
    const row = await env.DB.prepare("SELECT snapshot_version,published_content_revision FROM page WHERE id=?1").bind(f.page.id).first<{ snapshot_version: number; published_content_revision: number }>();
    expect(row!.published_content_revision).toBeLessThan(row!.snapshot_version);
    await repairAndPublishSnapshots(env.DB, store.kv, T0 + 60);
    expect(JSON.parse(store.bodies.get(`snapshot:${f.page.slug}`)!).name).toBe("new");
  });

  it("repairs atomic admin dirtiness even when the service version bump never ran", async () => {
    const f = await fixture(), store = memoryKv();
    await repairAndPublishSnapshots(env.DB, store.kv, T0);
    await env.DB.prepare("UPDATE component SET name='crash-committed' WHERE id=?1").bind(f.component.id).run();
    await repairAndPublishSnapshots(env.DB, store.kv, T0 + 60);
    const snapshot = JSON.parse(store.bodies.get(`snapshot:${f.page.slug}`)!) as Snapshot;
    expect(snapshot.components[0]!.name).toBe("crash-committed");
  });

  it("rejects malformed fallback JSON envelopes instead of returning plausible emptiness", async () => {
    const page = await createPage(), store = memoryKv();
    store.bodies.set(`snapshot:${page.slug}`, "{}");
    const db = { prepare() { throw new Error("offline"); } } as unknown as D1Database;
    const result = await readSnapshot(db, store.kv, page.slug, { now: T0 });
    expect(result.source).toBe("none");
    expect(result.snapshot).toBeNull();
    expect(result.errors.some((error) => error.includes("invalid snapshot"))).toBe(true);
  });

  it("admin succeeds after D1 refresh even if KV must be deferred", async () => {
    const f = await fixture(), store = memoryKv(1);
    await expect(updatePage({ db: env.DB, kv: store.kv, now: T0 }, f.page.slug, { name: "saved" })).resolves.toBeUndefined();
    const result = await readSnapshot(env.DB, store.kv, f.page.slug, { now: T0 });
    expect(result.snapshot!.name).toBe("saved");
  });
});
