# The admin console (M2)

**Status: implemented and driven in a real browser.** The console lives in
`apps/web/app/admin/`; the session and the write gate are
`apps/web/lib/admin-session.ts`; the API client is `apps/web/lib/admin-api.ts`;
the shared form plumbing is `apps/web/components/admin/`. The routes it drives
are documented in [admin-api.md](admin-api.md), which owns the wire contract.
This document owns what the operator sees, and — more importantly — the
security boundary that makes an unauthenticated `/admin` safe to exist.

## Why a console exists at all

The API Worker is closed. It has no public route and every `/internal/*` request
must present `INTERNAL_KEY`. A Server Action in the web Worker is not closed: it
compiles to a public POST endpoint, reachable by anyone who can reach the page,
and it attaches `INTERNAL_KEY` on the way out. So a console without its own gate
would not be "an internal tool behind an internal API" — it would be a public
write surface with the Worker's own credential wired into it. That is the hole
`apps/api/src/index.ts` warns about from the other side: **reachability is not
authorisation**, and a Server Action is reachable.

The gate therefore exists because the runtime makes the action public, not
because the console is a nice place to put a login.

## Two credentials, and why they are different

| Credential | Held by | Answers | Attached to |
| --- | --- | --- | --- |
| `INTERNAL_KEY` | the web Worker, server-side only | "this request comes from the web Worker" | `X-Internal-Key` on every `/internal/*` call |
| `ADMIN_TOKEN` | the operator, and the web Worker's env | "a human who knows it is operating this console" | nothing on the wire — it gates the console itself |

They are deliberately **not the same value**. `INTERNAL_KEY` is a property of the
deployment; `ADMIN_TOKEN` is a property of the request. Sharing one would mean
every operator knows the credential the Worker uses to reach the API, and
rotating it to revoke one person would break the site. `apps/web/cloudflare.config.ts`
states this at the binding.

**The browser never receives either.** `INTERNAL_KEY` and `ADMIN_TOKEN` are both
`bindings.secret()`, read from `env` inside the Worker, and neither is
serialised into the page. What the browser holds is a session cookie, described
next.

## The session cookie

After signing in, the browser holds one cookie, `allclear_admin`, whose value is
`<expiresAt>.<hmac>` — an expiry and an HMAC over it. No secret travels in either
direction once the operator has typed the token.

| Attribute | Value | Why |
| --- | --- | --- |
| `HttpOnly` | always | Script cannot read it, so an XSS on the console cannot exfiltrate the session. |
| `Secure` | always | The console is only reached over HTTPS in a real deployment; `localhost` is a secure context, so local development still works. |
| `SameSite` | `Lax` | The console is navigated to, not embedded, so `Lax` is enough. |
| `Path` | `/admin` | The cookie is **not sent to the public status pages**, which are a different surface with different visitors. |
| `maxAge` | 12 hours | A fixed session with no renewal, shown in the header so an operator about to start a maintenance window can see whether they will still be signed in when it ends. |

The HMAC is keyed with `ADMIN_TOKEN` itself rather than a separate signing key.
That makes revocation trivial and total — rotating `ADMIN_TOKEN` invalidates every
session at once — at the cost of the token being sufficient to forge a cookie
from a stolen one. Since a stolen cookie is already equivalent to the session,
and the token is what the operator types to obtain a session in the first place,
that is not a meaningful loss.

Verification checks four things, all of which matter: the shape, the expiry, the
signature, and that a token is configured at all. A verifier that skipped the
signature would accept any expiry an attacker chose; one that skipped the expiry
would accept a session forever; one that accepted an empty configured token would
open the console on any deployment that forgot to set one. `tokenMatches` returns
`false` when no token is configured, so **an unconfigured deployment refuses
every sign-in attempt rather than accepting an empty string** — the failure
direction is closed.

The comparison is constant-time. Length is compared first and returns early,
which leaks the length; that is unavoidable without padding and is not a useful
signal for a secret whose length the attacker cannot choose.

## Two gates, and why both

The sign-in check is in `apps/web/app/admin/layout.tsx`, so every route under
`/admin` is behind it by *existing* rather than by remembering. That is what a
layout buys: a page added later is gated automatically.

It is not enough on its own. **A layout decides what is rendered, and rendering
is not authorisation** — the action still runs if a client posts to it directly.
So every one of the 17 write actions in `apps/web/app/admin/actions.ts` begins
with the same guard:

```ts
const denied = await guard();
if (denied !== null) return denied;
```

`guard()` reads the session and returns a `not_signed_in` form state when there
is none. The layout gate is the user-facing half; the action guard is the
security half, and the two are independent on purpose.

This was verified against the running fixture, not by reading the code: the
rendered create-page form was POSTed with its real hidden action fields but
`credentials: "omit"`, and the response carried `not_signed_in` with no success
outcome, while a follow-up read confirmed nothing was created. Dropping the
cookie is exactly what an unauthenticated caller has, so this is the real
question, asked directly.

## What the operator sees

**`/admin`** is the index. It reads the page list and the email budget in
parallel and renders:

* a budgets panel — enabled probe targets against `MAX_ENABLED_TARGETS`, and
  today's sends against the daily ceiling. A missing counter renders as `—`, not
  as `0`, because "we could not read it" and "nothing was sent" are different
  facts and the panel would otherwise assert the second;
* a table of pages, each row carrying its counts and a link to its detail page;
* a create-page form.

**`/admin/pages/[slug]`** is the working surface. It reads the admin view and the
*public* snapshot in parallel — the public one deliberately, because that is
where a stale snapshot is discovered. The `SnapshotPanel` derives each
component's status from the published evidence using the same pure functions the
public page uses, so the console and the status page cannot disagree about what
the data means. Sections, components, probe targets, change history and
hand-entered impacts each get a panel with their own forms. Saves update the
D1 summary immediately server-side; the console explains that global hot caches
can retain a prior summary for up to 30 seconds and budgeted two-key KV
checkpoints are independently due every 600 seconds, not globally simultaneous
publication.

