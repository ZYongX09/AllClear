import { describe, expect, it } from "vitest";

import { testEnv as env } from "./env";
import {
  callAdmin,
  callApi,
  callJson,
  createComponent,
  createPage,
  createProbeTarget,
  pageVersion,
  readKvSnapshot,
  T0,
} from "./helpers";

/**
 * The admin write path.
 *
 * Three properties are load-bearing and are what these tests are really about:
 *
 *   1. The internal namespace is closed without the key. Reachability through a
 *      Service Binding is not authorisation, and a test that only exercised the
 *      happy path would not notice if the check were dropped.
 *   2. Every write advances `page.snapshot_version` and republishes KV. A write
 *      that forgets is invisible from the API — it returns 200 and the database
 *      is correct — so the only way to catch it is to assert the side effect.
 *   3. Creating an incident at a fault severity produces an `impact` row, because
 *      `impact` is the single source of truth for downtime. An incident that only
 *      appeared in the timeline would be invisible to the uptime maths.
 */

const MISSING_PAGE = "no-such-page";

describe("authentication", () => {
  it("refuses a request with no key", async () => {
    const response = await callJson("/internal/admin/pages/x", "GET", {});
    expect(response.status).toBe(401);
  });

  it("refuses a request with the wrong key", async () => {
    const response = await callJson("/internal/admin/pages/x", "GET", {}, {
      "X-Internal-Key": "wrong",
    });
    expect(response.status).toBe(401);
  });

  it("accepts the configured key", async () => {
    const page = await createPage();
    const response = await callAdmin(`/internal/admin/pages/${page.slug}`, "GET");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; page: { slug: string } };
    expect(body.ok).toBe(true);
    expect(body.page.slug).toBe(page.slug);
  });

  it("does not expose the admin namespace publicly", async () => {
    // The same path without the internal key must not be reachable at all.
    const page = await createPage();
    const response = await callApi(`/internal/admin/pages/${page.slug}`);
    expect(response.status).toBe(401);
  });
});

describe("validation", () => {
  it("rejects a missing required field with the field name", async () => {
    const page = await createPage();
    const response = await callAdmin(`/internal/admin/pages/${page.slug}/sections`, "POST", {});
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; field: string | null };
    expect(body.ok).toBe(false);
    expect(body.field).toBe("name");
  });

  it("rejects a value outside an enum", async () => {
    const page = await createPage();
    const response = await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
      kind: "explosion",
      title: "x",
      severity: "none",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { field: string | null };
    expect(body.field).toBe("kind");
  });

  it("rejects a component that belongs to another page", async () => {
    const pageA = await createPage();
    const pageB = await createPage();
    const component = await createComponent(pageB.id);

    const response = await callAdmin(`/internal/admin/pages/${pageA.slug}/components`, "POST", {
      name: "Borrowed",
      sectionPublicId: null,
    });
    expect(response.status).toBe(201);

    const crossPage = await callAdmin(`/internal/admin/pages/${pageA.slug}/changes`, "POST", {
      kind: "incident",
      title: "Cross page",
      severity: "partial_outage",
      componentPublicIds: [component.publicId],
    });
    expect(crossPage.status).toBe(400);
    const body = (await crossPage.json()) as { field: string | null };
    expect(body.field).toBe("componentPublicIds");
  });

  it("rejects a write against an unknown page", async () => {
    const response = await callAdmin(`/internal/admin/pages/${MISSING_PAGE}/sections`, "POST", {
      name: "Orphan",
    });
    expect(response.status).toBe(400);
  });
});

describe("version advancement and republication", () => {
  it("advances the version and rewrites KV on every write", async () => {
    const page = await createPage();
    const before = await pageVersion(page.id);

    const created = await callAdmin(`/internal/admin/pages/${page.slug}/components`, "POST", {
      name: "API",
    });
    expect(created.status).toBe(201);

    const after = await pageVersion(page.id);
    expect(after).toBe(before + 1);

    const snapshot = (await readKvSnapshot(page.slug)) as { snapshotVersion: number };
    expect(snapshot.snapshotVersion).toBe(after);

    // A read now must come from KV, proving the write published rather than
    // leaving the rebuild to the next cron tick.
    const read = await callApi(`/api/status/${page.slug}`);
    const body = (await read.json()) as { source: string };
    expect(["cache-live", "d1-live"]).toContain(body.source);
  });

  it("advances the version for a delete as well", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const before = await pageVersion(page.id);

    const response = await callAdmin(
      `/internal/admin/components/${component.publicId}`,
      "DELETE",
    );
    expect(response.status).toBe(200);
    expect(await pageVersion(page.id)).toBe(before + 1);
  });
});

