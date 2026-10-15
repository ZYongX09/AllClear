import { buildAtomFeed } from "@allclear/shared";
import { readStatus } from "@/lib/allclear-api";
import { requestOrigin } from "@/lib/worker-env";

/**
 * The Atom feed, built here rather than proxied.
 *
 * The API Worker serves the same feed, and it would have been shorter to forward
 * to it. That is wrong for a reason worth stating: an Atom document contains
 * `rel="self"` and `rel="alternate"` links, and they have to be URLs a reader can
 * actually fetch. The API Worker has no public route, so its own origin is
 * unreachable from a feed reader — a proxied feed would advertise links that 404.
 * Building the document from the same shared function, with this request's own
 * origin, is what keeps those links honest.
 *
 * The snapshot still comes from the API, so the two feeds cannot disagree about
 * content — only about the host in their own links.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const result = await readStatus(slug);

  if (!result.ok || result.data.snapshot === null) {
    // A feed reader that gets an empty 200 will cache "no entries" and show the
    // page as quiet. A 503 with `no-store` makes it retry instead.
    console.error("feed unavailable", { slug, error: result.ok ? result.data.source : result.error });
    return new Response("status feed unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const origin = requestOrigin(request);
  const body = buildAtomFeed(result.data.snapshot, {
    selfUrl: `${origin}/status/${encodeURIComponent(slug)}/feed.xml`,
    statusUrl: `${origin}/status/${encodeURIComponent(slug)}`,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
