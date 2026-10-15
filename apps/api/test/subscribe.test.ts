import { beforeEach, describe, expect, it } from "vitest";

import { notifyChange, type NotifyContext } from "../src/subscribe/notify";
import type { EmailMessage, EmailSender } from "../src/subscribe/email";
import { signUnsubscribeToken } from "../src/subscribe/tokens";
import { testEnv as env } from "./env";
import {
  callApi,
  callJson,
  createChange,
  createComponent,
  createPage,
  createSubscriber,
  workerEnv,
} from "./helpers";

/**
 * Subscription: the double opt-in, the unsubscribe capability, and who gets
 * notified.
 *
 * Four properties carry the security of this surface, and each has a group here:
 *
 *   1. **Nothing is delivered before the address is confirmed.** Otherwise
 *      anyone could subscribe a stranger to a page and use this as a mail relay.
 *   2. **`GET /u/:token` never mutates.** Mail providers and security scanners
 *      fetch every URL in a message; an unauthenticated GET that unsubscribed
 *      would let a scanner unsubscribe people silently. RFC 8058 one-click posts
 *      to the same path, so the mutating half is `POST`.
 *   3. **A confirmation of one state is indistinguishable from another.** The
 *      subscribe endpoint answers the same way for a new address, a pending one
 *      and a confirmed one, so it cannot be used to ask "is this person
 *      subscribed".
 *   4. **A link that has been revoked stops working.** `version` is incremented
 *      when an address re-subscribes after opting out, which invalidates every
 *      token issued before that.
 *
 * ## Two things about this file worth knowing before editing it
 *
 * `src/subscribe/routes.ts` reads the clock directly — `Math.floor(Date.now() /
 * 1000)` — rather than taking `now` as an argument, so unlike the rest of the
 * suite these tests cannot pin time. Where a test needs an old timestamp it
 * writes one into the row instead of pretending the clock moved, and the two
 * places that do are marked.
 *
 * D1 storage is shared by every test in a file (see `apply-migrations.ts`), and
 * the rate limiter counts per bucket name across the whole table. Every test
 * therefore uses its own page, and its own client IP where the IP dimension is
 * under test, and `beforeEach` clears the counters.
 */

const SUBSCRIBE_EMAIL_LIMIT = 3;
const SUBSCRIBE_IP_LIMIT = 10;
const DAILY_EMAIL_QUOTA = 2000;

beforeEach(async () => {
  // Two globals this file deliberately drives to their limit. The limiter's
  // buckets are keyed by hashed address and hashed IP, and the send quota is a
  // single row per UTC day; leaving either behind makes the next test see a 429
  // or a 503 it did not provoke. Clearing both is what makes the tests
  // independent, and it is necessary because D1 storage is shared by every test
  // in this file — see `apply-migrations.ts`.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limit"),
    env.DB.prepare("DELETE FROM email_quota"),
  ]);
});

/**
 * The clock the endpoints under test read.
 *
 * `src/subscribe/routes.ts` takes no `now` argument — it calls `Date.now()`
 * itself — and the unsubscribe endpoint checks a token's `exp` against that
 * clock. A notification assembled at a fixture time in 2023 therefore produces a
 * link that is already expired by the time the test follows it, which is a
 * fixture artefact and not a bug in the link. Notifications are given the real
 * clock so that the token they mint is the token the endpoint will accept.
 */
function realNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** A sender that records instead of delivering, so a test can read the message. */
function captureSender(options: { fail?: boolean } = {}): {
  sender: EmailSender;
  messages: EmailMessage[];
} {
  const messages: EmailMessage[] = [];
  return {
    messages,
    sender: {
      kind: "recording",
      async send(message) {
        messages.push(message);
        return options.fail === true ? { ok: false, error: "provider said no" } : { ok: true };
      },
    },
  };
}

/** Read the confirmation token the subscribe endpoint stored. */
async function confirmTokenOf(pageId: number, email: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT confirm_token FROM subscriber WHERE page_id = ?1 AND email = ?2",
  )
    .bind(pageId, email)
    .first<{ confirm_token: string | null }>();
  return row?.confirm_token ?? null;
}

interface SubscriberState {
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  version: number;
  confirm_token: string | null;
}

