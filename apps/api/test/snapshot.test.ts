import { deriveSnapshotComponent } from "@allclear/shared";
import { describe, expect, it } from "vitest";

import { buildSnapshot, readSnapshot, writeSnapshot } from "../src/snapshot";
import { testEnv as env } from "./env";
import {
  createComponent,
  createPage,
  createProbeTarget,
  DAY,
  MINUTE,
  T0,
} from "./helpers";

/**
 * Snapshot construction and the public read chain.
 *
 * The claims worth testing here are the ones a reader would otherwise have to
 * take on trust: that the document carries *evidence* rather than a stored
 * verdict, that `stale` describes the read path rather than the document's age,
 * and that the fallback chain reaches `snapshot:<slug>:last` only when D1 is
 * genuinely unreachable.
 */

/** A `D1Database` stand-in that fails every query. */
function brokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("d1 unavailable");
    },
    batch() {
      throw new Error("d1 unavailable");
    },
  } as unknown as D1Database;
}

describe("buildSnapshot", () => {
  it("carries evidence per component and no stored status", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    await createProbeTarget(component.id, { intervalSeconds: MINUTE });

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });

    expect(snapshot.slug).toBe(page.slug);
    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.components).toHaveLength(1);

    const built = snapshot.components[0]!;
    expect(built).not.toHaveProperty("status");
    expect(built.impacts).toEqual([]);
    expect(built.statusFreshnessMax).toBe(120);
  });

  it("reports a target that has never reported as uncovered, not as healthy", async () => {
    // The failure this prevents: "we have never probed this" arriving at the
    // reader as a fresh success.
    const page = await createPage();
    const component = await createComponent(page.id);
    await createProbeTarget(component.id);

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    const built = snapshot.components[0]!;

    expect(built.probe).toBeNull();
    expect(deriveSnapshotComponent(built, T0).status).toBe("unknown");
    expect(deriveSnapshotComponent(built, T0).reason).toBe("monitoring_uncovered");
  });

  it("derives a fault from an active impact and stops deriving it once closed", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    await createProbeTarget(component.id);

    await env.DB.prepare(
      `INSERT INTO impact (public_id, component_id, probe_target_id, change_id, severity,
                           start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
       VALUES ('imp-open', ?1, NULL, NULL, 'full_outage', ?2, NULL, 0, NULL, ?2, ?2)`,
    )
      .bind(component.id, T0 - 600)
      .run();

    const open = await buildSnapshot(env.DB, page.slug, { now: T0 });
    expect(deriveSnapshotComponent(open.components[0]!, T0).status).toBe("full_outage");

    // Close it and rebuild: the interval is gone, and with no probe result the
    // component is uncovered rather than magically healthy.
    await env.DB.prepare("UPDATE impact SET end_at = ?1 WHERE public_id = 'imp-open'")
      .bind(T0 - 300)
      .run();

    const closed = await buildSnapshot(env.DB, page.slug, { now: T0 });
    expect(closed.components[0]!.impacts).toEqual([]);
    expect(deriveSnapshotComponent(closed.components[0]!, T0).status).toBe("unknown");
  });

  it("omits impacts that had already closed before the build", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    await env.DB.prepare(
      `INSERT INTO impact (public_id, component_id, probe_target_id, change_id, severity,
                           start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
       VALUES ('imp-past', ?1, NULL, NULL, 'partial_outage', ?2, ?3, 0, NULL, ?2, ?2)`,
    )
      .bind(component.id, T0 - 10 * DAY, T0 - 9 * DAY)
      .run();

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    expect(snapshot.components[0]!.impacts).toEqual([]);
  });

  it("routes a maintenance-severity impact into maintenances instead of dropping it", async () => {
    // Dropping it would make the component look uncovered during an announced
    // window, which reads as "nobody is watching" rather than "planned work".
    const page = await createPage();
    const component = await createComponent(page.id);

    await env.DB.prepare(
      `INSERT INTO impact (public_id, component_id, probe_target_id, change_id, severity,
                           start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
       VALUES ('imp-maint', ?1, NULL, NULL, 'maintenance', ?2, NULL, 0, NULL, ?2, ?2)`,
    )
      .bind(component.id, T0 - 600)
      .run();

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    const built = snapshot.components[0]!;

    expect(built.impacts).toEqual([]);
    expect(built.maintenances).toHaveLength(1);
    expect(deriveSnapshotComponent(built, T0).status).toBe("maintenance");
  });

  it("does not mark a component as under maintenance for a scheduled window", async () => {
    // Announcing work for next week must not paint the component today.
    const page = await createPage();
    const component = await createComponent(page.id);
    await createProbeTarget(component.id);

    await env.DB.prepare(
      `INSERT INTO change (public_id, page_id, kind, status, title, body, severity, starts_at,
                           ends_at, scheduled_start_at, scheduled_end_at, created_at, updated_at)
       VALUES ('ch-sched', ?1, 'maintenance', 'scheduled', 'Upgrade', NULL, 'none', ?2,
               ?3, ?2, ?3, ?4, ?4)`,
    )
      .bind(page.id, T0 + 2 * DAY, T0 + 2 * DAY + 3600, T0)
      .run();

    const changeRow = await env.DB.prepare("SELECT id FROM change WHERE public_id = 'ch-sched'")
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO change_component (change_id, component_id) VALUES (?1, ?2)",
    )
      .bind(changeRow!.id, component.id)
      .run();

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    const built = snapshot.components[0]!;

    expect(built.maintenances).toHaveLength(1);
    expect(built.maintenances[0]!.status).toBe("scheduled");
    // The probe target has never reported, so the honest answer is `unknown`.
    // The point of the assertion is that it is *not* `maintenance`.
    expect(deriveSnapshotComponent(built, T0).status).toBe("unknown");
  });

  it("links a change to its components and embeds its timeline", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    await env.DB.prepare(
      `INSERT INTO change (public_id, page_id, kind, status, title, body, severity, starts_at,
                           ends_at, scheduled_start_at, scheduled_end_at, created_at, updated_at)
       VALUES ('ch-1', ?1, 'incident', 'in_progress', 'Elevated errors', 'We are looking.',
               'partial_outage', ?2, NULL, NULL, NULL, ?2, ?2)`,
    )
      .bind(page.id, T0 - 300)
      .run();

    const changeRow = await env.DB.prepare("SELECT id FROM change WHERE public_id = 'ch-1'")
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO change_component (change_id, component_id) VALUES (?1, ?2)")
      .bind(changeRow!.id, component.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO change_update (public_id, change_id, status, body, created_at)
       VALUES ('upd-1', ?1, 'in_progress', 'Investigating.', ?2)`,
    )
      .bind(changeRow!.id, T0 - 200)
      .run();

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });

    expect(snapshot.changes).toHaveLength(1);
    const change = snapshot.changes[0]!;
    expect(change.componentPublicIds).toEqual([component.publicId]);
    expect(change.updates).toHaveLength(1);
    expect(change.updates[0]!.body).toBe("Investigating.");
    expect(snapshot.components[0]!.changePublicIds).toEqual(["ch-1"]);
  });

  it("carries 90-day history rows in ascending day order", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    for (const day of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
      await env.DB.prepare(
        `INSERT INTO daily_uptime (component_id, day, covered_seconds, unknown_seconds,
                                   downtime_weighted, uptime, worst_status, computed_at)
         VALUES (?1, ?2, 86400, 0, 0, 1.0, 'operational', ?3)`,
      )
        .bind(component.id, day, T0)
        .run();
    }

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    expect(snapshot.components[0]!.days.map((d) => d.day)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
  });

  it("throws for an unknown slug rather than returning an empty page", async () => {
    await expect(buildSnapshot(env.DB, "no-such-page", { now: T0 })).rejects.toThrow(
      /no page with slug/,
    );
  });
});

describe("writeSnapshot and the read chain", () => {
  it("writes both the fresh and the last-known-good key", async () => {
    const page = await createPage();
    await createComponent(page.id);

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshot(env.SNAPSHOT_KV, snapshot);

    const fresh = await env.SNAPSHOT_KV.get(`snapshot:${page.slug}`);
    const last = await env.SNAPSHOT_KV.get(`snapshot:${page.slug}:last`);
    expect(fresh).not.toBeNull();
    expect(last).not.toBeNull();
    expect(JSON.parse(last!)).toEqual(JSON.parse(fresh!));
  });

  it("serves from KV without touching D1, and reports it as not stale", async () => {
    const page = await createPage();
    await createComponent(page.id);

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshot(env.SNAPSHOT_KV, snapshot);

    const result = await readSnapshot(brokenDb(), env.SNAPSHOT_KV, page.slug, { now: T0 + 10 });

    expect(result.source).toBe("kv-fresh");
    expect(result.stale).toBe(false);
    expect(result.snapshot?.slug).toBe(page.slug);
    expect(result.ageSeconds).toBe(10);
    expect(result.aged).toBe(false);
  });

  it("rebuilds from D1 on a KV miss and repopulates both keys", async () => {
    const page = await createPage();
    await createComponent(page.id);

    const result = await readSnapshot(env.DB, env.SNAPSHOT_KV, page.slug, { now: T0 });

    expect(result.source).toBe("d1-rebuild");
    expect(result.stale).toBe(false);
    expect(result.snapshot?.components).toHaveLength(1);

    // The rebuild is not allowed to leave the fallback key unwritten.
    expect(await env.SNAPSHOT_KV.get(`snapshot:${page.slug}:last`)).not.toBeNull();
  });

  it("falls back to the last good snapshot and marks the read stale when D1 is down", async () => {
    const page = await createPage();
    await createComponent(page.id);

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshot(env.SNAPSHOT_KV, snapshot);
    // Remove only the fresh key, so the read has to fall through to `:last`.
    await env.SNAPSHOT_KV.delete(`snapshot:${page.slug}`);

    const result = await readSnapshot(brokenDb(), env.SNAPSHOT_KV, page.slug, { now: T0 + 60 });

    expect(result.source).toBe("kv-last");
    expect(result.stale).toBe(true);
    expect(result.snapshot?.slug).toBe(page.slug);
    expect(result.errors.some((entry) => entry.includes("d1-rebuild"))).toBe(true);
  });

  it("reports nothing to serve rather than an empty but plausible page", async () => {
    const page = await createPage();

    const result = await readSnapshot(brokenDb(), env.SNAPSHOT_KV, page.slug, { now: T0 });

    expect(result.source).toBe("none");
    expect(result.snapshot).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.ageSeconds).toBeNull();
  });

  it("separates staleness from age", async () => {
    // The M0 finding this settles: a stable page must not light up a warning
    // indicator just because its content has not changed recently.
    const page = await createPage();
    await createComponent(page.id);

    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshot(env.SNAPSHOT_KV, snapshot);

    const result = await readSnapshot(env.DB, env.SNAPSHOT_KV, page.slug, {
      now: T0 + 3600,
      ageWarningSeconds: 300,
    });

    expect(result.source).toBe("kv-fresh");
    expect(result.stale).toBe(false);
    expect(result.ageSeconds).toBe(3600);
    expect(result.aged).toBe(true);
  });
});

describe("public routes", () => {
  it("serves the snapshot with a 200 and the read metadata", async () => {
    const page = await createPage();
    await createComponent(page.id);
    const { callApi } = await import("./helpers");

    const first = await callApi(`/api/status/${page.slug}`);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { source: string; snapshot: { slug: string } };
    expect(body.source).toBe("d1-rebuild");
    expect(body.snapshot.slug).toBe(page.slug);
  });

  it("returns 503 when nothing can be served", async () => {
    const page = await createPage();
    const { callApi } = await import("./helpers");

    const response = await callApi(`/api/status/${page.slug}`);
    expect(response.status).toBe(200);

    // A slug that does not exist has neither a KV entry nor a D1 row.
    const missing = await callApi("/api/status/definitely-not-a-page");
    expect(missing.status).toBe(503);
    const body = (await missing.json()) as { snapshot: null; source: string };
    expect(body.snapshot).toBeNull();
    expect(body.source).toBe("none");
  });

  it("emits an Atom feed that matches the snapshot's changes", async () => {
    // The HTTP path uses the wall clock — there is no way to inject `now` into a
    // route — so this test's timestamps are relative to it. A change older than
    // the 30-day history window would be excluded from the snapshot and the feed
    // would legitimately be empty.
    const now = Math.floor(Date.now() / 1000);
    const page = await createPage("Feed Page");
    await env.DB.prepare(
      `INSERT INTO change (public_id, page_id, kind, status, title, body, severity, starts_at,
                           ends_at, scheduled_start_at, scheduled_end_at, created_at, updated_at)
       VALUES ('ch-feed', ?1, 'incident', 'resolved', 'Feed <test> & co', 'Body.',
               'partial_outage', ?2, ?3, NULL, NULL, ?2, ?2)`,
    )
      .bind(page.id, now - 300, now - 60)
      .run();

    const { callApi } = await import("./helpers");
    const response = await callApi(`/api/status/${page.slug}/feed.xml`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("atom+xml");

    const xml = await response.text();
    expect(xml).toContain("<title>Feed Page</title>");
    // The title contains characters that are illegal unescaped in XML.
    expect(xml).toContain("Feed &lt;test&gt; &amp; co");
    expect(xml).toContain("urn:allclear:change:ch-feed");
  });
});
