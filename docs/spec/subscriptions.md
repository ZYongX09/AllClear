# Subscriptions: subscribe, confirm, unsubscribe (M5)

**Status: implemented and unit-tested, but not verified against a real mailbox.**
The endpoints are `apps/api/src/subscribe/routes.ts`; the signed tokens are
`apps/api/src/subscribe/tokens.ts`; the sender and the send quota are
`apps/api/src/subscribe/email.ts`; recipient selection and delivery are
`apps/api/src/subscribe/notify.ts`; the rate limiter is
`apps/api/src/lib/rate-limit.ts`. The evidence is
`apps/api/test/subscribe.test.ts`. The test bindings are declared in
`apps/api/vitest.config.ts`. This document explains the design and, at the end,
what it does not claim.

**The single most important limitation is stated here rather than buried: no
email provider binding is configured by default.** `apps/api/wrangler.jsonc`
declares no `send_email` binding, and `EMAIL` is optional in the `Env` type. When
it is absent, `createEmailSender` returns a *recording* sender that logs the
message and reports success. **With the recording sender, no email is
delivered.** The double opt-in flow is therefore implemented and unit-tested but
has not been exercised end to end against a real mailbox.

## The three endpoints, and the fourth path

Four HTTP entry points exist. Three are named in the module header; the fourth is
the GET half of the unsubscribe pair.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/status/:slug/subscribe` | Record an address and its component selection, then send a confirmation link. |
| `GET` | `/api/subscribe/confirm?token=` | Complete the opt-in. |
| `GET` | `/u/:token` | Render a confirmation page. Mutates nothing. |
| `POST` | `/u/:token` | Perform the unsubscribe. |

### Why unsubscribe is split across GET and POST

`GET /u/:token` renders a page containing a form; `POST /u/:token` is what
actually unsubscribes. The split is not cosmetic. Mail providers and security
scanners fetch every link in a message, and an unauthenticated `GET` that mutated
state would let a scanner silently unsubscribe people. RFC 8058 one-click posts
to the same URL, so the mutating half is a `POST` and both paths share one
implementation.

`POST /u/:token` does not read the request body. RFC 8058 sends
`List-Unsubscribe=One-Click` as a form body and some clients send nothing at all,
so the token in the path is the entire authorisation. The test "needs no request
body" exercises both forms.

The load-bearing assertion is the test "renders a confirmation page and does not
unsubscribe": it fetches the link, asserts the page contains a POST form, and
asserts the subscriber's `unsubscribed_at` is still null.

## RFC 8058 one-click

Every delivered message carries two headers, set in `notify.ts`:

| Header | Value |
| --- | --- |
| `List-Unsubscribe` | `<https://<origin>/u/<token>>` |
| `List-Unsubscribe-Post` | `List-Unsubscribe=One-Click` |

The token is re-derived per message rather than stored, so each recipient gets a
capability signed for their own subscription. The test "carries a one-click
unsubscribe link that the Worker itself accepts" takes the token out of the
header of a captured message and posts it to the Worker, which is the join
between the two halves — a refactor of either side would break it. "signs each
recipient a token for their own subscription" asserts the two recipients'
tokens differ and that acting on one leaves the other subscribed.

## Double opt-in: nothing is delivered before confirmation

A subscriber is created with `confirmed_at` NULL and a `confirm_token`. Nothing
is sent to the address until the confirmation link is followed. This is what
stops the form being used as a mail relay against a stranger.

The recipient query in `notifyChange` enforces it in SQL rather than in code that
could be forgotten:

```sql
WHERE s.page_id = ?1
  AND s.confirmed_at IS NOT NULL
  AND s.unsubscribed_at IS NULL
```

The tests "does not deliver to an address that was never confirmed" and "does not
deliver to an address that unsubscribed" both assert zero candidates and zero
messages.

The confirmation token is a single-use value: `GET /api/subscribe/confirm`
consumes it by setting `confirm_token = NULL`, so following the same link again
finds nothing and returns `410`. `confirmed_at` is written with
`COALESCE(confirmed_at, ?2)`, so a scanner re-fetching a still-valid link or a
double click does not move the moment the opt-in actually happened. The test
"does not move an existing confirmation time" asserts the original timestamp
survives.

