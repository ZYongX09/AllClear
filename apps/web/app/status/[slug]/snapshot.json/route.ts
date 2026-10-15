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
 * The response is passed through untouched — status code, `Cache-Control` and
 * body — so this route cannot turn the API's 503 into a 200 that a monitor would
 * read as "healthy".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  return proxyApi(`/api/status/${encodeURIComponent(slug)}/snapshot.json`);
}