async function subscriberState(pageId: number, email: string): Promise<SubscriberState | null> {
  return env.DB.prepare(
    `SELECT confirmed_at, unsubscribed_at, version, confirm_token
       FROM subscriber WHERE page_id = ?1 AND email = ?2`,
  )
    .bind(pageId, email)
    .first<SubscriberState>();
}

/** An address that is unique to the page, so no test can collide with another. */
function addressFor(pageSlug: string): string {
  return `sub-${pageSlug}@example.com`;
}

async function subscribe(
  slug: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return callJson(`/api/status/${slug}/subscribe`, "POST", body, headers);
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

describe("POST /api/status/:slug/subscribe", () => {
  it("requires a JSON object body", async () => {
    const page = await createPage();

    const notJson = await callApi(`/api/status/${page.slug}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
    expect((await notJson.json<{ error: string }>()).error).toBe("invalid_json");

    const notObject = await subscribe(page.slug, [1, 2, 3]);
    expect(notObject.status).toBe(400);
    expect((await notObject.json<{ error: string }>()).error).toBe("invalid_body");
  });

  it("requires an address", async () => {
    const page = await createPage();
    const response = await subscribe(page.slug, { componentPublicIds: [] });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe("email_required");
  });

  it("rejects obvious junk and over-long addresses before spending a send", async () => {
    const page = await createPage();

    for (const candidate of [
      "not-an-address",
      "@example.com",
      "no-domain@",
      "two@@example.com",
      "spaces in@example.com",
      "trailing@example.",
      `${"a".repeat(250)}@example.com`,
      `${"a".repeat(65)}@example.com`,
    ]) {
      const response = await subscribe(page.slug, { email: candidate });
      expect(response.status, `expected ${candidate} to be rejected`).toBe(400);
      expect((await response.json<{ error: string }>()).error).toBe("invalid_email");
    }

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM subscriber WHERE page_id = ?1",
    )
      .bind(page.id)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("lower-cases and trims the address, so one mailbox is one subscriber", async () => {
    const page = await createPage();
    const response = await subscribe(page.slug, { email: "  Mixed.Case@Example.COM  " });
    expect(response.status).toBe(202);

    const state = await subscriberState(page.id, "mixed.case@example.com");
    expect(state).not.toBeNull();
    expect(state!.confirmed_at).toBeNull();
  });

  it("reports a page that does not exist", async () => {
    const response = await subscribe("no-such-page", { email: "nobody@example.com" });
    expect(response.status).toBe(404);
    expect((await response.json<{ error: string }>()).error).toBe("page_not_found");
  });

  it("refuses a component that belongs to a different page", async () => {
    // Silently dropping the unknown id would let a caller believe they had
    // selected a component while being subscribed to nothing.
    const page = await createPage();
    const other = await createPage();
    const foreign = await createComponent(other.id);

    const response = await subscribe(page.slug, {
      email: addressFor(page.slug),
      componentPublicIds: [foreign.publicId],
    });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe("unknown_component");
  });

  it("rejects a component list that is not a list of ids", async () => {
    const page = await createPage();
    for (const candidate of ["one", [1, 2], [""], ["x".repeat(65)], [null]]) {
      const response = await subscribe(page.slug, {
        email: addressFor(page.slug),
        componentPublicIds: candidate,
      });
      expect(response.status, `expected ${JSON.stringify(candidate)} to be rejected`).toBe(400);
    }
  });

  it("records the selection and leaves the address unconfirmed", async () => {
    const page = await createPage();
    const api = await createComponent(page.id, { name: "API" });
    const web = await createComponent(page.id, { name: "Web" });
    const email = addressFor(page.slug);

    const response = await subscribe(page.slug, {
      email,
      componentPublicIds: [api.publicId],
    });
    expect(response.status).toBe(202);
    expect(await response.json<{ ok: boolean }>()).toEqual({ ok: true });

    const state = await subscriberState(page.id, email);
    expect(state!.confirmed_at).toBeNull();
    expect(state!.confirm_token).not.toBeNull();

    const { results } = await env.DB.prepare(
      `SELECT component_id FROM subscriber_component sc
         JOIN subscriber s ON s.id = sc.subscriber_id
        WHERE s.page_id = ?1 AND s.email = ?2`,
    )
      .bind(page.id, email)
      .all<{ component_id: number }>();
    expect(results.map((row) => row.component_id)).toEqual([api.id]);
    expect(results.map((row) => row.component_id)).not.toContain(web.id);
  });

  it("replaces the selection rather than merging it", async () => {
    const page = await createPage();
    const api = await createComponent(page.id, { name: "API" });
    const web = await createComponent(page.id, { name: "Web" });
    const email = addressFor(page.slug);

    await subscribe(page.slug, { email, componentPublicIds: [api.publicId] });
    await subscribe(page.slug, { email, componentPublicIds: [web.publicId] });

    const { results } = await env.DB.prepare(
      `SELECT component_id FROM subscriber_component sc
         JOIN subscriber s ON s.id = sc.subscriber_id
        WHERE s.page_id = ?1 AND s.email = ?2`,
    )
      .bind(page.id, email)
      .all<{ component_id: number }>();
    expect(results.map((row) => row.component_id)).toEqual([web.id]);
  });

  it("answers identically for a new, a pending and a confirmed address", async () => {
    // The whole point of the endpoint's uniform response. A caller must not be
    // able to learn whether an address is subscribed to a page.
    const page = await createPage();
    const email = addressFor(page.slug);

    const fresh = await subscribe(page.slug, { email });
    expect(fresh.status).toBe(202);
    const freshBody = await fresh.text();

    const pending = await subscribe(page.slug, { email });
    expect(pending.status).toBe(202);
    expect(await pending.text()).toBe(freshBody);

    const token = await confirmTokenOf(page.id, email);
    await callApi(`/api/subscribe/confirm?token=${encodeURIComponent(token!)}`);

    const confirmed = await subscribe(page.slug, { email });
    expect(confirmed.status).toBe(202);
    expect(await confirmed.text()).toBe(freshBody);
  });

  it("clears a previous confirmation, so re-subscribing is confirmed again", async () => {
    // The endpoint re-issues a confirmation link on every call. A confirmed
    // subscriber who submits the form again must not keep receiving mail from an
    // opt-in they cannot see, and an unsubscribed one must not be silently
    // re-instated: both require a fresh confirmation.
    const page = await createPage();
    const email = addressFor(page.slug);

    await subscribe(page.slug, { email });
    const first = await confirmTokenOf(page.id, email);
    await callApi(`/api/subscribe/confirm?token=${encodeURIComponent(first!)}`);
    expect((await subscriberState(page.id, email))!.confirmed_at).not.toBeNull();

    await subscribe(page.slug, { email });
    const state = await subscriberState(page.id, email);
    expect(state!.confirmed_at).toBeNull();
    expect(state!.confirm_token).not.toBeNull();
    expect(state!.confirm_token).not.toBe(first);
  });

  it("bumps the version when an unsubscribed address asks to come back", async () => {
    // This is the revocation mechanism. Without the bump, every link in every
    // message already delivered would keep working.
    const page = await createPage();
    const email = addressFor(page.slug);

    await subscribe(page.slug, { email });
    const token = await confirmTokenOf(page.id, email);
    await callApi(`/api/subscribe/confirm?token=${encodeURIComponent(token!)}`);

    const before = await subscriberState(page.id, email);
    expect(before!.version).toBe(1);

    await env.DB.prepare(
      "UPDATE subscriber SET unsubscribed_at = ?2 WHERE page_id = ?1 AND email = ?3",
    )
      .bind(page.id, 1_700_000_500, email)
      .run();

    await subscribe(page.slug, { email });
    const after = await subscriberState(page.id, email);
    expect(after!.version).toBe(before!.version + 1);
    // ...and the opt-out is cleared, but only pending a fresh confirmation.
    expect(after!.unsubscribed_at).toBeNull();
    expect(after!.confirmed_at).toBeNull();
  });

  it("stops a script from mailing one address repeatedly", async () => {
    // The dimension that protects a person. The IP limit is the weaker of the
    // two — see the note in `routes.ts` — but this one is not forgeable by the
    // caller.
    const page = await createPage();
    const email = addressFor(page.slug);

    for (let attempt = 0; attempt < SUBSCRIBE_EMAIL_LIMIT; attempt += 1) {
      const response = await subscribe(page.slug, { email });
      expect(response.status, `attempt ${attempt + 1} should be allowed`).toBe(202);
    }

    const limited = await subscribe(page.slug, { email });
    expect(limited.status).toBe(429);
    const body = await limited.json<{ error: string; retryAfterSeconds: number }>();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("keeps the counter monotonic, so hammering does not restore the budget", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);

    for (let attempt = 0; attempt < SUBSCRIBE_EMAIL_LIMIT; attempt += 1) {
      await subscribe(page.slug, { email });
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await subscribe(page.slug, { email });
      expect(response.status).toBe(429);
    }
  });

  it("limits by client IP as well as by address", async () => {
    const page = await createPage();
    const ip = "203.0.113.44";

    for (let attempt = 0; attempt < SUBSCRIBE_IP_LIMIT; attempt += 1) {
      const response = await subscribe(
        page.slug,
        { email: `ip-test-${attempt}-${page.slug}@example.com` },
        { "CF-Connecting-IP": ip },
      );
      expect(response.status, `attempt ${attempt + 1} should be allowed`).toBe(202);
    }

    const limited = await subscribe(
      page.slug,
      { email: `ip-test-over-${page.slug}@example.com` },
      { "CF-Connecting-IP": ip },
    );
    expect(limited.status).toBe(429);

    // A different client is unaffected: the limit is per caller, not global.
    const other = await subscribe(
      page.slug,
      { email: `ip-test-other-${page.slug}@example.com` },
      { "CF-Connecting-IP": "203.0.113.45" },
    );
    expect(other.status).toBe(202);
  });

  it("refuses once the global daily send budget is spent", async () => {
    // The ceiling that turns a runaway notification loop into a wall instead of
    // a bill. `consumeEmailQuota` counts the send this request would make, so a
    // counter already at the limit means the answer is no.
    const page = await createPage();
    const today = new Date().toISOString().slice(0, 10);

    await env.DB.prepare(
      `INSERT INTO email_quota (day, sent, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(day) DO UPDATE SET sent = ?2`,
    )
      .bind(today, DAILY_EMAIL_QUOTA, 1_700_000_000)
      .run();

    const response = await subscribe(page.slug, { email: addressFor(page.slug) });
    expect(response.status).toBe(503);
    expect((await response.json<{ error: string }>()).error).toBe("email_quota_exceeded");

    // The address was still recorded: the quota stopped the mail, not the
    // subscription, and a retry after the window rolls over will confirm it.
    expect(await subscriberState(page.id, addressFor(page.slug))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

describe("GET /api/subscribe/confirm", () => {
  it("rejects a link with no token", async () => {
    const response = await callApi("/api/subscribe/confirm");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("missing its token");
  });

  it("reports an unknown token as no longer valid", async () => {
    const response = await callApi("/api/subscribe/confirm?token=not-a-token");
    expect(response.status).toBe(410);
    expect(await response.text()).toContain("already been used, or it has expired");
  });

  it("confirms the address and consumes the token", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);
    await subscribe(page.slug, { email });

    const token = await confirmTokenOf(page.id, email);
    const response = await callApi(`/api/subscribe/confirm?token=${encodeURIComponent(token!)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Subscription confirmed");

    const state = await subscriberState(page.id, email);
    expect(state!.confirmed_at).not.toBeNull();
    expect(state!.confirm_token).toBeNull();

    // Single-use: following the same link again finds nothing to confirm.
    const again = await callApi(`/api/subscribe/confirm?token=${encodeURIComponent(token!)}`);
    expect(again.status).toBe(410);
  });

  it("does not move an existing confirmation time", async () => {
    // `COALESCE(confirmed_at, ?2)` in the UPDATE. A token that is still valid
    // after a confirmation — a scanner re-fetching the link, a double click —
    // must not rewrite the moment the opt-in actually happened.
    //
    // The row's `updated_at` is the real clock rather than `T0`, because that is
    // the field the route compares against its own clock to decide expiry. A
    // fixture timestamped `T0` is 2023, and the token would be treated as long
    // expired — which is the *other* test in this group.
    const page = await createPage();
    const email = addressFor(page.slug);
    const original = 1_699_000_000;

    await createSubscriber(page.id, email, {
      confirmedAt: original,
      confirmToken: "still-valid-token",
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const response = await callApi("/api/subscribe/confirm?token=still-valid-token");
    expect(response.status).toBe(200);

    const state = await subscriberState(page.id, email);
    expect(state!.confirmed_at).toBe(original);
    expect(state!.confirm_token).toBeNull();
  });

  it("refuses a link past its lifetime and clears it so it cannot be retried", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);

    // The route reads the clock itself, so the row is aged rather than the clock
    // being moved. 49 hours is past the 48-hour lifetime.
    const stale = Math.floor(Date.now() / 1000) - 49 * 3600;
    await createSubscriber(page.id, email, {
      confirmToken: "expired-token",
      updatedAt: stale,
    });

    const response = await callApi("/api/subscribe/confirm?token=expired-token");
    expect(response.status).toBe(410);
    expect(await response.text()).toContain("has expired");

    const state = await subscriberState(page.id, email);
    expect(state!.confirm_token).toBeNull();
    expect(state!.confirmed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

/** A valid unsubscribe link for a subscriber, signed with the deployment key. */
async function unsubscribeToken(
  subscriberId: number,
  pageId: number,
  options: { version?: number; exp?: number } = {},
): Promise<string> {
  return signUnsubscribeToken(
    {
      pageId,
      subscriberId,
      version: options.version ?? 1,
      exp: options.exp ?? Math.floor(Date.now() / 1000) + 3600,
    },
    workerEnv.UNSUBSCRIBE_HMAC_KEY,
  );
}

describe("GET /u/:token — renders, never acts", () => {
  it("renders a confirmation page and does not unsubscribe", async () => {
    // The load-bearing assertion of this whole file. A GET that unsubscribed
    // would let any mail scanner or link prefetcher silently remove a
    // subscriber, and the subscriber would never know why the mail stopped.
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, {
      confirmedAt: 1_699_000_000,
    });
    const token = await unsubscribeToken(subscriber.id, page.id);

    const response = await callApi(`/u/${encodeURIComponent(token)}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("Unsubscribe");
    expect(body).toContain(`<form method="post" action="/u/`);

    expect((await subscriberState(page.id, email))!.unsubscribed_at).toBeNull();
  });

  it("escapes the address it echoes back", async () => {
    // The address is in the page, and it is user-supplied. It arrives validated
    // on the public path, but a row can also be written by an operator or a
    // migration, so the renderer escapes rather than trusting the column.
    const page = await createPage();
    const email = `"><script>alert(1)</script>@example.com`;
    const subscriber = await createSubscriber(page.id, email, {
      confirmedAt: 1_699_000_000,
    });
    const token = await unsubscribeToken(subscriber.id, page.id);

    const body = await (await callApi(`/u/${encodeURIComponent(token)}`)).text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    // Escaped exactly once. Escaping at both the call site and in `renderPage`
    // would be safe but would show the reader `&lt;script&gt;` literally.
    expect(body).not.toContain("&amp;lt;");
  });

  it("refuses a token whose signature does not verify", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });
    const token = await unsubscribeToken(subscriber.id, page.id);

    // Flip the *first* character of the signature, not the last.
    //
    // A SHA-256 HMAC is 32 bytes, which base64 encodes as 43 characters — 258
    // bits for 256 bits of data. The final character therefore carries two
    // significant bits and four that the decoder discards, so changing it may
    // decode to the identical signature and the token still verifies. This test
    // passed and failed on the same code depending on which character happened to
    // be last, which is exactly the kind of flake that gets a real assertion
    // deleted. The first character has no such slack.
    const parts = token.split(".");
    const signature = parts[2]!;
    const flippedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const tampered = `${parts[0]}.${parts[1]}.${flippedSignature}`;

    const response = await callApi(`/u/${encodeURIComponent(tampered)}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not valid");
    expect((await subscriberState(page.id, email))!.unsubscribed_at).toBeNull();
  });

  it("refuses a token with a valid signature but a payload that was edited", async () => {
    // Re-signing is not possible without the key, but re-encoding the payload
    // under a signature taken from a different token is, and the signature
    // covers the encoded body verbatim precisely so that this fails.
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });
    const token = await unsubscribeToken(subscriber.id, page.id);
    const other = await unsubscribeToken(subscriber.id + 1, page.id);
    const parts = token.split(".");
    const otherParts = other.split(".");

    const swapped = `${parts[0]}.${otherParts[1]}.${parts[2]}`;
    const response = await callApi(`/u/${encodeURIComponent(swapped)}`);
    expect(response.status).toBe(400);
    expect((await subscriberState(page.id, email))!.unsubscribed_at).toBeNull();
  });

  it("refuses a token that has expired", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });

    // `exp` is inside the signed payload, so an expired link cannot be extended
    // by editing it — only by re-issuing it.
    const token = await unsubscribeToken(subscriber.id, page.id, {
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    const response = await callApi(`/u/${encodeURIComponent(token)}`);
    expect(response.status).toBe(410);
    expect(await response.text()).toContain("expired");
    expect((await subscriberState(page.id, email))!.unsubscribed_at).toBeNull();
  });

  it("refuses a token issued before the subscriber re-subscribed", async () => {
    // Version rotation: the only way to revoke every outstanding link at once
    // without storing one row per token.
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, {
      confirmedAt: 1_699_000_000,
      version: 1,
    });
    const stale = await unsubscribeToken(subscriber.id, page.id, { version: 1 });

    await env.DB.prepare("UPDATE subscriber SET version = 2 WHERE id = ?1")
      .bind(subscriber.id)
      .run();

    const response = await callApi(`/u/${encodeURIComponent(stale)}`);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("superseded");
    expect((await subscriberState(page.id, email))!.unsubscribed_at).toBeNull();
  });

  it("reports a subscriber that no longer exists", async () => {
    const page = await createPage();
    const token = await unsubscribeToken(987_654, page.id);

    const response = await callApi(`/u/${encodeURIComponent(token)}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no longer exists");
  });

  it("is unusable when no signing key is configured", async () => {
    // "Empty key" must mean "this deployment cannot unsubscribe", not "any
    // token is accepted". The guard is in the route, and this is the test that
    // would fail if someone "simplified" it away.
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });
    const token = await unsubscribeToken(subscriber.id, page.id);

    const response = await callApi(`/u/${encodeURIComponent(token)}`, {}, { UNSUBSCRIBE_HMAC_KEY: "" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not configured");
    expect((await subscriberState(page.id, email))!.unsubscribed_at).toBeNull();
  });
});

describe("POST /u/:token — RFC 8058 one-click", () => {
  it("unsubscribes", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });
    const token = await unsubscribeToken(subscriber.id, page.id);

    const response = await callApi(`/u/${encodeURIComponent(token)}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Unsubscribed");
    expect((await subscriberState(page.id, email))!.unsubscribed_at).not.toBeNull();
  });

  it("needs no request body", async () => {
    // RFC 8058 sends `List-Unsubscribe=One-Click` as a form body, and some
    // clients send nothing at all. The token in the path is the whole
    // authorisation, so the body must not be required.
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });
    const token = await unsubscribeToken(subscriber.id, page.id);

    const withBody = await callApi(`/u/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(withBody.status).toBe(200);
    expect((await subscriberState(page.id, email))!.unsubscribed_at).not.toBeNull();
  });

  it("is idempotent and keeps the original unsubscribe time", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });
    const token = await unsubscribeToken(subscriber.id, page.id);

    await callApi(`/u/${encodeURIComponent(token)}`, { method: "POST" });
    const first = (await subscriberState(page.id, email))!.unsubscribed_at;

    const second = await callApi(`/u/${encodeURIComponent(token)}`, { method: "POST" });
    expect(second.status).toBe(200);

    const after = (await subscriberState(page.id, email))!.unsubscribed_at;
    expect(after).toBe(first);
  });

  it("applies the same checks as GET", async () => {
    const page = await createPage();
    const email = addressFor(page.slug);
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });

    const expired = await unsubscribeToken(subscriber.id, page.id, {
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const staleVersion = await unsubscribeToken(subscriber.id, page.id, { version: 99 });

    for (const token of [expired, staleVersion, "garbage"]) {
      const response = await callApi(`/u/${encodeURIComponent(token)}`, { method: "POST" });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await subscriberState(page.id, email))!.unsubscribed_at).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

describe("notifyChange", () => {
  function context(sender: EmailSender, overrides: Partial<NotifyContext> = {}): NotifyContext {
    return {
      db: env.DB,
      sender,
      unsubscribeSecret: workerEnv.UNSUBSCRIBE_HMAC_KEY,
      publicBaseUrl: "https://status.test",
      now: realNow(),
      ...overrides,
    };
  }

  /**
   * Pull the unsubscribe token out of a delivered message.
   *
   * The header value is wrapped in angle brackets (`<url>`), which is why the
   * first slice starts at 1 — leaving it on produces a token with a leading `/`
   * and the endpoint refuses it, which looks exactly like a signing bug.
   */
  function tokenFrom(message: EmailMessage): string {
    const header = message.headers!["List-Unsubscribe"]!;
    const url = header.slice(1, -1);
    const prefix = "https://status.test/u/";
    expect(url.startsWith(prefix)).toBe(true);
    return url.slice(prefix.length);
  }

  it("delivers to a confirmed whole-page subscriber", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    await createSubscriber(page.id, "whole-page@example.com", { confirmedAt: 1_699_000_000 });

    const { sender, messages } = captureSender();
    const result = await notifyChange(context(sender), change.publicId, "created");

    expect(result.candidates).toBe(1);
    expect(result.sent).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toBe("whole-page@example.com");
    expect(messages[0]!.subject).toContain("opened");
    expect(messages[0]!.text).toContain("https://status.test/status/" + page.slug);
  });

  it("delivers only to subscribers who follow an affected component", async () => {
    // The `NOT EXISTS` clause keeps whole-page subscribers in and the join keeps
    // everyone else out. Getting this wrong in either direction is silent: an
    // inner join drops most subscribers, and no filter at all wakes people up
    // for services they never asked about.
    const page = await createPage();
    const api = await createComponent(page.id, { name: "API" });
    const web = await createComponent(page.id, { name: "Web" });

    await createSubscriber(page.id, "follows-api@example.com", {
      confirmedAt: 1_699_000_000,
      componentIds: [api.id],
    });
    await createSubscriber(page.id, "follows-web@example.com", {
      confirmedAt: 1_699_000_000,
      componentIds: [web.id],
    });
    await createSubscriber(page.id, "follows-nothing@example.com", {
      confirmedAt: 1_699_000_000,
    });

    const change = await createChange(page.id, { componentIds: [api.id] });
    const { sender, messages } = captureSender();
    const result = await notifyChange(context(sender), change.publicId, "created");

    expect(result.sent).toBe(2);
    expect(messages.map((message) => message.to).sort()).toEqual([
      "follows-api@example.com",
      "follows-nothing@example.com",
    ]);
  });

  it("does not deliver to an address that was never confirmed", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    await createSubscriber(page.id, "unconfirmed@example.com", { confirmedAt: null });

    const { sender, messages } = captureSender();
    const result = await notifyChange(context(sender), change.publicId, "created");

    expect(result.candidates).toBe(0);
    expect(messages).toHaveLength(0);
  });

  it("does not deliver to an address that unsubscribed", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    await createSubscriber(page.id, "opted-out@example.com", {
      confirmedAt: 1_699_000_000,
      unsubscribedAt: 1_699_000_500,
    });

    const { sender, messages } = captureSender();
    const result = await notifyChange(context(sender), change.publicId, "created");

    expect(result.candidates).toBe(0);
    expect(messages).toHaveLength(0);
  });

  it("carries a one-click unsubscribe link that the Worker itself accepts", async () => {
    // The end-to-end property: the URL the notification puts in the message is
    // the URL the unsubscribe endpoint honours. Both halves are tested
    // separately elsewhere; this is the join between them, and it is the one a
    // refactor of either side would break.
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    const email = "one-click@example.com";
    const subscriber = await createSubscriber(page.id, email, { confirmedAt: 1_699_000_000 });

    const { sender, messages } = captureSender();
    await notifyChange(context(sender), change.publicId, "created");

    expect(messages[0]!.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const token = tokenFrom(messages[0]!);

    const response = await callApi(`/u/${token}`, { method: "POST" });
    expect(response.status).toBe(200);

    const state = await env.DB.prepare("SELECT unsubscribed_at FROM subscriber WHERE id = ?1")
      .bind(subscriber.id)
      .first<{ unsubscribed_at: number | null }>();
    expect(state!.unsubscribed_at).not.toBeNull();
  });

  it("signs each recipient a token for their own subscription", async () => {
    // Not one shared link: a token carries the subscriber id and version, and a
    // recipient must not be able to act on someone else's subscription.
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    const first = await createSubscriber(page.id, "a@example.com", { confirmedAt: 1_699_000_000 });
    const second = await createSubscriber(page.id, "b@example.com", { confirmedAt: 1_699_000_000 });

    const { sender, messages } = captureSender();
    await notifyChange(context(sender), change.publicId, "created");
    expect(messages).toHaveLength(2);

    const tokens = messages.map(tokenFrom);
    expect(new Set(tokens).size).toBe(2);

    // Acting on the first recipient's link leaves the second subscribed.
    await callApi(`/u/${tokens[0]!}`, { method: "POST" });
    const states = await env.DB.prepare(
      "SELECT id, unsubscribed_at FROM subscriber WHERE id IN (?1, ?2) ORDER BY id",
    )
      .bind(first.id, second.id)
      .all<{ id: number; unsubscribed_at: number | null }>();
    expect(states.results[0]!.unsubscribed_at).not.toBeNull();
    expect(states.results[1]!.unsubscribed_at).toBeNull();
  });

  it("sends nothing when no signing key is configured", async () => {
    // Without a key there is no link that can be revoked, so there is no message
    // worth sending. The failure must be a refusal, not unsigned links.
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    await createSubscriber(page.id, "no-key@example.com", { confirmedAt: 1_699_000_000 });

    const { sender, messages } = captureSender();
    const result = await notifyChange(
      context(sender, { unsubscribeSecret: "" }),
      change.publicId,
      "created",
    );

    expect(result.disabled).toBe(true);
    expect(result.candidates).toBe(0);
    expect(messages).toHaveLength(0);
  });

  it("sends nothing when no public origin is configured", async () => {
    // A relative unsubscribe URL cannot be followed by a mail client, and a
    // notification a recipient cannot unsubscribe from is worse than silence.
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    await createSubscriber(page.id, "no-origin@example.com", { confirmedAt: 1_699_000_000 });

    const { sender, messages } = captureSender();
    const result = await notifyChange(
      context(sender, { publicBaseUrl: "" }),
      change.publicId,
      "created",
    );

    expect(result.disabled).toBe(true);
    expect(messages).toHaveLength(0);
  });

  it("stops at the daily budget and reports what it skipped", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    for (let index = 0; index < 3; index += 1) {
      await createSubscriber(page.id, `quota-${index}-${page.slug}@example.com`, {
        confirmedAt: 1_699_000_000,
      });
    }

    const now = realNow();
    const today = new Date(now * 1000).toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO email_quota (day, sent, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(day) DO UPDATE SET sent = ?2`,
    )
      .bind(today, DAILY_EMAIL_QUOTA, now)
      .run();

    const { sender, messages } = captureSender();
    const result = await notifyChange(context(sender), change.publicId, "created");

    expect(result.candidates).toBe(3);
    expect(result.sent).toBe(0);
    expect(result.skippedQuota).toBe(3);
    expect(messages).toHaveLength(0);
  });

  it("bounds one event's work", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    for (let index = 0; index < 3; index += 1) {
      await createSubscriber(page.id, `bound-${index}-${page.slug}@example.com`, {
        confirmedAt: 1_699_000_000,
      });
    }

    const { sender, messages } = captureSender();
    const result = await notifyChange(context(sender, { maxPerEvent: 2 }), change.publicId, "created");

    expect(result.candidates).toBe(2);
    expect(result.sent).toBe(2);
    expect(messages).toHaveLength(2);
  });

  it("records a send failure and carries on with the rest", async () => {
    // An operator's incident update must not fail because a mail provider did.
    // The failure is reported rather than swallowed, but it does not stop the
    // loop.
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, { componentIds: [component.id] });
    await createSubscriber(page.id, "will-fail@example.com", { confirmedAt: 1_699_000_000 });

    const { sender, messages } = captureSender({ fail: true });
    const result = await notifyChange(context(sender), change.publicId, "created");

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    // The address is redacted in the error, which is the only place it could
    // leak into a log line.
    expect(result.errors[0]).toContain("w***@example.com");
    expect(messages).toHaveLength(1);
  });

  it("reports an unknown change instead of throwing", async () => {
    const { sender } = captureSender();
    const result = await notifyChange(context(sender), "chg-does-not-exist", "created");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("chg-does-not-exist");
  });

  it("labels a resolution as a resolution", async () => {
    const page = await createPage();
    const component = await createComponent(page.id);
    const change = await createChange(page.id, {
      componentIds: [component.id],
      status: "resolved",
      endsAt: 1_700_000_600,
    });
    await createSubscriber(page.id, "resolved@example.com", { confirmedAt: 1_699_000_000 });

    const { sender, messages } = captureSender();
    await notifyChange(context(sender), change.publicId, "resolved");

    expect(messages[0]!.subject).toContain("resolved");
    expect(messages[0]!.text).toContain("resolved");
  });
});
