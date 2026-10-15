/**
 * Signed unsubscribe tokens.
 *
 * ## Why the payload carries an expiry and a version
 *
 * A token that only identifies a subscriber is a permanent, unauthenticated
 * capability: anyone who ever sees the link can unsubscribe that address forever,
 * and there is no way to revoke it. Two extra fields fix both halves of that:
 *
 *   * `exp` bounds how long a leaked link stays usable. The server checks it, so
 *     the bound is enforced rather than decorative.
 *   * `version` is copied from `subscriber.version`. Incrementing that column
 *     invalidates every outstanding link for one subscriber at once, which is the
 *     only revocation mechanism available without tracking individual tokens.
 *
 * ## What is signed, exactly
 *
 * The signature covers the encoded payload verbatim, so the payload cannot be
 * re-encoded with different field ordering or whitespace and still verify. The
 * comparison uses `crypto.subtle.verify`, which is constant-time, rather than
 * comparing hex strings.
 *
 * ## Why the token is not a session
 *
 * It authorises exactly one action — unsubscribe this subscriber — and the server
 * re-checks the subscriber's current state anyway. A token that is valid,
 * unexpired, and correctly signed still does nothing if the subscriber is already
 * unsubscribed, because idempotence is decided from the database and not from the
 * token.
 */

const TOKEN_VERSION = "v1";

export interface UnsubscribePayload {
  /** Internal `page.id`, not the public id: the token is opaque to the holder. */
  pageId: number;
  /** Internal `subscriber.id`. */
  subscriberId: number;
  /** `subscriber.version` at issue time. */
  version: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

export type UnsubscribeRejection =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "version_mismatch";

export type UnsubscribeVerification =
  | { ok: true; payload: UnsubscribePayload }
  | { ok: false; reason: UnsubscribeRejection };

/** Default link lifetime: long enough to find an old email, short enough to matter. */
export const DEFAULT_TOKEN_TTL_SECONDS = 180 * 86_400;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + "=".repeat(padLength));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Issue a token.
 *
 * `secret` must come from the environment. A token signed with an empty secret
 * would be forgeable by anyone, so an empty secret is a hard error rather than a
 * silent fallback — a fallback here would be a vulnerability that looks like a
 * working feature.
 */
export async function signUnsubscribeToken(
  payload: UnsubscribePayload,
  secret: string,
): Promise<string> {
  if (secret === "") {
    throw new Error("unsubscribe token secret is not configured");
  }

  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${TOKEN_VERSION}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a token's signature, structure and expiry.
 *
 * Deliberately does *not* check the subscriber's state or version: that requires a
 * database read, and the caller is the only party that knows the subscriber's
 * current version. This function answers "is this token ours and still live".
 */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now: number,
): Promise<UnsubscribeVerification> {
  if (secret === "") return { ok: false, reason: "bad_signature" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [version, body, signature] = parts;
  if (version !== TOKEN_VERSION || body === undefined || signature === undefined) {
    return { ok: false, reason: "malformed" };
  }

  const signatureBytes = base64UrlDecode(signature);
  if (signatureBytes === null) return { ok: false, reason: "malformed" };

  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(body),
  );
  if (!valid) return { ok: false, reason: "bad_signature" };

  const payloadBytes = base64UrlDecode(body);
  if (payloadBytes === null) return { ok: false, reason: "malformed" };

  let payload: UnsubscribePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as UnsubscribePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof payload.pageId !== "number" ||
    typeof payload.subscriberId !== "number" ||
    typeof payload.version !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

/** A single-use token for the double opt-in confirmation step. */
export function newConfirmToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return base64UrlEncode(bytes);
}
