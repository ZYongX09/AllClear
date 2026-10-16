import { Hono } from "hono";

import { buildAtomFeed } from "@allclear/shared";

import { createAdminRoutes } from "./admin/routes";
import { pruneRateLimits } from "./lib/rate-limit";
import { applyRetention } from "./lib/retention";
import { recomputeAllRecentDays, recomputeRecentDays } from "./lib/uptime-recompute";
import { MAX_ENABLED_TARGETS, runProbes } from "./probe/run";
import {
  buildSnapshot,
  bumpSnapshotVersion,
  freshKey,
  readSnapshot,
  writeSnapshot,
  type Snapshot,
} from "./snapshot";
import { createSubscribeRoutes } from "./subscribe/routes";

const app = new Hono<{ Bindings: Env }>();

/**
 * Liveness probe that touches no binding. This exists so that "the Worker is
 * up" and "the database is up" are separable signals — a health check that
 * queries D1 cannot tell you which of the two broke.
 */
app.get("/health", (c) => c.json({ ok: true, service: "allclear-api" }));

/**
 * Internal namespace.
 *
 * Two independent conditions must hold: the request has to arrive over the
 * Service Binding (the Worker has no public URL — see `workersDev: false` in
 * cloudflare.config.ts), *and* it has to present the shared key.
 *
 * The second check matters because reachability is not authorisation. If this
 * Worker ever gains a public route, or another Worker is added to the account,
 * "the request came from the expected place" would silently stop being true.
 */
