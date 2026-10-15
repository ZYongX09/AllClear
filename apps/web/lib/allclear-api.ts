/**
 * Client for the `allclear-api` Worker.
 *
 * Every call goes over the `API` Service Binding. `allclear-api` is deployed
 * with `workersDev: false` and no route, so there is no public origin to
 * configure and no way for these calls to leave Cloudflare's network.
 *
 * A Service Binding ignores the request's host — only the path and query are
 * used. The placeholder origin below is there because `fetch` requires an
 * absolute URL, not because anything is resolved from it.
 */

const SERVICE_ORIGIN = "https://allclear-api";

export interface SnapshotComponent {
  publicId: string;
  name: string;
  status: string;
  availableSince: number;
}

export interface Snapshot {
  slug: string;
  name: string;
  snapshotVersion: number;
  generatedAt: number;
  sourceUpdatedAt: number;
  components: SnapshotComponent[];
}

/**
 * Which step of the read chain produced the data. `kv-last` means D1 was
 * unavailable and the reader is looking at the last snapshot that was ever
 * written; `none` means there was nothing to serve at all.
 */
export type SnapshotSource = "kv-fresh" | "d1-rebuild" | "kv-last" | "none";

export interface ReadResult {
  snapshot: Snapshot | null;
  source: SnapshotSource;
  stale: boolean;
  errors: string[];
}

export type CallResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; error: string };

async function call<T>(
  api: Fetcher,
  path: string,
  init?: RequestInit,
): Promise<CallResult<T>> {
  try {
    const response = await api.fetch(`${SERVICE_ORIGIN}${path}`, init);
    // A non-2xx response is still a well-formed answer from the Worker — the
    // read API answers 503 with a full ReadResult when it has nothing to
    // serve. Only a thrown error means the call did not complete.
    return { ok: true, status: response.status, data: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function getStatus(api: Fetcher, slug: string): Promise<CallResult<ReadResult>> {
  return call<ReadResult>(api, `/api/status/${encodeURIComponent(slug)}`);
}

export interface RebuildResult {
  ok: boolean;
  snapshotVersion?: number;
  components?: number;
  error?: string;
}

/** Rebuilds the snapshot and repopulates both KV keys. */
export function rebuildSnapshot(
  api: Fetcher,
  internalKey: string,
  slug: string,
): Promise<CallResult<RebuildResult>> {
  return call<RebuildResult>(api, `/internal/snapshot/${encodeURIComponent(slug)}/rebuild`, {
    method: "POST",
    headers: { "X-Internal-Key": internalKey },
  });
}