The panel shows statuses the admin view cannot: `unknown` for a component with no
probe target, and `unknown` for one whose probe has gone stale. Those are the
answers the derivation is supposed to give, and seeing them in the console is how
an operator notices that monitoring has a hole.

## Three write operations that are deliberately absent

The console can create, update and delete sections, components, probe targets,
changes and manual impacts. Three things it cannot do, each for a reason:

1. **No delete for a page.** A page is the root of a component tree, a change
   history, a subscriber list and an uptime rollup. Deleting one is not a console
   operation; it is a data-migration decision with a blast radius the UI cannot
   show.
2. **No delete for a change.** A change is a public record of something that
   happened. An incident that can be deleted from the console is an incident that
   can be deleted from the history, and the whole point of the history is that it
   is not editable. Changes are closed, not removed.
3. **No editing of probe-generated impacts.** The `impacts` array the API returns
   is filtered to hand-entered rows (`probe_target_id IS NULL`), so every row the
   console receives is one it may close. A probe-generated impact is owned by the
   probe state machine; an operator who closed one by hand would be closing an
   impact the next probe run is about to reopen.

These are recorded here rather than left to look like unfinished work.

## The console is not localised

The status page ships zh-CN and en-US because it has visitors. The console has
operators — the same one or two people who read the API's error codes — and
doubling every string in it would buy nothing. Every console string is English
and is written inline rather than through `next-intl`.

It also has no locale switch and no theme toggle of its own; it inherits both
from the root layout, so an operator who has set dark mode for the status page
gets dark mode here too. What it does set is `robots: { index: false, follow:
false }`, because a console has no business in an index — `noindex` rather than a
`robots.txt` rule so the instruction travels with the page, including on a
preview deployment whose hostname nobody remembered to exclude.

## The form plumbing, and one bug worth recording

The forms are Server Components that render a client wrapper holding
`useActionState`, with the inputs passed in as `children`. That split exists
because `useActionState` is a hook and the action is a server reference; keeping
the hook in a small client component lets the page itself stay a Server
Component.

The wrapper lives in `apps/web/components/admin/admin-form.tsx`, alongside
`AdminField`, `AdminSelect` and `AdminMessage`. One defect found during browser
verification is worth recording because it was invisible to reading:

**`AdminField` derived its `id` from the field name and label.** The detail page
has seven inputs all named `name` with the label "Name" — one per section and per
component — so all seven shared the id `admin-name-name`. A `<label for>` resolves
to the first matching element, so clicking any of those labels focused the first
input on the page. The browser DOM snapshot made it obvious
(`textbox "Name Name Name Name Name Name Name"`); no amount of reading the
component in isolation would have. `useId()` now generates the id, and the same
fix was applied to `AdminSelect` and `DateTimeField` for the same reason.

## `DateTimeField`, and time zones

The forms take timestamps as epoch seconds, but an operator types a local
date and time. `DateTimeField` renders a visible `datetime-local` input (unnamed,
so it never reaches the server) plus a hidden input carrying the epoch value. The
time zone name is filled in after mount, because the server does not know the
operator's zone and rendering a guess into the initial HTML would be worse than
rendering nothing.

## The verify fixture

`apps/web/verify/admin-stub.ts` is a mutable in-memory store answering
`/internal/admin/*`, wired into the existing public fixture by
`apps/web/verify/api-stub.ts`. It is asked first and answers only for
`/internal/admin*`, so it cannot shadow a public route.

Two things about it are deliberate:

* **It checks only that `X-Internal-Key` is present**, not its value. The fixture
  has no copy of the real secret and should not have one; the value comparison is
  the API Worker's job and is tested there. The stub exists to make the console
  render and writable, not to re-test the API's authentication.
* **It reproduces the absent/null/string distinction** the API makes for
  explicitly-nullable fields such as `sectionPublicId`, because that distinction
  is what the console's "move a component out of a section" path depends on.
  A stub that collapsed `null` and absent would have made a broken path look
  correct.

## What this does not claim

* **There is no identity model.** No accounts, no roles, no per-person
  authentication. Everyone who knows `ADMIN_TOKEN` is equally authorised, and
  every `audit_log` entry records a null actor because there is no actor to
  record. This is the same boundary the API Worker documents, for the same
  reason: inventing an identity model nothing authenticates against would be
  worse than having none.
* **There is no CSRF token.** The session cookie is `SameSite=Lax`, which stops a
  cross-site form POST from carrying it, and every write is a POST to a Server
  Action. That is the whole control; there is no per-request token and no origin
  check.
* **No rate limiting on sign-in.** `ADMIN_TOKEN` is compared in constant time,
  but an attacker who can reach the console may guess as often as they like.
  Cloudflare Access in front of `/admin/*` is the hardening the plan lists as
  optional, and it is not implemented here.
* **The fixture is not the API.** The console was verified against
  `verify/admin-stub.ts`, not against a live `allclear-api` and a live D1. The
  stub reproduces the contract as documented, including the absent/null
  distinction, but it cannot prove the real API behaves identically. What was
  proven is that the console's rendering, its form encoding, its session gate and
  its action guard all work against a real HTTP surface.
* **Sign-out is a cookie delete, not a revocation.** It clears the browser's
  cookie; it does not invalidate anything server-side, because there is nothing
  server-side to invalidate. Rotating `ADMIN_TOKEN` is what invalidates sessions
  in bulk.
* **The console has no test suite.** It was exercised in a browser; it has no
  automated tests. `docs/spec/testing.md` records that gap.