app.use("/internal/*", async (c, next) => {
  const expected = c.env.INTERNAL_KEY ?? "";
  if (expected === "") {
    return c.json({ error: "internal_key_not_configured" }, 503);
  }
  const provided = c.req.header("X-Internal-Key") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

/** The admin write surface. Thin handlers; the logic is in `admin/service.ts`. */
app.route("/internal/admin", createAdminRoutes());

/**
 * Rebuild a snapshot and repopulate both KV keys.
 *
 * This is the write path that the public read path depends on: it is what
 * maintains `snapshot:<slug>:last`, without which the documented fallback would
 * have nothing to fall back to.
 */
app.post("/internal/snapshot/:slug/rebuild", async (c) => {
  const slug = c.req.param("slug");
  try {
    const snapshot = await buildSnapshot(c.env.DB, slug);
    await writeSnapshot(c.env.SNAPSHOT_KV, snapshot);
    return c.json({
      ok: true,
      snapshotVersion: snapshot.snapshotVersion,
      components: snapshot.components.length,
    });
  } catch (error) {
    return c.json({ ok: false, error: message(error) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Public read
// ---------------------------------------------------------------------------

/**
 * Public read API. Serves from KV and never requires D1 to be reachable.
 *
 * Returns 503 (not 200-with-empty-body) when nothing can be served, so that a
 * caller cannot mistake "we have no data" for "everything is fine".
 *
 * The body is the whole `ReadResult`, not just the snapshot: `source`,
 * `stale`, `ageSeconds` and `errors` are what let a caller tell "this page has
 * no components" apart from "we could not reach the database". Stripping them
 * would leave the honest 503 as the only signal, and a fallback snapshot served
 * with HTTP 200 would be indistinguishable from a current one.
 */
app.get("/api/status/:slug", async (c) => {
  const result = await readSnapshot(c.env.DB, c.env.SNAPSHOT_KV, c.req.param("slug"));
  c.header("Cache-Control", "no-store");
  return c.json(result, result.snapshot ? 200 : 503);
});

/**
 * The same document at a conventional `.json` URL, with a short shared cache.
 *
 * Deliberately the same `ReadResult` shape as `/api/status/:slug` rather than a
 * bare snapshot: two shapes for one document is two contracts to keep in sync,
 * and the stale/source fields are exactly what a machine consumer needs. The
 * cache header is safe because a stale document is still served with `stale:
 * true` rather than silently passed off as current.
 */
app.get("/api/status/:slug/snapshot.json", async (c) => {
  const result = await readSnapshot(c.env.DB, c.env.SNAPSHOT_KV, c.req.param("slug"));
  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
  return c.json(result, result.snapshot ? 200 : 503);
});

/** Atom feed. Same source as the JSON, so the two cannot disagree. */
app.get("/api/status/:slug/feed.xml", async (c) => {
  const slug = c.req.param("slug");
  const result = await readSnapshot(c.env.DB, c.env.SNAPSHOT_KV, slug);
  if (!result.snapshot) {
    c.header("Cache-Control", "no-store");
    return c.text("status feed unavailable", 503);
  }

  const origin = (c.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "") || new URL(c.req.url).origin;
  const body = buildAtomFeed(result.snapshot, {
    selfUrl: `${origin}/api/status/${slug}/feed.xml`,
    statusUrl: `${origin}/status/${slug}`,
  });

  c.header("Content-Type", "application/atom+xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=60");
  return c.body(body, 200);
});

/**
 * Subscribe, confirm and unsubscribe.
 *
 * Mounted at the root because it owns three top-level paths —
 * `/api/status/:slug/subscribe`, `/api/subscribe/confirm` and `/u/:token`. The
 * unsubscribe link in a delivered email has to be a stable, memorable URL, and
 * `/u/<token>` is the shortest one that can carry the capability.
 */
app.route("/", createSubscribeRoutes());

// ---------------------------------------------------------------------------
// Scheduled work
// ---------------------------------------------------------------------------

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Targets per cron tick. Clamped to the plan's v1 capacity boundary. */
function maxTargetsPerRun(env: Env): number {
  const raw = Number.parseInt(env.MAX_TARGETS_PER_RUN ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return MAX_ENABLED_TARGETS;
  return Math.min(raw, MAX_ENABLED_TARGETS);
}

/**
 * Republish the snapshots of pages whose public output changed.
 *
 * The version is advanced here as well as rebuilt, for the same reason the admin
 * path does both: `page.snapshot_version` is the counter the cron repair pass
 * compares against the KV payload, so a probe-driven change that advanced the
 * document without advancing the version would make that comparison report
 * "in sync" while KV held something older.
 */
async function republishPages(env: Env, pageIds: number[], now: number): Promise<void> {
  if (pageIds.length === 0) return;

  const placeholders = pageIds.map((_, index) => `?${index + 1}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, slug FROM page WHERE id IN (${placeholders})`,
  )
    .bind(...pageIds)
    .all<{ id: number; slug: string }>();

  for (const page of results) {
    try {
      await bumpSnapshotVersion(env.DB, page.id, now);
      const snapshot = await buildSnapshot(env.DB, page.slug, { now });
      await writeSnapshot(env.SNAPSHOT_KV, snapshot);
    } catch (error) {
      console.error("snapshot republish failed", { slug: page.slug, error: message(error) });
    }
  }
}

/**
 * Cron repair pass.
 *
 * The plan's position is that a scheduled job must not be the mechanism that
 * *publishes* changes — admin writes rebuild their snapshot synchronously, so a
 * reader never waits up to a minute for a cron tick. What cron does is repair:
 * find snapshots whose embedded `snapshotVersion` has drifted from D1 and
 * rebuild those.
 *
 * Note the failure direction. If D1 is unreachable the version comparison
 * cannot be performed, and the handler returns without touching KV. Cron must
 * never "repair" a snapshot by replacing it with nothing.
 */
async function repairSnapshots(env: Env): Promise<void> {
  let pages: Array<{ slug: string; snapshot_version: number }>;
  try {
    const { results } = await env.DB
      .prepare("SELECT slug, snapshot_version FROM page")
      .all<{ slug: string; snapshot_version: number }>();
    pages = results;
  } catch (error) {
    console.warn("snapshot repair skipped: D1 unreachable", message(error));
    return;
  }

  for (const page of pages) {
    try {
      const raw = await env.SNAPSHOT_KV.get(freshKey(page.slug));
      if (raw !== null) {
        const cached = JSON.parse(raw) as Snapshot;
        if (cached.snapshotVersion === page.snapshot_version) continue;
      }
      const rebuilt = await buildSnapshot(env.DB, page.slug);
      await writeSnapshot(env.SNAPSHOT_KV, rebuilt);
      console.log("snapshot repaired", { slug: page.slug, version: rebuilt.snapshotVersion });
    } catch (error) {
      console.error("snapshot repair failed", { slug: page.slug, error: message(error) });
    }
  }
}

/**
 * One scheduled pass.
 *
 * Every step is isolated: a failure in one is logged and the rest still run. The
 * steps are ordered by what depends on what — probes first because they produce
 * the impacts the rollups read, and the rollups before retention because
 * retention deletes the raw observations those rollups are computed from.
 *
 * The full recompute is hourly rather than per-tick. It exists to finalise days
 * that passed quietly, and running it every minute would recompute two days of
 * every component sixty times an hour to reach the same answer. Applied probe
 * observations still recompute their own components before publication, so the
 * snapshot includes their latest coverage even without an impact transition.
 */
async function scheduledPass(env: Env, now: number): Promise<void> {
  let probeSummary: Awaited<ReturnType<typeof runProbes>> | null = null;

  try {
    probeSummary = await runProbes(env.DB, { now, maxTargetsPerRun: maxTargetsPerRun(env) });
    if (
      probeSummary.due > 0 ||
      probeSummary.skippedConfiguration > 0 ||
      probeSummary.anomalies.length > 0
    ) {
      console.log("probe run", probeSummary);
    }
  } catch (error) {
    console.error("probe run failed", message(error));
  }

  if (probeSummary) {
    for (const componentId of probeSummary.affectedComponentIds) {
      try {
        await recomputeRecentDays(env.DB, componentId, now);
      } catch (error) {
        console.error("uptime recompute failed", { componentId, error: message(error) });
      }
    }
    try {
      // Every committed observation changes public probe evidence and coverage,
      // even when no impact opens or closes. Publish after the rollups above.
      await republishPages(env, probeSummary.affectedPageIds, now);
    } catch (error) {
      console.error("republish after probe run failed", message(error));
    }
  }

  if (now % 3600 < 60) {
    try {
      const count = await recomputeAllRecentDays(env.DB, now);
      console.log("hourly uptime sweep", { components: count });
    } catch (error) {
      console.error("hourly uptime sweep failed", message(error));
    }
  }

  try {
    const retention = await applyRetention(env.DB, now);
    if (retention.deleted > 0 || retention.skippedDeletionReason !== undefined) {
      console.log("retention pass", retention);
    }
  } catch (error) {
    console.error("retention pass failed", message(error));
  }

  try {
    await pruneRateLimits(env.DB, now);
  } catch (error) {
    console.error("rate limit prune failed", message(error));
  }

  try {
    await repairSnapshots(env);
  } catch (error) {
    console.error("snapshot repair pass failed", message(error));
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await scheduledPass(env, Math.floor(Date.now() / 1000));
  },
};
