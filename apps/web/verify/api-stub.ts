/**
 * A stand-in for `allclear-api`, for looking at the status page without a
 * database.
 *
 * The web Worker reaches the API over a Service Binding, so a page with any
 * content on it needs *a* worker by that name. Standing one up here — rather than
 * running the real API with a seeded D1 — makes the page's rendering independent
 * of the schema, the migrations and the probe state machine, which is what you
 * want when the thing being checked is the layout and the wording.
 *
 * The snapshot below is deliberately awkward. It has all three monitoring
 * verdicts (a probe that is fine, a probe that is stale, and no probe at all), an
 * ongoing incident with a timeline, a finished maintenance window, a component
 * that did not exist for the whole window, and two bad days in the middle of an
 * otherwise clean strip. A fixture where every component is green proves almost
 * nothing about the page, because the interesting branches never run.
 *
 * This is a fixture, not a fallback. It is wired up only by
 * `verify/vite.config.verify.ts`; the real `vite.config.ts` binds to the deployed
 * `allclear-api`.
 */

import type { ReadResult, Snapshot, SnapshotDay } from "@allclear/shared";

import { handleAdminRequest } from "./admin-stub";

const DAY = 86_400;

/**
 * Ninety days of history, with two outages and a hole in the middle.
 *
 * The hole is the point: `daily_uptime` has no row for a day that was not
 * measured, and the page has to draw that differently from a day that measured
 * zero uptime.
 */
function days(
  todayStart: number,
  fromOffset: number,
  outageOffsets: number[],
  gapOffsets: number[],
): SnapshotDay[] {
  const out: SnapshotDay[] = [];
  for (let offset = fromOffset; offset >= 0; offset -= 1) {
    const day = new Date((todayStart - offset * DAY) * 1000).toISOString().slice(0, 10);
    if (gapOffsets.includes(offset)) continue;
    const outage = outageOffsets.includes(offset);
    out.push({
      day,
      uptime: outage ? 0.41 : 1,
      status: outage ? "full_outage" : "operational",
      coveredSeconds: 86_400,
      unknownSeconds: 0,
    });
  }
  return out;
}

/**
 * Build the fixture against a supplied clock.
 *
 * The clock is a parameter rather than a module constant on purpose. The page
 * decides "is this probe stale?" by comparing `lastProbeAt` against *its own*
 * reading of the clock, so a fixture pinned at module scope goes stale a few
 * minutes after the isolate starts — and then it silently stops exercising the
 * `operational` branch it was written to exercise, which is the one failure mode
 * a fixture must not have. Rebuilding per request costs nothing here.
 */
