import { proxyApi } from "@/lib/allclear-api";

/**
 * The machine-readable snapshot, forwarded to the API unchanged.
 *
 * Proxied rather than rebuilt, unlike the Atom feed, because there is nothing in
 * this document that points at its own host: it is the `ReadResult` the API
 * already produces, with the same 503-when-there-is-nothing-to-serve rule and the
 * same `stale` flag. Reconstructing it here would create a second definition of
 * what "no data" means, and the first consumer to see the two differ would have
 * no way to tell which one was lying.
 *
 * Status and body are preserved, including 503 and fallback provenance. HTTP
 * caching is disabled here too: a cached ReadResult would freeze its age and
 * currency indicators beyond the API's own short summary-cache window.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const response = await proxyApi(`/api/status/${encodeURIComponent(slug)}/snapshot.json`);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
