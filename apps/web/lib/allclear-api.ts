/**
 * Client for the `allclear-api` Worker.
 *
 * Every call goes over the `API` Service Binding. `allclear-api` is deployed
 * with no public route, so there is no origin to configure and no way for these
 * calls to leave Cloudflare's network. A Service Binding ignores the request's
 * host — only the path and query are used — so the placeholder origin below
 * exists because `fetch` requires an absolute URL, not because anything is
 * resolved from it.
 *
 * ## Why the types come from `@allclear/shared`
 *
 * `Snapshot` and `ReadResult` are the interface *between* the two Workers. They
 * live in the shared package so that the page cannot render a field the API does
 * not write, which is what a locally re-declared copy of the contract eventually
 * does. Nothing in this file re-declares a field.
 *
 * ## Reachability is not authorisation
 *
 * The Service Binding is the only way to reach `allclear-api`, but that is not
 * by itself a credential. `/internal/*` routes additionally require
 * `INTERNAL_KEY`, which is read from `env` inside this Worker and never leaves
 * it. A route that is reachable over the binding but unauthenticated would be a
 * write surface, not an internal one.
 */

import type { ReadResult } from "@allclear/shared";

import { webEnv } from "./worker-env";

const SERVICE_ORIGIN = "https://allclear-api";

export type CallResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; error: string };

/**
 * Call the API and parse its JSON body.
 *
 * A non-2xx response is still a well-formed answer — the read API answers 503
 * with a full `ReadResult` when it has nothing to serve, and the subscribe
 * endpoint answers 400/429/502 with a reason. Only a thrown error means the call
 * did not complete, and that case has to be distinguished from "the API said
 * no", because the two need different messages on screen.
 */
async function call<T>(path: string, init?: RequestInit): Promise<CallResult<T>> {
  try {
    const response = await webEnv.API.fetch(`${SERVICE_ORIGIN}${path}`, init);
    const body = (await response.json()) as T;
    return { ok: true, status: response.status, data: body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The published snapshot plus the provenance of the read that produced it. */
export function readStatus(slug: string): Promise<CallResult<ReadResult>> {
  return call<ReadResult>(`/api/status/${encodeURIComponent(slug)}`);
}

/**
 * Fetch a path from the API and hand its response back unchanged.
 *
 * Used by the route handlers that exist so a visitor can reach a URL the API
 * Worker owns without the API Worker having a public origin: the Atom feed, the
 * `.json` document, the confirmation link, and the unsubscribe page. Those
 * handlers preserve status and body: a proxy that "helpfully" turned a 410 into
 * a 200 would break confirmation-link expiry. The public JSON handler explicitly
 * enforces `no-store` so currency metadata is not cached by another HTTP layer.
 *
 * A binding failure becomes a 502 rather than propagating: a thrown error inside
 * a Next route handler surfaces as an opaque 500 with no indication that the
 * *upstream* was what failed.
 */
export async function proxyApi(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await webEnv.API.fetch(`${SERVICE_ORIGIN}${path}`, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("service binding call failed", { path, error: message });
    return Response.json({ ok: false, error: "api_unreachable" }, { status: 502 });
  }
}

export interface SubscribeResult {
  ok: boolean;
  error?: string;
}

/**
 * Ask to subscribe an address to a page.
 *
 * The response is deliberately uniform: the API answers `{ok: true}` whether the
 * address was new, already pending, or already confirmed, so that this endpoint
 * cannot be used to ask "is this address subscribed here". The UI must therefore
 * not promise more than "if that address can be subscribed, a confirmation mail
 * has been sent".
 *
 * The address is sent in the body rather than the query string so it does not
 * land in a URL that gets logged.
 */
export function subscribeToPage(
  slug: string,
  email: string,
  componentPublicIds: readonly string[] = [],
): Promise<CallResult<SubscribeResult>> {
  return call<SubscribeResult>(`/api/status/${encodeURIComponent(slug)}/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, componentPublicIds }),
  });
}

export interface RebuildResult {
  ok: boolean;
  snapshotVersion?: number;
  components?: number;
  error?: string;
}

/**
 * Rebuild a page's D1 summary through the internal repair endpoint.
 *
 * Admin writes update the summary server-side; public hot caches can retain a
 * prior summary for up to 30 seconds. KV checkpoints have an independent budget
 * and cadence, so this action does not promise immediate global publication.
 */
export function rebuildSnapshot(slug: string): Promise<CallResult<RebuildResult>> {
  return call<RebuildResult>(`/internal/snapshot/${encodeURIComponent(slug)}/rebuild`, {
    method: "POST",
    headers: { "X-Internal-Key": webEnv.INTERNAL_KEY ?? "" },
  });
}