describe("changes produce impacts", () => {
  it("creates one impact per affected component for a fault-severity incident", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    const response = await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
      kind: "incident",
      title: "Elevated errors",
      body: "Investigating.",
      severity: "partial_outage",
      componentPublicIds: [component.publicId],
      startsAt: T0 - 120,
    });
    expect(response.status).toBe(201);

    const impacts = await env.DB.prepare(
      "SELECT severity, start_at, end_at, estimated, change_id FROM impact WHERE component_id = ?1",
    )
      .bind(component.id)
      .all<{ severity: string; start_at: number; end_at: number | null; estimated: number }>();

    expect(impacts.results).toHaveLength(1);
    expect(impacts.results[0]!.severity).toBe("partial_outage");
    expect(impacts.results[0]!.start_at).toBe(T0 - 120);
    expect(impacts.results[0]!.end_at).toBeNull();
    // A hand-declared incident is not an estimate: the operator stated it.
    expect(impacts.results[0]!.estimated).toBe(0);
  });

  it("creates no impact for a severity of `none`", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
      kind: "incident",
      title: "Informational",
      severity: "none",
      componentPublicIds: [component.publicId],
    });

    const impacts = await env.DB.prepare("SELECT id FROM impact WHERE component_id = ?1")
      .bind(component.id)
      .all();
    expect(impacts.results).toHaveLength(0);
  });

  it("creates no impact for a maintenance window", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
      kind: "maintenance",
      title: "Upgrade",
      severity: "none",
      componentPublicIds: [component.publicId],
      scheduledStartAt: T0 + 3600,
      scheduledEndAt: T0 + 7200,
    });

    const impacts = await env.DB.prepare("SELECT id FROM impact WHERE component_id = ?1")
      .bind(component.id)
      .all();
    expect(impacts.results).toHaveLength(0);
  });

  it("closes the impacts when the incident resolves", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    const created = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
        kind: "incident",
        title: "Outage",
        severity: "full_outage",
        componentPublicIds: [component.publicId],
        startsAt: T0 - 600,
      })
    ).json()) as { publicId: string };

    const resolved = await callAdmin(`/internal/admin/changes/${created.publicId}`, "PATCH", {
      status: "resolved",
      endsAt: T0 - 60,
    });
    expect(resolved.status).toBe(200);

    const impacts = await env.DB.prepare(
      "SELECT end_at FROM impact WHERE component_id = ?1",
    )
      .bind(component.id)
      .all<{ end_at: number | null }>();
    expect(impacts.results[0]!.end_at).toBe(T0 - 60);

    // And the public document stops showing a fault.
    const snapshot = (await readKvSnapshot(page.slug)) as {
      components: Array<{ impacts: unknown[] }>;
    };
    expect(snapshot.components[0]!.impacts).toEqual([]);
  });

  it("reopens an impact at its original start rather than restarting it", async () => {
    // Reopening is a correction, not a new event: the recorded interval has to
    // grow to cover the whole thing, or the first occurrence is lost from the
    // uptime record.
    const page = await createPage();
    const component = await createComponent(page.id);

    const created = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
        kind: "incident",
        title: "Flapping",
        severity: "partial_outage",
        componentPublicIds: [component.publicId],
        startsAt: T0 - 600,
      })
    ).json()) as { publicId: string };

    await callAdmin(`/internal/admin/changes/${created.publicId}`, "PATCH", {
      status: "resolved",
      endsAt: T0 - 300,
    });
    await callAdmin(`/internal/admin/changes/${created.publicId}`, "PATCH", {
      status: "in_progress",
    });

    const impacts = await env.DB.prepare(
      "SELECT start_at, end_at FROM impact WHERE component_id = ?1",
    )
      .bind(component.id)
      .all<{ start_at: number; end_at: number | null }>();

    expect(impacts.results[0]!.start_at).toBe(T0 - 600);
    expect(impacts.results[0]!.end_at).toBeNull();
  });

  it("applies a per-component override to the impact severity", async () => {
    // Without this the override would live in `change_update_component` and never
    // reach `impact`, so uptime would charge every component the headline
    // severity.
    const page = await createPage();
    const api = await createComponent(page.id, { name: "API" });
    const web = await createComponent(page.id, { name: "Web" });

    const created = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
        kind: "incident",
        title: "Mixed impact",
        severity: "partial_outage",
        componentPublicIds: [api.publicId, web.publicId],
        startsAt: T0 - 600,
      })
    ).json()) as { publicId: string };

    await callAdmin(`/internal/admin/changes/${created.publicId}/updates`, "POST", {
      status: "in_progress",
      body: "The API is worse than the website.",
      componentOverrides: [
        { componentPublicId: api.publicId, status: "full_outage" },
        { componentPublicId: web.publicId, status: "operational" },
      ],
    });

    const apiImpact = await env.DB.prepare(
      "SELECT severity, end_at FROM impact WHERE component_id = ?1",
    )
      .bind(api.id)
      .first<{ severity: string; end_at: number | null }>();
    const webImpact = await env.DB.prepare(
      "SELECT severity, end_at FROM impact WHERE component_id = ?1",
    )
      .bind(web.id)
      .first<{ severity: string; end_at: number | null }>();

    expect(apiImpact!.severity).toBe("full_outage");
    expect(apiImpact!.end_at).toBeNull();
    expect(webImpact!.end_at).not.toBeNull();
  });

  it("follows the newest update's status for the change itself", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    const created = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/changes`, "POST", {
        kind: "incident",
        title: "Follows updates",
        severity: "degraded_performance",
        componentPublicIds: [component.publicId],
      })
    ).json()) as { publicId: string };

    await callAdmin(`/internal/admin/changes/${created.publicId}/updates`, "POST", {
      status: "resolved",
      body: "Fixed.",
    });

    const row = await env.DB.prepare("SELECT status, ends_at FROM change WHERE public_id = ?1")
      .bind(created.publicId)
      .first<{ status: string; ends_at: number | null }>();
    expect(row!.status).toBe("resolved");
    expect(row!.ends_at).not.toBeNull();
  });
});

describe("manual impacts", () => {
  it("records a hand-entered outage and closes it", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    const created = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/impacts`, "POST", {
        componentPublicId: component.publicId,
        severity: "full_outage",
        startAt: T0 - 3600,
      })
    ).json()) as { publicId: string };

    const closed = await callAdmin(`/internal/admin/impacts/${created.publicId}/close`, "POST", {
      endAt: T0 - 1800,
    });
    expect(closed.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT start_at, end_at, probe_target_id, change_id FROM impact WHERE public_id = ?1",
    )
      .bind(created.publicId)
      .first<{ start_at: number; end_at: number | null; probe_target_id: null; change_id: null }>();

    expect(row!.start_at).toBe(T0 - 3600);
    expect(row!.end_at).toBe(T0 - 1800);
    // No target and no change is what marks it as hand-entered, which is how the
    // uptime maths knows to treat it as direct evidence rather than a sample.
    expect(row!.probe_target_id).toBeNull();
    expect(row!.change_id).toBeNull();
  });

  it("refuses an end before the start", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    const response = await callAdmin(`/internal/admin/pages/${page.slug}/impacts`, "POST", {
      componentPublicId: component.publicId,
      severity: "partial_outage",
      startAt: T0,
      endAt: T0 - 60,
    });
    expect(response.status).toBe(400);
  });

  it("refuses to close a probe-driven impact by hand", async () => {
    // Closing it here would let the operator and the prober disagree about
    // whether a target is up, and the next probe observation would reopen it.
    const page = await createPage();
    const component = await createComponent(page.id);
    const target = await createProbeTarget(component.id);

    await env.DB.prepare(
      `INSERT INTO impact (public_id, component_id, probe_target_id, change_id, severity,
                           start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
       VALUES ('imp-probe', ?1, ?2, NULL, 'partial_outage', ?3, NULL, 1, NULL, ?3, ?3)`,
    )
      .bind(component.id, target.id, T0 - 600)
      .run();

    const response = await callAdmin("/internal/admin/impacts/imp-probe/close", "POST", {
      endAt: T0,
    });
    expect(response.status).toBe(400);
  });
});

