/**
 * Subscription: subscribe, confirm, unsubscribe.
 *
 * ## The three endpoints, and why each one exists
 *
 *   * `POST /api/status/:slug/subscribe` records an address and sends a
 *     confirmation link. Nothing is delivered to the address until the link is
 *     followed, so a stranger cannot subscribe someone else.
 *   * `GET  /api/subscribe/confirm?token=` completes that opt-in.
 *   * `GET  /u/:token` renders a confirmation page; `POST /u/:token` performs the
 *     unsubscribe. The split is not cosmetic: mail providers and security
 *     scanners fetch every link in a message, and an unauthenticated `GET` that
 *     mutates state would let a scanner silently unsubscribe people. RFC 8058
 *     one-click posts to the same URL, so both paths share one implementation.
 *
 * ## What the responses deliberately do not say
 *
 * A successful subscribe always returns the same body, whether the address was
 * new, already pending, or already confirmed. Telling them apart would turn this
 * endpoint into an oracle for "is this address subscribed to this page", which is
 * a question the caller has no business asking. The cost is that the UI cannot
 * say "you were already subscribed"; that is the right trade.
 *
 * ## Rate limiting has two dimensions, and they are not equivalent
 *
 * The per-address limit is the one that matters: it stops a script from mailing a
 * victim repeatedly. The per-IP limit is weaker here, because this Worker is
 * reachable only through the web app's Service Binding, so the client IP is
 * whatever the caller forwards — if the caller forwards nothing, every client
 * shares one bucket. That is stated rather than papered over; the address
 * dimension is what carries the guarantee.
 *
 * The address is hashed before it becomes a bucket name. `rate_limit.bucket` is a
 * plain text column and a counter table is not the place to accumulate a list of
 * email addresses.
 */

import { Hono } from "hono";

import { consumeRateLimit } from "../lib/rate-limit";
import { ulid } from "../lib/ulid";
import { consumeEmailQuota, emailSenderFromEnv } from "./email";
import { newConfirmToken, verifyUnsubscribeToken } from "./tokens";

/** Hard cap on confirmed subscribers per page. */
export const MAX_SUBSCRIBERS_PER_PAGE = 5000;
/** Per-address subscribe attempts per window. */
export const SUBSCRIBE_EMAIL_LIMIT = 3;
/** Per-IP subscribe attempts per window. */
export const SUBSCRIBE_IP_LIMIT = 10;
export const SUBSCRIBE_WINDOW_SECONDS = 3600;
/** How long a confirmation link stays usable. */
export const CONFIRM_TOKEN_TTL_SECONDS = 48 * 3600;
/** Global daily send ceiling. Mirrors the default in `notify.ts`. */
export const DAILY_EMAIL_QUOTA = 2000;
export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART = 64;

/**
 * Structural shape, not a proof of deliverability.
 *
 * The only real verification of an address is that someone can read mail sent to
 * it, which is exactly what the confirmation step does. This check exists to
 * reject obvious junk before a send is spent on it, and it is deliberately
 * permissive: a clever regex that rejects valid addresses is a worse bug than a
 * simple one that accepts a few invalid ones.
 */
const EMAIL_SHAPE = /^[^\s@,;@]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at > MAX_LOCAL_PART) return false;
  return EMAIL_SHAPE.test(email);
}

