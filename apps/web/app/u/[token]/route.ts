import { proxyApi } from "@/lib/allclear-api";

/**
 * The unsubscribe page, forwarded to the API Worker.
 *
 * This route exists because the link in a delivered email has to be a URL the
 * recipient's mail client can open, and the API Worker has no public origin. The
 * token is the entire authorisation and it is passed through verbatim, encoded
 * into the path.
 *
 * ## GET renders, POST acts
 *
 * The two methods are forwarded to different behaviours in the API, and that
 * split is load-bearing: mail providers and security scanners fetch every link in
 * a message, so a `GET` that mutated state would let a scanner silently
 * unsubscribe people. `GET` here returns the API's confirmation page; only `POST`
 * performs the unsubscribe.
 *
 * The body is forwarded because RFC 8058 one-click unsubscribe posts
 * `List-Unsubscribe=One-Click` to this same URL. The API does not read it — the
 * token is the authorisation — but a proxy that dropped it would break the
 * contract for anything downstream that does.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return proxyApi(`/u/${encodeURIComponent(token)}`);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return proxyApi(`/u/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: forwardedHeaders(request),
    body: await request.arrayBuffer(),
  });
}

/**
 * Forward only the headers the API could act on.
 *
 * Copying the whole request would carry the visitor's cookies and
 * `CF-Connecting-IP` into a call that has no use for them, and would make this
 * proxy's behaviour depend on headers it does not understand.
 */
function forwardedHeaders(request: Request): Headers {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const oneClick = request.headers.get("list-unsubscribe-post");
  if (oneClick) headers.set("List-Unsubscribe-Post", oneClick);
  return headers;
}