describe("probe targets", () => {
  it("creates the scheduler row alongside the target", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);

    const created = (await (
      await callAdmin("/internal/admin/probes", "POST", {
        componentPublicId: component.publicId,
        url: "https://probe.example.com/health",
        intervalSeconds: 60,
      })
    ).json()) as { publicId: string };

    const state = await env.DB.prepare(
      `SELECT s.consecutive_failures, s.transition_seq
         FROM probe_state s
         JOIN probe_target t ON t.id = s.probe_target_id
        WHERE t.public_id = ?1`,
    )
      .bind(created.publicId)
      .first<{ consecutive_failures: number; transition_seq: number }>();

    expect(state).not.toBeNull();
    expect(state!.consecutive_failures).toBe(0);
    expect(state!.transition_seq).toBe(0);
  });

  it("refuses a second enabled target for the same component", async () => {
    // The v1 capacity boundary is enforced by a partial unique index, so this is
    // the database refusing rather than a check that a later code path could skip.
    const page = await createPage();
    const component = await createComponent(page.id);

    const first = await callAdmin("/internal/admin/probes", "POST", {
      componentPublicId: component.publicId,
      url: "https://probe.example.com/one",
    });
    expect(first.status).toBe(201);

    const second = await callAdmin("/internal/admin/probes", "POST", {
      componentPublicId: component.publicId,
      url: "https://probe.example.com/two",
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("keeps an impact when the target that measured it is deleted", async () => {
    // Deleting a probe must not erase history: `impact.probe_target_id` is
    // ON DELETE SET NULL precisely so the downtime survives.
    const page = await createPage();
    const component = await createComponent(page.id);

    const created = (await (
      await callAdmin("/internal/admin/probes", "POST", {
        componentPublicId: component.publicId,
        url: "https://probe.example.com/health",
      })
    ).json()) as { publicId: string };

    const targetRow = await env.DB.prepare("SELECT id FROM probe_target WHERE public_id = ?1")
      .bind(created.publicId)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO impact (public_id, component_id, probe_target_id, change_id, severity,
                           start_at, end_at, estimated, opened_by_result_id, created_at, updated_at)
       VALUES ('imp-keep', ?1, ?2, NULL, 'partial_outage', ?3, ?4, 1, NULL, ?3, ?3)`,
    )
      .bind(component.id, targetRow!.id, T0 - 600, T0 - 300)
      .run();

    const deleted = await callAdmin(`/internal/admin/probes/${created.publicId}`, "DELETE");
    expect(deleted.status).toBe(200);

    const impact = await env.DB.prepare("SELECT probe_target_id FROM impact WHERE public_id = 'imp-keep'")
      .first<{ probe_target_id: number | null }>();
    expect(impact).not.toBeNull();
    expect(impact!.probe_target_id).toBeNull();
  });
});

describe("sections", () => {
  it("moves components to the page root when their section is deleted", async () => {
    const page = await createPage();
    const section = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/sections`, "POST", { name: "Core" })
    ).json()) as { publicId: string };

    const sectionRow = await env.DB.prepare("SELECT id FROM section WHERE public_id = ?1")
      .bind(section.publicId)
      .first<{ id: number }>();

    const component = await createComponent(page.id, { sectionId: sectionRow!.id });

    const deleted = await callAdmin(`/internal/admin/sections/${section.publicId}`, "DELETE");
    expect(deleted.status).toBe(200);

    const after = await env.DB.prepare("SELECT section_id FROM component WHERE id = ?1")
      .bind(component.id)
      .first<{ section_id: number | null }>();
    // Losing a component because a grouping label was removed would be a
    // data-loss bug disguised as a cascade.
    expect(after).not.toBeNull();
    expect(after!.section_id).toBeNull();
  });
});

