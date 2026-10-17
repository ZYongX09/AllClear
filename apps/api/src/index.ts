import { Hono } from "hono";

import { buildAtomFeed } from "@allclear/shared";

import { createAdminRoutes } from "./admin/routes";
import { runScheduledMaintenance } from "./lib/maintenance";
import { MAX_ENABLED_TARGETS, runProbes } from "./probe/run";
import { bumpSnapshotVersion, readSnapshot } from "./snapshot";
import { refreshLiveSummary, publishCheckpoint, repairAndPublishSnapshots } from "./publication";
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
    const now = Math.floor(Date.now() / 1000);
    const page = await c.env.DB.prepare("SELECT id FROM page WHERE slug=?1").bind(slug).first<{ id: number }>();
    if (!page) return c.json({ ok: false, error: "page not found" }, 404);
    await bumpSnapshotVersion(c.env.DB, page.id, now);
    const snapshot = await refreshLiveSummary(c.env.DB, slug, now);
    const publication = await publishCheckpoint(c.env.DB, c.env.SNAPSHOT_KV, slug, now);
    return c.json({
      ok: true,
      snapshotVersion: snapshot.snapshotVersion,
      components: snapshot.components.length,
      publication,
    });
  } catch (error) {
    return c.json({ ok: false, error: message(error) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Public read
// ---------------------------------------------------------------------------

/**
 * Public read API. Live cache / D1 first, then explicit eventual fallbacks.
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
 * The same document at a conventional `.json` URL, without HTTP caching.
 *
 * Deliberately the same `ReadResult` shape as `/api/status/:slug` rather than a
 * bare snapshot: two shapes for one document is two contracts to keep in sync,
 * and the stale/source fields are exactly what a machine consumer needs. The
 * cache header is safe because a stale document is still served with `stale:
 * true` rather than silently passed off as current.
 */
app.get("/api/status/:slug/snapshot.json", async (c) => {
  const result = await readSnapshot(c.env.DB, c.env.SNAPSHOT_KV, c.req.param("slug"));
  c.header("Cache-Control", "no-store");
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

/** Probes, persisted maintenance cadence, then D1 revision repair/checkpoints. */
export async function scheduledPass(env: Env, now: number): Promise<void> {
  let probeSummary: Awaited<ReturnType<typeof runProbes>> | null = null;
  try {
    probeSummary = await runProbes(env.DB, { now, maxTargetsPerRun: maxTargetsPerRun(env) });
  } catch (error) { console.error("probe run failed", message(error)); }
  let historyChanged = false;
  try {
    const maintenance = await runScheduledMaintenance(env.DB, now, probeSummary?.transitionedComponentIds ?? []);
    historyChanged = maintenance.historyChanged;
    for (const error of maintenance.errors) console.error("scheduled maintenance failed", error);
  } catch (error) { console.error("scheduled maintenance failed", message(error)); }
  try {
    await repairAndPublishSnapshots(env.DB, env.SNAPSHOT_KV, now, historyChanged);
  } catch (error) { console.error("snapshot repair failed", message(error)); }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await scheduledPass(env, Math.floor(Date.now() / 1000));
  },
};
