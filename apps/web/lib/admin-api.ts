/**
 * Server-side client for the admin API.
 *
 * Every function here reads `INTERNAL_KEY` from the Worker's environment and
 * attaches it to the outgoing request. Nothing in this module is importable from
 * a Client Component: it reaches a binding, so the bundler would refuse anyway,
 * and `apps/web/lib/worker-env.ts` documents why that has to stay true.
 *
 * ## Why this is not `allclear-api.ts`
 *
 * `allclear-api.ts` is the *public* read path — one snapshot, one subscribe
 * endpoint — and it is imported by pages that are rendered for visitors. This is
 * the write path, and keeping the two apart means a page that only reads a
 * snapshot cannot accidentally acquire the ability to write one.
 *
 * ## Errors are values
 *
 * The API answers a refused write with a `4xx` and a `{ ok: false, error, field }`
 * body. That is a usable answer, not a failure, so it is returned rather than
 * thrown; only a thrown `fetch` means the call did not complete at all. The
 * console renders `field` next to the offending input, which is the one thing a
 * form can actually do with a validation error.
 */

import type { ReadResult } from "@allclear/shared";

import { webEnv } from "./worker-env";

const SERVICE_ORIGIN = "https://allclear-api";

export interface AdminCall<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Set only when the request never completed. */
  transportError?: string;
}

export interface AdminWriteResult {
  ok: boolean;
  error?: string;
  field?: string | null;
  publicId?: string;
  snapshotVersion?: number;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<AdminCall<T>> {
  try {
    const response = await webEnv.API.fetch(`${SERVICE_ORIGIN}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": webEnv.INTERNAL_KEY ?? "",
        ...(init.headers ?? {}),
      },
    });
    const data = (await response.json()) as T;
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface AdminPageSummary {
  public_id: string;
  slug: string;
  name: string;
  snapshot_version: number;
  updated_at: number;
  section_count: number;
  component_count: number;
  enabled_probe_count: number;
  open_change_count: number;
}

export interface AdminPageDetail {
  page: AdminPageSummary;
  sections: Array<{ public_id: string; name: string; description: string | null; order_id: number }>;
  components: Array<{
    public_id: string;
    name: string;
    description: string | null;
    order_id: number;
    available_since: number;
    section_public_id: string | null;
  }>;
  probes: Array<{
    public_id: string;
    url: string;
    method: string;
    severity: string;
    expected_status: number;
    timeout_ms: number;
    interval_seconds: number;
    failure_threshold: number;
    recovery_threshold: number;
    enabled: number;
    next_check_at: number;
    component_public_id: string;
    consecutive_failures: number | null;
    consecutive_successes: number | null;
    transition_seq: number | null;
    last_probe_at: number | null;
    open_impact_id: number | null;
  }>;
  changes: Array<{
    public_id: string;
    kind: string;
    status: string;
    title: string;
    severity: string;
    starts_at: number;
    ends_at: number | null;
    scheduled_start_at: number | null;
    scheduled_end_at: number | null;
  }>;
  /**
   * Hand-entered impacts only. A probe-generated impact is owned by the probe
   * state machine, and the API's own query filters on `probe_target_id IS NULL`,
   * so the console can offer a close button for every row it receives here
   * without having to re-check which kind it is.
   */
  impacts: Array<{
    public_id: string;
    severity: string;
    start_at: number;
    end_at: number | null;
    estimated: number;
    component_public_id: string;
  }>;
}

export interface EmailQuotaView {
  day: string;
  sent: number;
  limit: number;
  remaining: number;
}

export function listPages(): Promise<AdminCall<{ pages: AdminPageSummary[] }>> {
  return call<{ pages: AdminPageSummary[] }>("/internal/admin/pages");
}

export function readPage(slug: string): Promise<AdminCall<AdminPageDetail>> {
  return call<AdminPageDetail>(`/internal/admin/pages/${encodeURIComponent(slug)}`);
}

export function readEmailQuota(): Promise<AdminCall<EmailQuotaView>> {
  return call<EmailQuotaView>("/internal/admin/email-quota");
}

/**
 * Issue a write.
 *
 * `body` is stringified here rather than by each caller so that every write in
 * the console goes out with the same content type and the same key, and so a new
 * form cannot forget the header.
 */
export async function write(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<AdminWriteResult> {
  const result = await call<AdminWriteResult>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (result.transportError !== undefined) {
    return { ok: false, error: "api_unreachable" };
  }
  if (result.data === null) {
    return { ok: false, error: "internal_error" };
  }
  return result.data;
}

/**
 * The public read path, used by the console only to link to a page.
 *
 * The admin view of a page does not carry the derived statuses — those are a
 * property of the snapshot, computed at read time — so the console asks the
 * public read endpoint when it wants to show what a visitor sees.
 */
export function readPublicStatus(slug: string): Promise<AdminCall<ReadResult>> {
  return call<ReadResult>(`/api/status/${encodeURIComponent(slug)}`);
}