The token lifetime is `CONFIRM_TOKEN_TTL_SECONDS` (48 hours), checked against the
row's `updated_at`. When the link is past its lifetime the route **clears the
token as well**, so the expired link cannot be retried; the test "refuses a link
past its lifetime and clears it so it cannot be retried" asserts both the `410`
and the nulled token. Note that `updated_at` doubles as the issue time — there is
no dedicated issued-at column.

## What the subscribe endpoint deliberately does not reveal

A successful subscribe always returns the same body, `202 { "ok": true }`,
whether the address was new, already pending, or already confirmed. Telling them
apart would turn the endpoint into an oracle for "is this address subscribed to
this page", which the caller has no business asking. The cost is that the UI
cannot say "you were already subscribed"; the module header calls that the right
trade.

The test "answers identically for a new, a pending and a confirmed address"
submits the same address three times across all three states and asserts the
response bodies are byte-identical.

Two consequences of the uniform response are worth noting. Re-subscribing an
address that had opted out bumps `version` and clears `unsubscribed_at` but
leaves `confirmed_at` NULL, so the opt-out cannot be undone by anyone who merely
types the address into the form — a fresh confirmation is required. And
re-subscribing an already-confirmed address clears its confirmation and issues a
new token, so an address cannot keep receiving mail from an opt-in the holder
cannot see.

## Rate limiting: two dimensions, and only one carries the guarantee

`consumeRateLimit` in `apps/api/src/lib/rate-limit.ts` is a fixed-window counter
incremented by a single statement (`INSERT ... ON CONFLICT DO UPDATE SET count =
count + 1 RETURNING count`), so it is atomic under concurrency. The unit is
consumed even when the request is then rejected, which keeps the counter
monotonic so a client cannot restore its own budget by continuing to hammer. The
window admits up to twice the limit across a boundary, and the migration says so
rather than pretending otherwise.

The subscribe endpoint applies two limits, both over `SUBSCRIBE_WINDOW_SECONDS`
(3600):

| Dimension | Constant | Limit | Bucket name |
| --- | --- | --- | --- |
| Per address | `SUBSCRIBE_EMAIL_LIMIT` | 3 | `subscribe:email:<hash>` |
| Per client IP | `SUBSCRIBE_IP_LIMIT` | 10 | `subscribe:ip:<hash>` |

The per-address limit is applied first and is the one that matters: it stops a
script from mailing a victim repeatedly. The per-IP limit is weaker **here**,
because this Worker is reachable only through the web app's Service Binding, so
the client IP is whatever the caller forwards — the code reads `CF-Connecting-IP`
then `X-Forwarded-For` and falls back to the literal `"unknown"`. If the caller
forwards nothing, every client shares one bucket. The module header states this
rather than papering over it: the address dimension is what carries the
guarantee, and the IP dimension is best-effort.

The test "stops a script from mailing one address repeatedly" drives the
per-address limit to a `429`; "keeps the counter monotonic, so hammering does not
restore the budget" asserts it stays rejected; "limits by client IP as well as by
address" drives the IP limit and asserts a different IP is unaffected.

### Why the address is hashed into the bucket name

`hashForBucket` computes a SHA-256 hex digest and takes 32 characters of it. The
address never reaches `rate_limit.bucket` verbatim. `rate_limit.bucket` is a
plain text column, and a counter table is not the place to accumulate a list of
email addresses. The same helper hashes the IP.

## The signed unsubscribe token

A token is `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`, produced by
`signUnsubscribeToken`. The payload has exactly four fields:

| Field | Meaning |
| --- | --- |
| `pageId` | Internal `page.id`. The token is opaque to its holder. |
| `subscriberId` | Internal `subscriber.id`. |
| `version` | `subscriber.version` at issue time. |
| `exp` | Expiry, epoch seconds. |

`DEFAULT_TOKEN_TTL_SECONDS` is 180 days. The signature covers the *encoded
payload verbatim*, so the payload cannot be re-encoded with different field
ordering or whitespace and still verify; the comparison uses
`crypto.subtle.verify`, which is constant-time. An empty secret is a hard error
in `signUnsubscribeToken` rather than a silent fallback, because a token signed
with an empty secret would be forgeable by anyone.

