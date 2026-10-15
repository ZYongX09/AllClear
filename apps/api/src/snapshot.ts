/**
 * Snapshot construction and the public read chain.
 *
 * The read chain is the whole point of this file, so it is written to make its
 * ordering explicit rather than implicit:
 *
 *   1. KV fresh   — the normal path. Does not touch D1 at all.
 *   2. D1 rebuild — only reached on a KV miss (cold cache, or the key was
 *                   evicted). Rebuilds the snapshot and repopulates both keys.
 *   3. KV last    — reached only when D1 is also unavailable. Serves the last
 *                   known good snapshot, marked stale.
 *   4. none       — nothing to serve; the caller must render an explicit
 *                   "unavailable" state rather than an empty-but-plausible page.
 *
 * `stale` is computed here, at read time, from the snapshot's own age and from
 * which path produced it. It is never baked in at write time: a snapshot that
 * was fresh when generated becomes stale simply by getting old, and the reader
 * is the only party that knows how old is too old.
 */

export interface ComponentSnapshot {
  publicId: string;
  name: string;
  status: string;
  availableSince: number;
}

export interface Snapshot {
  slug: string;
  name: string;
  snapshotVersion: number;
  /** When this snapshot document was assembled. */
  generatedAt: number;
  /** When the underlying source data last changed. */
  sourceUpdatedAt: number;
  components: ComponentSnapshot[];
}

export type SnapshotSource = "kv-fresh" | "d1-rebuild" | "kv-last" | "none";

export interface ReadResult {
  snapshot: Snapshot | null;
  source: SnapshotSource;
  stale: boolean;
  /** Non-fatal failures encountered while walking the chain. Useful for the UI. */
  errors: string[];
}

export const freshKey = (slug: string): string => `snapshot:${slug}`;
export const lastKey = (slug: string): string => `snapshot:${slug}:last`;

/** Snapshot older than this is reported as stale even when served from KV. */
export const DEFAULT_MAX_AGE_SECONDS = 300;

interface PageRow {
  id: number;
  slug: string;
  name: string;
  snapshot_version: number;
  updated_at: number;
}

interface ComponentRow {
  public_id: string;
  name: string;
  status: string;
  available_since: number;
}

/** Assemble a snapshot from D1. Throws if the page does not exist. */
export async function buildSnapshot(db: D1Database, slug: string): Promise<Snapshot> {
  const page = await db
    .prepare("SELECT id, slug, name, snapshot_version, updated_at FROM page WHERE slug = ?1")
    .bind(slug)
    .first<PageRow>();

  if (!page) throw new Error(`no page with slug ${slug}`);

  const { results } = await db
    .prepare(
      "SELECT public_id, name, status, available_since FROM component WHERE page_id = ?1 ORDER BY order_id",
    )
    .bind(page.id)
    .all<ComponentRow>();

  return {
    slug: page.slug,
    name: page.name,
    snapshotVersion: page.snapshot_version,
    generatedAt: Math.floor(Date.now() / 1000),
    sourceUpdatedAt: page.updated_at,
    components: results.map((row) => ({
      publicId: row.public_id,
      name: row.name,
      status: row.status,
      availableSince: row.available_since,
    })),
  };
}

/**
 * Persist a snapshot to both keys.
 *
 * `snapshot:<slug>:last` is written by the same call that writes
 * `snapshot:<slug>`. That is not incidental: the fallback path in
 * `readSnapshot` depends on the key existing, so the write path has to maintain
 * it deliberately. Writing only the fresh key would leave the documented
 * fallback with no write contract behind it.
 */
export async function writeSnapshot(kv: KVNamespace, snapshot: Snapshot): Promise<void> {
  const body = JSON.stringify(snapshot);
  await Promise.all([
    kv.put(freshKey(snapshot.slug), body),
    kv.put(lastKey(snapshot.slug), body),
  ]);
}

async function readKv(kv: KVNamespace, key: string): Promise<Snapshot | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  return JSON.parse(raw) as Snapshot;
}

export async function readSnapshot(
  db: D1Database,
  kv: KVNamespace,
  slug: string,
  options: { now?: number; maxAgeSeconds?: number } = {},
): Promise<ReadResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const errors: string[] = [];

  // 1. Normal path: KV only.
  try {
    const cached = await readKv(kv, freshKey(slug));
    if (cached) {
      return {
        snapshot: cached,
        source: "kv-fresh",
        stale: now - cached.generatedAt > maxAge,
        errors,
      };
    }
  } catch (error) {
    errors.push(`kv-fresh: ${describe(error)}`);
  }

  // 2. KV missed — rebuild from D1 and repopulate both keys.
  try {
    const rebuilt = await buildSnapshot(db, slug);
    try {
      await writeSnapshot(kv, rebuilt);
    } catch (error) {
      // A write failure must not fail the read: we already have the data.
      errors.push(`kv-write: ${describe(error)}`);
    }
    return { snapshot: rebuilt, source: "d1-rebuild", stale: false, errors };
  } catch (error) {
    errors.push(`d1-rebuild: ${describe(error)}`);
  }

  // 3. D1 unavailable — fall back to the last known good snapshot.
  try {
    const last = await readKv(kv, lastKey(slug));
    if (last) {
      return { snapshot: last, source: "kv-last", stale: true, errors };
    }
  } catch (error) {
    errors.push(`kv-last: ${describe(error)}`);
  }

  // 4. Nothing left. Report that plainly.
  return { snapshot: null, source: "none", stale: true, errors };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
