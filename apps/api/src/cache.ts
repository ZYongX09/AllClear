/** Separate colo-local keys: 30s live hot path and 1h explicitly stale hedge.
 * Neither replicates between colos. Cache failures degrade to D1/KV; timestamps
 * inside a snapshot are never renewed when caching it.
 */

import type { Snapshot } from "@allclear/shared";

/**
 * Where cached documents live. The host is never resolved — the Cache API keys
 * on the URL string — so this is a namespace, not an address.
 */
const CACHE_ORIGIN = "https://allclear.internal";

/**
 * How long a local copy stays usable.
 *
 * Every write refreshes it, so this only governs how long the hedge survives
 * after writes stop. An hour is far longer than a KV blip and short enough that
 * a document cannot outlive a content change by a working day.
 */
export const CACHE_TTL_SECONDS = 3600;

function defaultCache(): Cache | null {
  const globalCaches = (globalThis as { caches?: { default?: Cache } }).caches;
  return globalCaches?.default ?? null;
}

export function snapshotCacheRequest(slug: string): Request {
  return new Request(`${CACHE_ORIGIN}/snapshot/${encodeURIComponent(slug)}`);
}

/**
 * Read the colo-local copy, if this data centre has one that is still fresh.
 *
 * Returns `null` for every failure — a miss, an absent API, a malformed body.
 * The caller cannot act differently on those cases, and treating them as one is
 * what keeps this from turning into a second error channel.
 */
export async function readSnapshotFromCache(slug: string): Promise<Snapshot | null> {
  const cache = defaultCache();
  if (cache === null) return null;

  try {
    const hit = await cache.match(snapshotCacheRequest(slug));
    if (!hit) return null;
    const parsed = JSON.parse(await hit.text()) as Partial<Snapshot> | null;
    return parsed && typeof parsed.slug === "string" && typeof parsed.generatedAt === "number" &&
      Array.isArray(parsed.components) && Array.isArray(parsed.sections) && Array.isArray(parsed.changes) ? parsed as Snapshot : null;
  } catch {
    return null;
  }
}

/**
 * Store the document this data centre just assembled.
 *
 * `max-age` is what bounds the staleness of a later hit, so it is set explicitly
 * rather than left to a default. The response is constructed here instead of
 * reusing a read response because `cache.put` inspects the headers of what it is
 * given: a response carrying `Set-Cookie` or `no-store` would be refused, and a
 * response without `max-age` would be stored indefinitely.
 */
export async function writeSnapshotToCache(snapshot: Snapshot): Promise<void> {
  const cache = defaultCache();
  if (cache === null) return;

  try {
    await cache.put(
      snapshotCacheRequest(snapshot.slug),
      new Response(JSON.stringify(snapshot), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // An unwritable cache is not a write failure. The KV write is the one that
    // matters and it has already happened.
  }
}

export const LIVE_CACHE_TTL_SECONDS = 30;

export function liveSnapshotCacheRequest(slug: string): Request {
  return new Request(`${CACHE_ORIGIN}/snapshot-live/${encodeURIComponent(slug)}`);
}

export async function readLiveSnapshotFromCache(slug: string, now: number): Promise<Snapshot | null> {
  try {
    const hit = await defaultCache()?.match(liveSnapshotCacheRequest(slug));
    if (!hit) return null;
    const cachedAt = Number(hit.headers.get("X-Allclear-Cached-At"));
    if (!Number.isFinite(cachedAt) || now < cachedAt || now - cachedAt >= LIVE_CACHE_TTL_SECONDS) return null;
    const parsed = JSON.parse(await hit.text()) as Partial<Snapshot> | null;
    return parsed && typeof parsed.slug === "string" && typeof parsed.generatedAt === "number" &&
      Array.isArray(parsed.components) && Array.isArray(parsed.sections) && Array.isArray(parsed.changes) ? parsed as Snapshot : null;
  } catch { return null; }
}

export async function writeLiveSnapshotToCache(snapshot: Snapshot, now: number): Promise<void> {
  try {
    await defaultCache()?.put(liveSnapshotCacheRequest(snapshot.slug), new Response(JSON.stringify(snapshot), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${LIVE_CACHE_TTL_SECONDS}`, "X-Allclear-Cached-At": String(now) },
    }));
  } catch { /* Optimisation only. */ }
}

/** Drop the local copy. Used by the admin rebuild path so a repair is visible. */
export async function purgeSnapshotFromCache(slug: string): Promise<void> {
  const cache = defaultCache();
  if (cache === null) return;
  try {
    await Promise.all([cache.delete(snapshotCacheRequest(slug)), cache.delete(liveSnapshotCacheRequest(slug))]);
  } catch {
    // Nothing to do: the entry expires on its own.
  }
}