describe("components", () => {
  it("distinguishes an absent section from an explicit null", async () => {
    // Three meanings share one field, and collapsing any two of them breaks a
    // real operation: absent means "leave the grouping alone", null means "move
    // to the page root", a string means "move into that section".
    const page = await createPage();
    const section = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/sections`, "POST", { name: "Core" })
    ).json()) as { publicId: string };
    const sectionRow = await env.DB.prepare("SELECT id FROM section WHERE public_id = ?1")
      .bind(section.publicId)
      .first<{ id: number }>();

    const created = (await (
      await callAdmin(`/internal/admin/pages/${page.slug}/components`, "POST", {
        name: "Grouped",
        sectionPublicId: section.publicId,
      })
    ).json()) as { publicId: string };

    const sectionIdOf = async (): Promise<number | null> => {
      const row = await env.DB.prepare("SELECT section_id FROM component WHERE public_id = ?1")
        .bind(created.publicId)
        .first<{ section_id: number | null }>();
      return row?.section_id ?? null;
    };

    expect(await sectionIdOf()).toBe(sectionRow!.id);

    // Absent: the grouping survives a rename.
    await callAdmin(`/internal/admin/components/${created.publicId}`, "PATCH", { name: "Renamed" });
    expect(await sectionIdOf()).toBe(sectionRow!.id);

    // Explicit null: moved to the page root.
    await callAdmin(`/internal/admin/components/${created.publicId}`, "PATCH", {
      sectionPublicId: null,
    });
    expect(await sectionIdOf()).toBeNull();
  });
});

describe("pages", () => {
  it("lists every page with the counts the admin index shows", async () => {
    const page = await createPage();
    await createComponent(page.id);
    await callAdmin(`/internal/admin/pages/${page.slug}/sections`, "POST", { name: "Core" });

    const response = await callAdmin("/internal/admin/pages", "GET");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      pages: Array<{ slug: string; section_count: number; component_count: number }>;
    };
    const found = body.pages.find((row) => row.slug === page.slug);

    expect(body.ok).toBe(true);
    expect(found).toBeDefined();
    expect(found!.section_count).toBe(1);
    expect(found!.component_count).toBe(1);
  });

  it("creates a page and publishes an empty snapshot for it", async () => {
    const slug = `created-${Date.now().toString(36)}`;
    const response = await callAdmin("/internal/admin/pages", "POST", { slug, name: "Created" });
    expect(response.status).toBe(201);

    // A brand new page is legitimately empty, and that is a real document: the
    // first read must be a KV hit rather than a rebuild that finds nothing.
    const snapshot = (await readKvSnapshot(slug)) as { name: string; components: unknown[] } | null;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.name).toBe("Created");
    expect(snapshot!.components).toEqual([]);

    const version = await env.DB.prepare("SELECT snapshot_version FROM page WHERE slug = ?1")
      .bind(slug)
      .first<{ snapshot_version: number }>();
    expect(version!.snapshot_version).toBe(1);
  });

  it("rejects a duplicate slug as bad input rather than a server error", async () => {
    const page = await createPage();

    const response = await callAdmin("/internal/admin/pages", "POST", {
      slug: page.slug,
      name: "Collision",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { field: string | null };
    expect(body.field).toBe("slug");
  });

  it("rejects a slug that is not a URL-safe word sequence", async () => {
    const response = await callAdmin("/internal/admin/pages", "POST", {
      slug: "Not A Slug",
      name: "Bad",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { field: string | null };
    expect(body.field).toBe("slug");
  });

  it("renames a page and advances the version", async () => {
    const page = await createPage();
    const before = await pageVersion(page.id);

    const response = await callAdmin(`/internal/admin/pages/${page.slug}`, "PATCH", {
      name: "Renamed Page",
    });

    expect(response.status).toBe(200);
    expect(await pageVersion(page.id)).toBe(before + 1);
    const snapshot = (await readKvSnapshot(page.slug)) as { name: string };
    expect(snapshot.name).toBe("Renamed Page");
  });
});

describe("the send budget", () => {
  it("reports today's usage against the ceiling the code enforces", async () => {
    const response = await callAdmin("/internal/admin/email-quota", "GET");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      day: string;
      sent: number;
      limit: number;
      remaining: number;
    };

    expect(body.ok).toBe(true);
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.sent).toBeGreaterThanOrEqual(0);
    expect(body.limit).toBe(2000);
    expect(body.remaining).toBe(body.limit - body.sent);
  });

  it("counts a day that has not sent anything as zero rather than failing", async () => {
    // The row is created on the first send, so a fresh day has no row at all.
    // Reporting an error there would make the panel look broken every midnight.
    await env.DB.prepare("DELETE FROM email_quota").run();

    const response = await callAdmin("/internal/admin/email-quota", "GET");
    const body = (await response.json()) as { sent: number; remaining: number };

    expect(response.status).toBe(200);
    expect(body.sent).toBe(0);
    expect(body.remaining).toBe(2000);
  });
});
