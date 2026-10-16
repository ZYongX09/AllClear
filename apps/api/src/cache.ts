/**
 * The colo-local snapshot cache.
 *
 * ## What failure this layer covers
 *
 * It is the last step of the read chain, reached only when KV could not answer
 * *and* D1 could not rebuild. That placement is the whole design, so it is worth
 * stating why the other two obvious placements were rejected.
 *
 * Placing it before the D1 rebuild would save a read subrequest on every KV miss,
 * which is a real saving. It was rejected because it makes healthy reads staler:
 * on a KV miss the chain would serve a locally cached document up to
 * `CACHE_TTL_SECONDS` old instead of rebuilding current data from D1, and every
 * status page read is a request for the *current* state. Trading freshness for
 * subrequests is the wrong trade on the path that is supposed to be the good one.
 *
 * Placing it beside `snapshot:<slug>:last` was also rejected, because it does not
 * cover a failure that `:last` does not already cover. `:last` is written by the
 * same call that writes the fresh key and is never expired, so it handles "D1 is
 * down" completely — and it is in KV, which is exactly what this layer is not.
 *
 * So the role is: **`kv-last` covers D1 being unavailable; this covers KV being
 * unavailable.** They are different failures and neither hedge substitutes for
 * the other. A data centre that wrote or read a page recently still has it when
 * KV cannot be reached at all.
 *
 * ## The trade, stated
 *
 * A hit here is reported as `source: "cache"` with `stale: true`, because the
 * read chain could not confirm the document is current — the same claim `kv-last`
 * makes. It can be up to `CACHE_TTL_SECONDS` old, and because the copy is local,
 * a different data centre may already have a newer one. Nothing replicates it, so
 * it is not a consistency mechanism and must never be described as one.
 *
 * ## Why every operation is wrapped
 *
 * The Cache API is an optimisation and must never be able to fail a read. It is
 * also not present in every runtime this code runs under — the vitest `workerd`
 * environment in particular does not guarantee it. So every entry point here
 * checks for the API, swallows its errors, and degrades to "no cached copy".
 * A read that cannot use the cache is slower, not broken.
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
    return JSON.parse(await hit.text()) as Snapshot;
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

/** Drop the local copy. Used by the admin rebuild path so a repair is visible. */
export async function purgeSnapshotFromCache(slug: string): Promise<void> {
  const cache = defaultCache();
  if (cache === null) return;
  try {
    await cache.delete(snapshotCacheRequest(slug));
  } catch {
    // Nothing to do: the entry expires on its own.
  }
}
