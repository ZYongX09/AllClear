import { describe, expect, it } from "vitest";

import { CACHE_TTL_SECONDS, readSnapshotFromCache, writeSnapshotToCache } from "../src/cache";
import { buildSnapshot, readSnapshot, writeSnapshot } from "../src/snapshot";
import { testEnv as env } from "./env";
import { createComponent, createPage, T0 } from "./helpers";

/**
 * The colo-local cache layer.
 *
 * The behaviour under test is mostly the *placement* of the layer, not the Cache
 * API itself: a layer that answers when it should not is worse than no layer, and
 * the two ways to get that wrong are shadowing KV and shadowing the D1 rebuild.
 * Both are asserted here directly rather than inferred from the source order.
 *
 * The Cache API is real in this runtime — `caches.default` exists and a
 * put/match round-trip returns the body — so these tests exercise the actual
 * layer rather than a stub. What they cannot exercise is the part that is
 * genuinely colo-local in production: here every test shares one data centre, so
 * "a different data centre does not see this copy" is a property of the design
 * that this suite cannot observe. See docs/spec/snapshot.md.
 */

/**
 * A KV namespace that always fails.
 *
 * Failing KV alone does not reach the cache step — the chain simply rebuilds
 * from D1, which is the correct answer and is asserted below. The cache is only
 * reached when KV *and* D1 are both unavailable, so the tests that exercise it
 * pass this together with `brokenDb`.
 */
function unreachableKv(): KVNamespace {
  const fail = (): never => {
    throw new Error("kv unreachable");
  };
  return {
    get: fail,
    put: fail,
    delete: fail,
    list: fail,
    getWithMetadata: fail,
  } as unknown as KVNamespace;
}

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

describe("the colo-local cache", () => {
  it("is populated by the same call that writes KV", async () => {
    const page = await createPage();
    await createComponent(page.id);
    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });

    await writeSnapshot(env.SNAPSHOT_KV, snapshot);

    const cached = await readSnapshotFromCache(page.slug);
    expect(cached?.slug).toBe(page.slug);
    expect(cached?.snapshotVersion).toBe(snapshot.snapshotVersion);
  });

  it("never lets fallback KV shadow authoritative D1", async () => {
    const page = await createPage();
    await createComponent(page.id);

    const older = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshotToCache({ ...older, name: "stale name from the cache" });
    await env.SNAPSHOT_KV.put(`snapshot:${page.slug}`, JSON.stringify({ ...older, name: "fresh from KV" }));

    const result = await readSnapshot(env.DB, env.SNAPSHOT_KV, page.slug, { now: T0 });

    expect(result.source).toBe("d1-rebuild");
    expect(result.snapshot?.name).toBe("Test Page");
  });

  it("never shadows a D1 rebuild, so a KV miss still returns current data", async () => {
    // The trade this pins: on a KV miss the chain rebuilds from D1 rather than
    // serving a locally cached document that could be up to CACHE_TTL_SECONDS
    // old. Freshness wins on the path that is supposed to be the good one.
    const page = await createPage();
    await createComponent(page.id);

    const cached = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshotToCache({ ...cached, name: "stale name from the cache" });
    await env.SNAPSHOT_KV.delete(`snapshot:${page.slug}`);

    const result = await readSnapshot(env.DB, env.SNAPSHOT_KV, page.slug, { now: T0 + 30 });

    expect(result.source).toBe("d1-rebuild");
    expect(result.snapshot?.name).toBe("Test Page");
    expect(result.snapshot?.name).not.toBe("stale name from the cache");
  });

  it("answers when KV and D1 are both unavailable, and says the read is stale", async () => {
    const page = await createPage();
    await createComponent(page.id);
    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshot(env.SNAPSHOT_KV, snapshot);

    const result = await readSnapshot(brokenDb(), unreachableKv(), page.slug, { now: T0 + 120 });

    expect(result.source).toBe("cache");
    expect(result.stale).toBe(true);
    expect(result.snapshot?.slug).toBe(page.slug);
    // All three earlier steps are reported, because all three were tried.
    expect(result.errors.some((entry) => entry.includes("kv-fresh"))).toBe(true);
    expect(result.errors.some((entry) => entry.includes("d1-rebuild"))).toBe(true);
    expect(result.errors.some((entry) => entry.includes("kv-last"))).toBe(true);
  });

  it("still rebuilds from D1 when only KV is unreachable", async () => {
    // Pins that the cache does not intercept the D1 path: failing KV alone must
    // produce current data, not a local copy.
    const page = await createPage();
    await createComponent(page.id);
    const snapshot = await buildSnapshot(env.DB, page.slug, { now: T0 });
    await writeSnapshotToCache({ ...snapshot, name: "stale name from the cache" });

    const result = await readSnapshot(env.DB, unreachableKv(), page.slug, { now: T0 + 30 });

    expect(result.source).toBe("d1-rebuild");
    expect(result.snapshot?.name).toBe("Test Page");
  });

  it("reports nothing to serve when neither KV nor the local copy has anything", async () => {
    const page = await createPage();

    const result = await readSnapshot(brokenDb(), unreachableKv(), page.slug, { now: T0 });

    expect(result.source).toBe("none");
    expect(result.snapshot).toBeNull();
    expect(result.stale).toBe(true);
  });

  it("bounds how long a local copy is served, rather than keeping it forever", () => {
    // The TTL is what stops the hedge from outliving the content change it
    // missed. Asserted as a number rather than by advancing a clock, because the
    // expiry is enforced by the Cache API's own `max-age`, not by this code — a
    // test that waited an hour would be testing the runtime, not the design.
    expect(CACHE_TTL_SECONDS).toBeGreaterThan(0);
    expect(CACHE_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });
});