export function createSubscribeRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  const now = (): number => Math.floor(Date.now() / 1000);

  const baseUrlOf = (env: Env): string => (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  app.post("/api/status/:slug/subscribe", async (c) => {
    c.header("Cache-Control", "no-store");

    const secret = c.env.UNSUBSCRIBE_HMAC_KEY ?? "";
    const baseUrl = baseUrlOf(c.env);
    if (baseUrl === "") {
      return c.json({ ok: false, error: "public_base_url_not_configured" }, 503);
    }
    // Subscribing is still useful without the signing key — the address is
    // recorded and can be confirmed — but nothing will ever be delivered,
    // because notification links cannot be produced without it. Say so here
    // rather than letting a subscriber wait for mail that will not come.
    if (secret === "") {
      console.warn(
        "UNSUBSCRIBE_HMAC_KEY is not configured; subscriptions will be recorded but no change notifications will be sent",
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ ok: false, error: "invalid_body" }, 400);
    }
    const record = body as Record<string, unknown>;

    const rawEmail = record["email"];
    if (typeof rawEmail !== "string") {
      return c.json({ ok: false, error: "email_required" }, 400);
    }
    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) {
      return c.json({ ok: false, error: "invalid_email" }, 400);
    }

    const componentIds = parseComponentIds(record["componentPublicIds"]);
    if (componentIds === null) {
      return c.json({ ok: false, error: "invalid_component_list" }, 400);
    }

    const at = now();

    // Per-address first: it is the dimension that actually protects a person.
    const emailLimit = await consumeRateLimit(
      c.env.DB,
      `subscribe:email:${await hashForBucket(email)}`,
      SUBSCRIBE_EMAIL_LIMIT,
      SUBSCRIBE_WINDOW_SECONDS,
      at,
    );
    if (!emailLimit.allowed) {
      return c.json(
        { ok: false, error: "rate_limited", retryAfterSeconds: emailLimit.retryAfterSeconds },
        429,
      );
    }

    const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";
    const ipLimit = await consumeRateLimit(
      c.env.DB,
      `subscribe:ip:${await hashForBucket(ip)}`,
      SUBSCRIBE_IP_LIMIT,
      SUBSCRIBE_WINDOW_SECONDS,
      at,
    );
    if (!ipLimit.allowed) {
      return c.json(
        { ok: false, error: "rate_limited", retryAfterSeconds: ipLimit.retryAfterSeconds },
        429,
      );
    }

    const page = await c.env.DB
      .prepare("SELECT id, slug, name FROM page WHERE slug = ?1")
      .bind(c.req.param("slug"))
      .first<{ id: number; slug: string; name: string }>();
    if (!page) return c.json({ ok: false, error: "page_not_found" }, 404);

    const resolved = await resolveComponents(c.env.DB, page.id, componentIds);
    if (resolved === null) {
      return c.json({ ok: false, error: "unknown_component" }, 400);
    }

    const existing = await c.env.DB
      .prepare(
        `SELECT id, confirmed_at, unsubscribed_at, version
           FROM subscriber WHERE page_id = ?1 AND email = ?2`,
      )
      .bind(page.id, email)
      .first<{
        id: number;
        confirmed_at: number | null;
        unsubscribed_at: number | null;
        version: number;
      }>();

    let subscriberId: number;
    let version: number;

    if (existing) {
      // Re-subscribing an address that opted out requires a fresh confirmation.
      // Re-instating it silently would let anyone undo another person's
      // unsubscribe decision by typing their address into a form.
      const wasUnsubscribed = existing.unsubscribed_at !== null;
      version = wasUnsubscribed ? existing.version + 1 : existing.version;
      subscriberId = existing.id;

      await c.env.DB
        .prepare(
          `UPDATE subscriber
              SET confirm_token = ?2, confirmed_at = NULL, unsubscribed_at = NULL,
                  version = ?3, updated_at = ?4
            WHERE id = ?1`,
        )
        .bind(existing.id, newConfirmToken(), version, at)
        .run();
    } else {
      const count = await c.env.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM subscriber
            WHERE page_id = ?1 AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`,
        )
        .bind(page.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_SUBSCRIBERS_PER_PAGE) {
        return c.json({ ok: false, error: "subscription_capacity_reached" }, 503);
      }

      subscriberId = await insertSubscriber(c.env.DB, page.id, email, at);
      version = 1;
    }

    // Selections are replaced wholesale. A form that submits the full set is
    // simpler to reason about than a diff, and the set is small.
    await c.env.DB
      .prepare("DELETE FROM subscriber_component WHERE subscriber_id = ?1")
      .bind(subscriberId)
      .run();

    if (resolved.length > 0) {
      await c.env.DB.batch(
        resolved.map((componentId) =>
          c.env.DB
            .prepare(
              "INSERT INTO subscriber_component (subscriber_id, component_id) VALUES (?1, ?2)",
            )
            .bind(subscriberId, componentId),
        ),
      );
    }

    const quota = await consumeEmailQuota(c.env.DB, utcDayOf(at), DAILY_EMAIL_QUOTA, at);
    if (!quota.allowed) {
      return c.json({ ok: false, error: "email_quota_exceeded" }, 503);
    }

    const token = await readConfirmToken(c.env.DB, subscriberId);
    if (token === null) {
      return c.json({ ok: false, error: "internal_error" }, 500);
    }

    const confirmUrl = `${baseUrl}/api/subscribe/confirm?token=${encodeURIComponent(token)}`;
    const sendResult = await emailSenderFromEnv(c.env).send({
      to: email,
      subject: `Confirm your subscription to ${page.name}`,
      text: [
        `Someone asked to receive updates from ${page.name}.`,
        "",
        "If that was you, confirm here:",
        confirmUrl,
        "",
        `The link expires in ${Math.round(CONFIRM_TOKEN_TTL_SECONDS / 3600)} hours.`,
        "If it was not you, ignore this message and nothing will be sent.",
      ].join("\n"),
    });

    if (!sendResult.ok) {
      console.error("confirmation email failed", { error: sendResult.error ?? "unknown" });
      return c.json({ ok: false, error: "email_send_failed" }, 502);
    }

    return c.json({ ok: true }, 202);
  });

  // -------------------------------------------------------------------------
  // Confirm
  // -------------------------------------------------------------------------

  app.get("/api/subscribe/confirm", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = c.req.query("token") ?? "";
    if (token === "") return c.html(renderPage("Invalid link", "This link is missing its token."), 400);

    const row = await c.env.DB
      .prepare("SELECT id, page_id, confirmed_at, updated_at FROM subscriber WHERE confirm_token = ?1")
      .bind(token)
      .first<{ id: number; page_id: number; confirmed_at: number | null; updated_at: number }>();

    if (!row) {
      return c.html(
        renderPage(
          "Link no longer valid",
          "This confirmation link has already been used, or it has expired. You can subscribe again from the status page.",
        ),
        410,
      );
    }

    const at = now();
    if (at - row.updated_at > CONFIRM_TOKEN_TTL_SECONDS) {
      // The token is cleared as well, so the expired link cannot be retried.
      await c.env.DB
        .prepare("UPDATE subscriber SET confirm_token = NULL, updated_at = ?2 WHERE id = ?1")
        .bind(row.id, at)
        .run();
      return c.html(
        renderPage("Link expired", "This confirmation link has expired. Please subscribe again."),
        410,
      );
    }

    // `confirmed_at` is set only if it was not already set, so a double-click
    // does not move the confirmation time.
    await c.env.DB
      .prepare(
        `UPDATE subscriber
            SET confirmed_at = COALESCE(confirmed_at, ?2), confirm_token = NULL, updated_at = ?2
          WHERE id = ?1`,
      )
      .bind(row.id, at)
      .run();

    return c.html(
      renderPage("Subscription confirmed", "You will receive an email when this page changes."),
      200,
    );
  });

  // -------------------------------------------------------------------------
  // Unsubscribe — render on GET, act on POST
  // -------------------------------------------------------------------------

  app.get("/u/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    const check = await loadUnsubscribeTarget(c.env, c.req.param("token"), now());
    if (!check.ok) return c.html(renderPage("Link not usable", check.message), check.status);

    return c.html(
      renderPage(
        "Unsubscribe",
        // Passed raw. `renderPage` escapes the message, so escaping here as well
        // would render `&lt;` as the literal text `&amp;lt;` — safe, but wrong on
        // screen. The token below *is* escaped here, because it lands in an
        // attribute inside the `extra` block, which `renderPage` inserts as
        // markup and deliberately does not escape.
        `Unsubscribe ${check.email} from updates?`,
        `<form method="post" action="/u/${escapeHtml(c.req.param("token"))}">
           <button type="submit">Yes, unsubscribe</button>
         </form>`,
      ),
      200,
    );
  });

  app.post("/u/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    // RFC 8058 posts `List-Unsubscribe=One-Click` to this URL. The body is not
    // read: the token in the path is the entire authorisation.
    const at = now();
    const check = await loadUnsubscribeTarget(c.env, c.req.param("token"), at);
    if (!check.ok) return c.html(renderPage("Link not usable", check.message), check.status);

    // Idempotent: an address that is already unsubscribed stays unsubscribed and
    // the caller still sees success, so a second click is not an error.
    await c.env.DB
      .prepare(
        "UPDATE subscriber SET unsubscribed_at = COALESCE(unsubscribed_at, ?2), updated_at = ?2 WHERE id = ?1",
      )
      .bind(check.subscriberId, at)
      .run();

    return c.html(
      renderPage("Unsubscribed", "You will not receive further updates from this page."),
      200,
    );
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type UnsubscribeCheck =
  | { ok: true; subscriberId: number; email: string }
  | { ok: false; status: 400 | 404 | 409 | 410; message: string };

/**
 * Resolve a token to a subscriber, checking all four things that can invalidate
 * it: the signature, the expiry, the subscriber's existence, and the version.
 *
 * The version check is the revocation mechanism. A token issued before the
 * subscriber re-subscribed carries the old version and is refused, which is how
 * links from a previous subscription period stop working without storing
 * anything per token.
 */
async function loadUnsubscribeTarget(
  env: Env,
  token: string,
  at: number,
): Promise<UnsubscribeCheck> {
  const secret = env.UNSUBSCRIBE_HMAC_KEY ?? "";
  if (secret === "") {
    return { ok: false, status: 400, message: "Unsubscribing is not configured on this deployment." };
  }

  const verification = await verifyUnsubscribeToken(token, secret, at);
  if (!verification.ok) {
    if (verification.reason === "expired") {
      return {
        ok: false,
        status: 410,
        message: "This unsubscribe link has expired. Use a more recent message.",
      };
    }
    return { ok: false, status: 400, message: "This unsubscribe link is not valid." };
  }

  const row = await env.DB
    .prepare("SELECT id, email, version FROM subscriber WHERE id = ?1")
    .bind(verification.payload.subscriberId)
    .first<{ id: number; email: string; version: number }>();

  if (!row) {
    return { ok: false, status: 404, message: "This subscription no longer exists." };
  }
  if (row.version !== verification.payload.version) {
    return {
      ok: false,
      status: 409,
      message: "This unsubscribe link has been superseded by a newer one.",
    };
  }

  return { ok: true, subscriberId: row.id, email: row.email };
}

async function insertSubscriber(
  db: D1Database,
  pageId: number,
  email: string,
  at: number,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriber
         (public_id, page_id, email, confirm_token, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
       RETURNING id`,
    )
    .bind(ulid(), pageId, email, newConfirmToken(), at)
    .first<{ id: number }>();

  if (!row) throw new Error("subscriber insert returned no row");
  return row.id;
}

