/**
 * The admin console's session, and the gate every write goes through.
 *
 * ## Why there is a gate at all
 *
 * The API Worker is closed: it has no public route and every `/internal/*`
 * request needs `INTERNAL_KEY`. A Server Action in this Worker is not closed —
 * it is a public POST endpoint, reachable by anyone who can reach the page — and
 * it attaches `INTERNAL_KEY` on the way out. So without a check here, an
 * unauthenticated `/admin` would be a public write surface with the Worker's own
 * credential wired into it. That is the exact hole `apps/api/src/index.ts`
 * warns about from the other side: reachability is not authorisation.
 *
 * ## What the browser holds
 *
 * Not `INTERNAL_KEY`. The browser holds a session cookie, and the cookie holds
 * only an expiry and an HMAC over it — no secret is transmitted in either
 * direction once the operator has signed in. It is `HttpOnly`, so script cannot
 * read it, and scoped to `Path=/admin`, so it is not sent to the public status
 * pages. `Secure` is set unconditionally: this console is only ever reached over
 * HTTPS in any real deployment, and `localhost` is treated as a secure context by
 * every browser that matters.
 *
 * The cookie is signed with `ADMIN_TOKEN` itself rather than with a separate
 * signing key. That makes revocation trivial and total — rotating `ADMIN_TOKEN`
 * invalidates every session at once — at the cost of the token being the only
 * thing an attacker with a stolen cookie needs to forge a new one. Since a stolen
 * cookie is already equivalent to the session, and the token is what the operator
 * types to get a session in the first place, that is not a meaningful loss.
 *
 * ## What this is not
 *
 * There are no accounts, no roles, and no per-person identity. Everyone who
 * knows `ADMIN_TOKEN` is equally authorised, and the audit log records a null
 * actor because there is no actor to record. This is the same boundary the API
 * Worker documents, for the same reason: inventing an identity model nothing
 * authenticates against would be worse than having none. It is written down in
 * docs/spec/admin-ui.md rather than left to be discovered.
 */

import { cookies } from "next/headers";

import { webEnv } from "./worker-env";

export const ADMIN_COOKIE = "allclear_admin";

/** How long a signed-in session lasts. */
export const SESSION_TTL_SECONDS = 12 * 3600;

export type AdminSession = { expiresAt: number };

/**
 * Compare two strings without leaking their contents through timing.
 *
 * Length is compared first and returns early. That does leak the length, which
 * is unavoidable without padding, and is not a useful signal for a secret whose
 * length the attacker cannot choose.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sign(payload: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload));
  return base64url(new Uint8Array(signature));
}

/** The configured token, or `null` when the deployment has not set one. */
export function adminToken(): string | null {
  const token = webEnv.ADMIN_TOKEN ?? "";
  return token === "" ? null : token;
}

/**
 * Whether the submitted token matches, in constant time.
 *
 * Returns false when no token is configured, so an unconfigured deployment
 * refuses every attempt instead of accepting an empty string.
 */
export async function tokenMatches(submitted: string): Promise<boolean> {
  const expected = adminToken();
  if (expected === null) return false;
  return constantTimeEqual(submitted, expected);
}

/** Mint a cookie value for a new session. */
export async function issueSession(now: number): Promise<{ value: string; maxAge: number }> {
  const token = adminToken();
  if (token === null) throw new Error("ADMIN_TOKEN is not configured");

  const expiresAt = now + SESSION_TTL_SECONDS;
  const signature = await sign(`admin:${expiresAt}`, token);
  return { value: `${expiresAt}.${signature}`, maxAge: SESSION_TTL_SECONDS };
}

/**
 * Verify a cookie value.
 *
 * Four things are checked and all four matter: the shape, the expiry, the
 * signature, and that a token is configured at all. A verifier that skipped the
 * signature would accept any expiry the attacker chose; one that skipped the
 * expiry would accept a session forever.
 */
export async function verifySession(value: string, now: number): Promise<AdminSession | null> {
  const token = adminToken();
  if (token === null) return null;

  const separator = value.indexOf(".");
  if (separator <= 0) return null;

  const expiresAt = Number.parseInt(value.slice(0, separator), 10);
  const signature = value.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || signature === "") return null;
  if (expiresAt <= now) return null;

  const expected = await sign(`admin:${expiresAt}`, token);
  if (!constantTimeEqual(signature, expected)) return null;

  return { expiresAt };
}

/**
 * The current session, or `null`.
 *
 * Read from `cookies()` rather than from a request header because that is the
 * only way a Server Component and a Server Action can both reach it, and both
 * need to: the layout decides what to render, and every action re-checks before
 * writing.
 */
export async function readAdminSession(now?: number): Promise<AdminSession | null> {
  const store = await cookies();
  const raw = store.get(ADMIN_COOKIE)?.value;
  if (raw === undefined) return null;
  return verifySession(raw, now ?? Math.floor(Date.now() / 1000));
}