The server re-checks four things on every use, split across two functions:

| Check | Where | Rejection |
| --- | --- | --- |
| Structure and signature | `verifyUnsubscribeToken` | `400` (malformed or bad signature) |
| Expiry (`exp <= now`) | `verifyUnsubscribeToken` | `410` |
| The subscriber still exists | `loadUnsubscribeTarget` | `404` |
| `version` matches the row | `loadUnsubscribeTarget` | `409` |

`version` rotation is the revocation mechanism. Incrementing `subscriber.version`
invalidates every outstanding link for that subscriber at once, which is the only
revocation available without storing one row per token. The column is bumped when
an unsubscribed address asks to come back; the test "bumps the version when an
unsubscribed address asks to come back" asserts it, and "refuses a token issued
before the subscriber re-subscribed" asserts the stale link returns `409`.

The `exp` check means a leaked link is bounded, and because `exp` is inside the
signed payload an expired link cannot be extended by editing it — only by
re-issuing it.

An empty `UNSUBSCRIBE_HMAC_KEY` makes the endpoint unusable rather than
permissive: `loadUnsubscribeTarget` returns a `400` with "Unsubscribing is not
configured on this deployment". The test "is unusable when no signing key is
configured" is the one that would fail if that guard were simplified away.

## The global daily send ceiling

`email_quota` is a single counter per UTC day. `consumeEmailQuota` increments and
returns the new value in one statement:

```sql
INSERT INTO email_quota (day, sent, created_at, updated_at)
VALUES (?1, 1, ?2, ?2)
ON CONFLICT(day) DO UPDATE SET sent = sent + 1, updated_at = ?2
RETURNING sent
```

The caller treats `allowed = used <= limit`, so a counter already at the limit
means the next send is refused. The ceiling is `DEFAULT_DAILY_EMAIL_QUOTA`
(2000) in `notify.ts`, mirrored by `DAILY_EMAIL_QUOTA` (2000) in `routes.ts`. The
purpose is that a runaway loop — a subscriber list that suddenly matches
everything, a retry storm — hits a wall instead of a bill.

The ceiling is **approximate, bounded by concurrency, not exact**. The check and
the increment are one atomic statement, but the send happens after it, so
concurrent requests can each observe `used` at or below the limit before the
others' increments land. The overshoot is bounded by the number of concurrent
sends rather than unbounded growth, which the `email.ts` header identifies as the
property that matters.

One ordering detail is worth stating because the comments disagree with the code.
The `email.ts` header and the `0002_m1_model.sql` comment describe the quota as
"checked before the send and incremented after". The implementation increments
*within* `consumeEmailQuota`, before the caller sends, so the increment precedes
the send. The code's order is the safer one (the slot is reserved before it is
used); the comments describe a different order. See the note in the final
section.

## Recipient selection

A subscriber follows either a set of components or the whole page. The rule is:

* a subscriber who follows **no** component receives everything on the page;
* a subscriber who follows a component receives a change only when it touches one
  of their components.

The selection is expressed in one query, and the clause that makes it work is a
`NOT EXISTS`:

```sql
AND (
      NOT EXISTS (SELECT 1 FROM subscriber_component sc WHERE sc.subscriber_id = s.id)
      OR EXISTS (
           SELECT 1
             FROM subscriber_component sc
             JOIN change_component cc ON cc.component_id = sc.component_id
            WHERE sc.subscriber_id = s.id AND cc.change_id = ?2
         )
    )
```

The first branch is what keeps whole-page subscribers in the result. Without it,
a join between `subscriber` and `change_component` would drop every subscriber
who selected nothing — which is the majority. The test "delivers only to
subscribers who follow an affected component" creates three subscribers
(following API, following Web, following nothing) and a change on API, and
asserts exactly the API follower and the whole-page subscriber receive it.

The file header calls this a `LEFT JOIN`; the query contains no `LEFT JOIN`. The
inline comment next to the SQL describes the `NOT EXISTS` correctly, so the
header wording is stale. See the final section.

