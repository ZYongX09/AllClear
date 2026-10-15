import { Hono } from "hono";
import {
  buildSnapshot,
  freshKey,
  readSnapshot,
  writeSnapshot,
  type Snapshot,
} from "./snapshot";

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

/** Round-trip check used by M0 to prove the Service Binding works. */
app.get("/internal/echo", (c) =>
  c.json({
    ok: true,
    reachedVia: "service-binding",
    at: Math.floor(Date.now() / 1000),
  }),
);

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

/**
 * Public read API. Serves from KV and never requires D1 to be reachable.
 *
 * Returns 503 (not 200-with-empty-body) when nothing can be served, so that a
 * caller cannot mistake "we have no data" for "everything is fine".
 */
app.get("/api/status/:slug", async (c) => {
  const slug = c.req.param("slug");
  const result = await readSnapshot(maybeBrokenDb(c.env), c.env.SNAPSHOT_KV, slug);
  return c.json(result, result.snapshot ? 200 : 503);
});

/**
 * M0 scaffolding, not part of the design.
 *
 * Returning a stand-in whose every statement throws is a blunt instrument, and
 * that is the point: it reproduces a D1 outage rather than a single bad query,
 * so the read chain's fallback is exercised for real instead of being reasoned
 * about. The value must match exactly, so the failure cannot be triggered by an
 * unset or unrelated value. Remove this and its caller in M1.
 */
function maybeBrokenDb(env: Env): D1Database {
  // `wrangler types` narrows the var to the literal currently in wrangler.jsonc,
  // so it is widened here before comparing against the failure value.
  const mode: string = env.M0_SIMULATE_D1_FAILURE;
  if (mode !== "d1_read_failure") return env.DB;
  const fail = () => {
    throw new Error("M0: simulated D1 read failure");
  };
  return {
    prepare: fail,
    batch: fail,
    exec: fail,
    dump: fail,
    withSession: fail,
  } as unknown as D1Database;
}

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

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await repairSnapshots(env);
  },
};