function buildFixture(NOW: number): ReadResult {
  const TODAY_START = Math.floor(NOW / DAY) * DAY;

  const snapshot: Snapshot = {
    slug: "fixture",
    name: "Fixture Service",
    snapshotVersion: 42,
    generatedAt: NOW - 10,
    historyComputedAt: NOW - 240,
    sourceUpdatedAt: NOW - 600,
    sections: [
      {
        publicId: "sec-1",
        name: "Public surface",
        description: "Everything a visitor talks to directly.",
        orderId: 1,
        componentPublicIds: ["cmp-api", "cmp-web"],
      },
    ],
    components: [
      {
        publicId: "cmp-api",
        name: "API",
        description: "The JSON API and the service binding behind it.",
        sectionPublicId: "sec-1",
        orderId: 1,
        availableSince: NOW - 300 * DAY,
        probe: { targetPublicId: "prb-1", lastProbeAt: NOW - 45, ok: true },
        statusFreshnessMax: 180,
        impacts: [],
        maintenances: [],
        changePublicIds: [],
        days: days(TODAY_START, 89, [12, 13], []),
      },
      {
        publicId: "cmp-web",
        name: "Website",
        description: null,
        sectionPublicId: "sec-1",
        orderId: 2,
        availableSince: NOW - 300 * DAY,
        // An open impact: the probe is fresh and failing, and an incident was
        // classified, so the status is a fault rather than "unclassified".
        probe: { targetPublicId: "prb-2", lastProbeAt: NOW - 20, ok: false },
        statusFreshnessMax: 180,
        impacts: [{ severity: "full_outage", startsAt: NOW - 3_600, endsAt: null }],
        maintenances: [],
        changePublicIds: ["chg-1"],
        // A gap between offsets 40 and 36: those days are absent entirely.
        days: days(TODAY_START, 89, [0], [40, 39, 38, 37, 36]),
      },
      {
        publicId: "cmp-mobile",
        name: "Mobile web",
        description: "The same site at a narrow viewport.",
        sectionPublicId: null,
        orderId: 3,
        availableSince: NOW - 120 * DAY,
        // No probe target at all: uncovered, so `unknown` rather than
        // `operational`.
        probe: null,
        statusFreshnessMax: 180,
        impacts: [],
        maintenances: [],
        changePublicIds: [],
        days: days(TODAY_START, 89, [], []),
      },
      {
        publicId: "cmp-downloads",
        name: "Download server",
        description: "Static release artifacts.",
        sectionPublicId: null,
        orderId: 4,
        availableSince: NOW - 200 * DAY,
        // A probe whose result is older than the freshness budget.
        probe: { targetPublicId: "prb-4", lastProbeAt: NOW - 900, ok: true },
        statusFreshnessMax: 180,
        impacts: [],
        maintenances: [
          { status: "scheduled", startsAt: NOW + 4 * 3_600, endsAt: NOW + 6 * 3_600 },
        ],
        changePublicIds: ["chg-2"],
        days: days(TODAY_START, 89, [], []),
      },
    ],
    changes: [
      {
        publicId: "chg-1",
        kind: "incident",
        status: "in_progress",
        title: "Website returning 502 for some visitors",
        body: "A subset of requests is failing at the edge. We are rolling back the last deploy.",
        severity: "full_outage",
        startsAt: NOW - 3_600,
        endsAt: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        componentPublicIds: ["cmp-web"],
        updates: [
          {
            publicId: "upd-1",
            status: "in_progress",
            body: "Rollback started. Error rate is falling but not back to baseline.",
            createdAt: NOW - 1_800,
            componentPublicIds: ["cmp-web"],
          },
          {
            publicId: "upd-2",
            status: "verifying",
            body: "Rollback complete. Watching the error rate before we call this resolved.",
            createdAt: NOW - 240,
            componentPublicIds: ["cmp-web"],
          },
        ],
      },
      {
        publicId: "chg-2",
        kind: "maintenance",
        status: "scheduled",
        title: "Scheduled storage migration",
        body: "Downloads will be briefly unavailable while the bucket is migrated.",
        severity: "none",
        startsAt: NOW + 4 * 3_600,
        endsAt: NOW + 6 * 3_600,
        scheduledStartAt: NOW + 4 * 3_600,
        scheduledEndAt: NOW + 6 * 3_600,
        componentPublicIds: ["cmp-downloads"],
        updates: [],
      },
      {
        publicId: "chg-3",
        kind: "incident",
        status: "resolved",
        title: "Elevated API latency",
        body: null,
        severity: "degraded_performance",
        startsAt: NOW - 8 * DAY,
        endsAt: NOW - 8 * DAY + 5_400,
        scheduledStartAt: null,
        scheduledEndAt: null,
        componentPublicIds: ["cmp-api"],
        updates: [
          {
            publicId: "upd-3",
            status: "resolved",
            body: "Latency is back to normal.",
            createdAt: NOW - 8 * DAY + 5_400,
            componentPublicIds: [],
          },
        ],
      },
    ],
  };

  return {
    snapshot,
    source: "d1-live",
    stale: false,
    ageSeconds: 10,
    aged: false,
    errors: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function html(title: string, message: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    // The console's write surface lives in its own module. Asked first, and it
    // answers only for `/internal/admin*`, so it cannot shadow a public route.
    const admin = await handleAdminRequest(request);
    if (admin !== null) return admin;

    // Separate slugs let the public page exercise provenance without forwarding
    // test-only query parameters through the real API client.
    const fixture = pathname.match(/^\/api\/status\/(fixture(?:-(?:cached|fallback|legacy|history-unknown|unavailable))?)(?:\/snapshot\.json)?$/);
    if (fixture) {
      const slug = fixture[1];
      const result = buildFixture(Math.floor(Date.now() / 1000));
      result.snapshot!.slug = slug;
      if (slug === "fixture-cached") result.source = "cache-live";
      if (slug === "fixture-fallback") {
        result.source = "kv-last";
        result.stale = true;
        result.ageSeconds = 600;
        result.aged = true;
        result.snapshot!.generatedAt -= 590;
        result.snapshot!.historyComputedAt = result.snapshot!.generatedAt - 300;
        for (const component of result.snapshot!.components) {
          if (component.probe) component.probe.lastProbeAt -= 600;
        }
      }
      if (slug === "fixture-legacy") delete result.snapshot!.historyComputedAt;
      if (slug === "fixture-history-unknown") result.snapshot!.historyComputedAt = null;
      if (slug === "fixture-unavailable") {
        result.snapshot = null;
        result.source = "none";
        result.stale = true;
        result.ageSeconds = null;
        result.aged = false;
      }
      return json(result, result.snapshot === null ? 503 : 200);
    }
    if (pathname === "/api/status/fixture/subscribe" && request.method === "POST") {
      return json({ ok: true }, 202);
    }
    if (pathname === "/api/subscribe/confirm") {
      return html("Subscription confirmed", "You will receive an email when this page changes.");
    }
    if (pathname.startsWith("/u/")) {
      if (request.method === "POST") {
        return html("Unsubscribed", "You will not receive further updates from this page.");
      }
      return html(
        "Unsubscribe",
        'Unsubscribe fixture@example.com from updates? <form method="post"><button type="submit">Yes, unsubscribe</button></form>',
      );
    }
    if (pathname === "/health") return json({ ok: true, service: "allclear-api-fixture" });

    return json({ error: "not_found", pathname }, 404);
  },
};