async function readConfirmToken(db: D1Database, subscriberId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT confirm_token FROM subscriber WHERE id = ?1")
    .bind(subscriberId)
    .first<{ confirm_token: string | null }>();
  return row?.confirm_token ?? null;
}

/**
 * Map public component ids to internal ones, rejecting any that belong to a
 * different page. Silently dropping unknown ids would let a caller subscribe to
 * nothing while believing they had selected components.
 */
async function resolveComponents(
  db: D1Database,
  pageId: number,
  publicIds: string[],
): Promise<number[] | null> {
  if (publicIds.length === 0) return [];

  const { results } = await db
    .prepare("SELECT id, public_id FROM component WHERE page_id = ?1")
    .bind(pageId)
    .all<{ id: number; public_id: string }>();

  const byPublicId = new Map(results.map((row) => [row.public_id, row.id]));
  const resolved: number[] = [];
  for (const publicId of publicIds) {
    const id = byPublicId.get(publicId);
    if (id === undefined) return null;
    resolved.push(id);
  }
  return resolved;
}

function parseComponentIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > 200) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 64) return null;
    out.push(entry);
  }
  return out;
}

/** `YYYY-MM-DD` in UTC, computed without pulling a date library in. */
function utcDayOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Hex digest, so an address never lands in `rate_limit.bucket` verbatim. */
async function hashForBucket(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A self-contained page. Inline styles rather than a stylesheet: these pages are
 * served by the API Worker, which has no asset pipeline and no business hosting
 * one. The markup is written here, not copied from anywhere.
 */
function renderPage(title: string, message: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f8fafc; color: #0f172a; padding: 24px;
  }
  main {
    width: 100%; max-width: 26rem; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 12px; padding: 32px;
  }
  h1 { margin: 0 0 12px; font-size: 1.25rem; }
  p { margin: 0; line-height: 1.6; color: #334155; }
  form { margin-top: 20px; }
  button {
    font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid #0f172a;
    background: #0f172a; color: #fff; cursor: pointer;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #020617; color: #e2e8f0; }
    main { background: #0f172a; border-color: #1e293b; }
    p { color: #cbd5e1; }
  }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${extra}
</main>
</body>
</html>`;
}