Two bounds apply to a single event. `MAX_RECIPIENTS_PER_EVENT` (500) caps the
recipient query with a `LIMIT`, bounding one request's work; the test "bounds one
event's work" passes `maxPerEvent: 2` and asserts two candidates. The daily
quota is then applied per recipient, so a quota-exhausted event reports the
skipped count rather than failing; "stops at the daily budget and reports what it
skipped" asserts `sent: 0`, `skippedQuota: 3`.

## Failure is contained, and the address is redacted

A send failure is recorded and the loop continues. `notifyChange` returns a
report (`candidates`, `sent`, `failed`, `skippedQuota`, `disabled`, `errors`)
rather than throwing, and `notifyChangeSafely` logs it without ever letting a
notification failure reach the caller. The admin write has already committed;
turning a provider outage into a `500` there would tell an operator their
incident update failed when it did not, and the natural reaction — saving again —
would create a duplicate timeline entry. This is containment, not silence: the
counts and errors are in the log line, and a `disabled` or `skippedQuota` result
means the message genuinely did not go out.

The address never appears in a log line. Failed sends record
`<redacted>: <error>`, where `redactEmail` renders `a***@example.com` — enough to
correlate a log entry, not enough to be a leak. The recording sender logs the
same redacted form, and the test "records a send failure and carries on with the
rest" asserts the redacted address appears in `errors`.

Notification is skipped entirely, with `disabled: true`, when either
`UNSUBSCRIBE_HMAC_KEY` or `PUBLIC_BASE_URL` is empty. Without a signing key there
is no link that can be revoked, and a relative URL cannot be followed by a mail
client; the module header calls sending in that state worse than silence. The
tests "sends nothing when no signing key is configured" and "sends nothing when
no public origin is configured" cover both.

Unsubscribing is idempotent: `POST /u/:token` writes
`unsubscribed_at = COALESCE(unsubscribed_at, ?2)`, so a second click leaves the
original time in place and still returns success. The test "is idempotent and
keeps the original unsubscribe time" asserts the timestamp is unchanged.

## Test bindings

`apps/api/vitest.config.ts` injects a small set of fixtures for the local
`workerd` instance. They are fixtures for the duration of a test run, not
credentials, and the file says so. They are named, here, without their values:
`INTERNAL_KEY`, `UNSUBSCRIBE_HMAC_KEY`, `PUBLIC_BASE_URL`, `EMAIL_FROM` and
`MAX_TARGETS_PER_RUN`. A test that needs to forge a link the Worker will accept
reads `UNSUBSCRIBE_HMAC_KEY` through `workerEnv`.

One property of the test suite is a limitation of the code it tests: the
subscribe and unsubscribe routes read the clock directly
(`Math.floor(Date.now() / 1000)`) rather than accepting `now`, so those tests
cannot pin time. Where a test needs an old timestamp it writes one into the row
instead of pretending the clock moved.

## What this does not claim

* **No email is delivered.** No `send_email` binding is configured; the sender
  falls back to recording. The double opt-in flow is implemented and unit-tested
  but has not been verified end to end against a real mailbox. This is the
  headline limitation, not a footnote.
* **The per-IP rate limit is not a real per-client limit.** It is keyed on
  whatever the caller forwards and collapses to one bucket when nothing is
  forwarded. The per-address dimension is the guarantee.
* **The daily ceiling is approximate.** It bounds the overshoot to concurrent
  sends rather than making it impossible.
* **The rate limiter's fixed window admits up to twice the limit across a
  boundary.** This is a documented trade, not a bug being hidden.
* **Confirmation has no resend path and no per-address cap beyond the shared
  rate limit.** There is no endpoint to re-issue a confirmation link other than
  submitting the subscribe form again.
* **`readEmailQuota` is unused.** `email.ts` describes it as "used by the admin
  view", but no route or service calls it.
* **No bounce or complaint handling.** Nothing reads delivery feedback, because
  nothing sends.
* **The unsubscribe page markup is written for this Worker.** It is served by the
  API Worker, which has no asset pipeline, so the page is a self-contained
  string with inline styles rather than a shared stylesheet.
