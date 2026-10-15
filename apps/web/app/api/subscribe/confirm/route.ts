import { proxyApi } from "@/lib/allclear-api";

/**
 * The double opt-in confirmation link, forwarded to the API Worker.
 *
 * Same reason as `/u/:token`: the URL is delivered in an email and must be
 * publicly fetchable, while the Worker that owns the logic has no public route.
 * The token travels in the query string and is forwarded exactly as received —
 * the API validates the signature, the expiry, the subscriber's state and the
 * current version, and it answers 410 for a link that has expired or already been
 * used. That status is passed through, because a confirmation link that silently
 * succeeded the second time would be a confirmation link that can be replayed.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return proxyApi(`/api/subscribe/confirm?token=${encodeURIComponent(token)}`);
}
