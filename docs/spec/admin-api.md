# The admin API (M2)

**Status: implemented and tested.** The HTTP surface is
`apps/api/src/admin/routes.ts`; the write logic is `apps/api/src/admin/service.ts`;
the validation helpers are `apps/api/src/admin/validate.ts`; the `/internal/*`
middleware is in `apps/api/src/index.ts`. The evidence is
`apps/api/test/admin.test.ts`, which runs against a real `workerd` with a real D1
binding. The tables being written are in
`apps/api/migrations/0002_m1_model.sql`. This document explains the design and, at
the end, what it does not claim.

## Two independent conditions, and why both exist

Everything under `/internal/*` passes through one middleware in
`apps/api/src/index.ts` before any handler runs. It enforces the second of two
conditions; the first is architectural.

| Condition | Enforced by | Failure |
| --- | --- | --- |
| The request arrived over the Service Binding | `workers_dev: false` and no route in `apps/api/wrangler.jsonc`; the web Worker declares the binding in `apps/web/cloudflare.config.ts` | The Worker has no public origin to call |
| The request presents the shared key | The `/internal/*` middleware, comparing `X-Internal-Key` against `INTERNAL_KEY` | `503` if no key is configured, `401` otherwise |

The middleware reads `INTERNAL_KEY` first. An empty value returns
`503 internal_key_not_configured` rather than falling through, so "the secret was
never set" is a refusal and not an open door. A non-matching header returns
`401 unauthorized`. The comparison is `constantTimeEqual`, which encodes both
sides and folds the byte difference into one accumulator, so a caller cannot
learn the key one character at a time from response timing.

The reason the key exists at all, in the words of the code, is that
**reachability is not authorisation**. The comment in `index.ts` says the second
check matters because "if this Worker ever gains a public route, or another
Worker is added to the account, 'the request came from the expected place' would
silently stop being true". `wrangler.jsonc` states the same thing from the
deployment side: the Service Binding is the primary boundary and `INTERNAL_KEY`
is "a second, independent check, because reachability through a Service Binding
is not authorisation". A Service Binding tells the API Worker *which* Worker
called it; it does not establish a trusted identity for the request, and it is a
property of the deployment rather than of the request. A key is a property of the
request, so it survives a change to the deployment.

The test suite pins both halves. "refuses a request with no key" and "refuses a
request with the wrong key" assert 401; "does not expose the admin namespace
publicly" calls the same path without the key and asserts 401; "accepts the
configured key" asserts 200.

## The route table

The admin routes are mounted at `/internal/admin`. All of them are thin: they
parse and validate the body, call a function in `service.ts`, and translate the
result. Validation is in `validate.ts`. The module header states the reason — "a
route that contains business logic is a route that cannot be tested without an
HTTP request".

### Read

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `GET` | `/pages` | Every page with its counts (sections, components, enabled probe targets). The console's index. | None. |
| `GET` | `/email-quota` | Today's send counter and the daily ceiling, for the console's budget panel. | None. |
| `GET` | `/pages/:slug` | The admin view of one page: the page row plus its sections, components, probe targets (with scheduler state), 100 most recent changes, and up to 100 hand-entered impacts. | None beyond the slug. Unknown slug returns `404 page_not_found`. |

`GET /pages/:slug` returns two arrays that a reader might expect to be one.
`changes` is the incident/maintenance history; `impacts` is *only* the
hand-entered outage intervals, filtered on `probe_target_id IS NULL` and
`change_id IS NULL`. The filter is deliberate: a probe-generated impact is owned
by the probe state machine, and an operator who could close one by hand would be
closing an impact the next probe run is about to reopen. The console therefore
renders a close button for every row it receives in `impacts`, without having to
re-check which kind each one is.

### Pages (write)

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `POST` | `/pages` | Create a status page. Returns `201`. | `slug` required, matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 64; `name` required, max 120. A duplicate slug is caught as a unique-constraint violation and reported as `400` with field `slug`, not as a raw SQLite error. |
| `PATCH` | `/pages/:slug` | Rename a page. | `name` max 120. Optional. |

### Sections

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `POST` | `/pages/:slug/sections` | Create a section. | `name` required, max 120; `description` optional, max 2000; `orderId` optional integer. |
| `PATCH` | `/sections/:publicId` | Update a section. | `name` max 120; `description` max 2000; `orderId` integer. All optional. |
| `DELETE` | `/sections/:publicId` | Delete a section. | None. Components are not deleted with it. |

### Components

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `POST` | `/pages/:slug/components` | Create a component, optionally inside a section. | `name` required, max 120; `description` max 2000; `sectionPublicId` optional; `orderId`; `availableSince`. |
| `PATCH` | `/components/:publicId` | Update a component. | `name` max 120; `description` max 2000; `sectionPublicId` nullable; `orderId`. |
| `DELETE` | `/components/:publicId` | Delete a component. | None. |

### Changes

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `POST` | `/pages/:slug/changes` | Open an incident or schedule a maintenance window. Notifies on incident creation. | `kind` one of `incident`/`maintenance`; `title` required, max 200; `body` max 20 000; `severity` one of `none`/`degraded_performance`/`partial_outage`/`full_outage`; `componentPublicIds` array, max 200 entries; `startsAt`, `scheduledStartAt`, `scheduledEndAt`. |
| `POST` | `/changes/:publicId/updates` | Append a timeline entry; may carry per-component overrides. Notifies. | `status` one of the five change statuses; `body` required, max 20 000; `componentOverrides` optional array of `{componentPublicId, status}` where status is one of `operational`/`degraded_performance`/`partial_outage`/`full_outage`/`maintenance`. |
| `PATCH` | `/changes/:publicId` | Set a change's status directly. Notifies. | `status` one of the five; `endsAt` optional integer. |

### Manual impacts

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `POST` | `/pages/:slug/impacts` | Record a hand-entered outage interval. | `componentPublicId` required; `severity` one of the three fault severities; `startAt` required integer ≥ 0; `endAt` optional integer ≥ 0. |
| `POST` | `/impacts/:publicId/close` | Close a hand-entered interval. | `endAt` required integer ≥ 0. |

### Probe targets

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `POST` | `/probes` | Create a probe target and its scheduler row. | `componentPublicId` required; `url` required, max 2000; `method` `GET`/`HEAD`; `severity` one of the three fault severities; `expectedStatus` 100–599; `timeoutMs` 1000–30 000; `intervalSeconds` 60–86 400; `failureThreshold` and `recoveryThreshold` 1–10; `enabled` boolean. |
| `PATCH` | `/probes/:publicId` | Update a probe target. | The same fields, all optional. |
| `DELETE` | `/probes/:publicId` | Delete a probe target. | None. |

### Publish

| Method | Path | Purpose | Validation |
| --- | --- | --- | --- |
| `POST` | `/pages/:slug/rebuild` | Advance the version and refresh the D1 summary; checkpoint admission remains budgeted. | None. |

One further route is not under `/internal/admin`:
`POST /internal/snapshot/:slug/rebuild` in `apps/api/src/index.ts` rebuilds the D1 summary but does **not** advance `page.snapshot_version`. It is the exception
to the rule below, and it is safe because it does not change page content — the
embedded version already equals the stored one.

## The validation error shape

Every helper in `validate.ts` throws `ValidationError`, which carries a message
and an optional `field`. The route layer's `onError` turns it into a `400`:

```json
{ "ok": false, "error": "<message>", "field": "<name>" }
```

`field` is the one thing a client can act on, so it names the offending input:
`name`, `kind`, `severity`, `componentPublicIds`, `endAt`, `slug`, and so on.
`asObject` rejects a body that is not a JSON object with no `field` at all
(`null`), because there is no single field to blame. A required field that is
missing or empty produces `field` set to that field's name — the test "rejects a
missing required field with the field name" posts an empty section body and
asserts `field: "name"`.

Cross-record rules reuse the same channel. A component or section that belongs to
a different page is rejected with `field` set to `componentPublicIds` or
`sectionPublicId` respectively, and a write against an unknown page is a `400`,
not a `404`, because it is the request that is wrong.

Errors that are not `ValidationError` are logged and returned as
`500 { ok: false, error: "internal_error", detail: "<message>" }`. The `detail`
member carries the raw error message.

## Admin writes refresh the D1 summary

Public-output mutations advance `page.snapshot_version` and refresh the
materialized D1 summary synchronously server-side. Public reads normally report
`d1-live` or `cache-live`, not `kv-fresh`. A save does not purge every location's
hot cache: the previous summary can remain visible for up to 30 seconds, and no
global linearizability is promised.

KV checkpoints are independent of the save: two keys are due every 600 seconds,
subject to a shared deployment budget. Manual rebuild and repair are not an
unlimited write-budget bypass or a promise that KV has immediately changed.
The internal repair rebuild does not advance the content version; the admin
rebuild does. See [snapshot.md](snapshot.md) for source and freshness semantics.

`audit_log` is written on every mutation with `actor_admin_user_id` set to NULL,
because there is no authenticated actor to record.

## Fault-severity changes produce impacts

`impact` is the single source of truth for downtime (see
[data-model.md](data-model.md)), so an incident that appeared only in the
timeline would be invisible to the uptime maths. `createChange` therefore inserts
one `impact` row per affected component when, and only when, the change is an
incident and its severity is one of the three fault severities:

| `kind` | `severity` | Impacts created |
| --- | --- | --- |
| `incident` | `none` | None — informational only. |
| `incident` | `degraded_performance`, `partial_outage`, `full_outage` | One per affected component. |
| `maintenance` | any | None — the window is read from the change row itself. |

Each impact is opened at the change's `startsAt`, with `end_at` NULL,
`estimated = 0` (an operator stated it, so it is not a sample), `change_id` set,
and `probe_target_id` NULL. The tests "creates one impact per affected component
for a fault-severity incident", "creates no impact for a severity of `none`" and
"creates no impact for a maintenance window" pin all three rows of the table.

The change's own status is set from its kind: maintenance starts `scheduled`,
which contributes nothing to a component's derived status until it is moved to
`in_progress`; an incident starts `in_progress`, because announcing one is not a
thing that happens ahead of time.

### The per-component override rule

A single incident can hit some components harder than others. An operator
expresses that with `componentOverrides` on a timeline entry. `addChangeUpdate`
writes the override to `change_update_component` **and** applies it to `impact`
via `applyComponentOverrides`. Without the second step the per-component severity
would live only in the timeline table and never reach `impact`, so the uptime
maths would charge every affected component the incident's headline severity,
quietly overstating the damage to the components that were less affected.

For each override:

| Override status | Effect on `impact` |
| --- | --- |
| `operational` | Closes the component's open impact for this change. |
| `maintenance` | Ignored — no impact change. |
| a fault severity | Updates the existing open impact's severity, or inserts a new one opened at the change's `starts_at`. |
| anything else | Ignored. |

The test "applies a per-component override to the impact severity" opens an
incident at `partial_outage` on two components, then posts an update overriding
one to `full_outage` and the other to `operational`, and asserts the first
impact's severity changed and the second's `end_at` is no longer null.

The change's own status follows the newest timeline entry. A terminal status
(`resolved` or `completed`) sets `ends_at` and closes every open impact for the
change; without that the timeline would show "resolved" while the incident stayed
`in_progress` and kept contributing a fault.

## Manual impacts, and what distinguishes them in the data

There are three ways an `impact` row can come into being, and the data
distinguishes them by its foreign keys, not by a flag:

| Origin | `probe_target_id` | `change_id` | `estimated` |
| --- | --- | --- | --- |
| Probe transition | the target | NULL | 1 |
| Change at fault severity | NULL | the change | 0 |
| Hand-entered (`POST /pages/:slug/impacts`) | NULL | NULL | 0 |

A manual impact is therefore the row where **both** `probe_target_id` and
`change_id` are NULL. `closeManualImpact` looks up exactly that predicate, so a
probe-driven impact cannot be closed by hand — the test "refuses to close a
probe-driven impact by hand" inserts one with a `probe_target_id` and asserts the
close returns 400. The reason is stated in the test comment: closing it there
would let the operator and the prober disagree about whether a target is up, and
the next probe observation would reopen it.

This distinction is not cosmetic. `apps/api/src/lib/uptime-recompute.ts` decides
`source: "probe" | "manual"` from whether `probe_target_id` is null, and that
decides whether the interval is intersected with coverage (a sample) or counted
wherever it falls (direct evidence).

`createManualImpact` also rejects an `endAt` that is not after `startAt`, with
`field: "endAt"`.

## Probe targets, and the one-enabled-target constraint

`createProbeTarget` inserts the target and its `probe_state` row together. The
scheduler row is created eagerly rather than on first probe because a target
without one is a state the transition code reports as `unconfigured` — a bug
report rather than a state to design for. `next_check_at` is left at its default
of 0 so a newly configured probe is due on the next tick.

The v1 capacity boundary — at most one enabled target per component — is enforced
by the database, not by a check in the handler:

```
CREATE UNIQUE INDEX idx_probe_target_enabled_component
  ON probe_target(component_id) WHERE enabled = 1;
```

The test "refuses a second enabled target for the same component" creates one
enabled target and asserts the second create returns a 4xx. The service comment
states why the boundary lives in the schema: it "is enforced where it cannot be
bypassed". Disabled targets are not covered by the partial index, so a component
may have several disabled ones.

Deleting a target does not erase the downtime it measured.
`impact.probe_target_id` is `ON DELETE SET NULL`, so the interval survives with a
null target; the test "keeps an impact when the target that measured it is
deleted" asserts exactly that. Deleting a section likewise does not delete its
components — `component.section_id` is `ON DELETE SET NULL`, so they move to the
page root, which the test "moves components to the page root when their section
is deleted" asserts. The service comment calls the alternative "a data-loss bug
disguised as a cascade".

## Notifications are a side effect of change writes

Three routes notify after the write commits: creating an incident, appending an
update, and setting a change's status. They call `notifyChangeSafely`, which
never lets a notification failure reach the caller — the write has already
succeeded, and turning a mail-provider outage into a 500 would tell an operator
their incident update failed when it did not. A maintenance window announced
ahead of time does not notify on creation, because it is not news yet.

## What this does not cover

* **No authentication beyond the shared key.** There is no per-user login, no
  session, and no signature on the request body. The only credential is
  `INTERNAL_KEY`, and it authorises every admin operation equally. This is stated
  in the `service.ts` header: the v1 boundary is architectural, and per-user auth
  is a prerequisite for exposing this Worker publicly.
* **`admin_user` and `audit_log.actor_admin_user_id` are unused.** The table and
  column exist in the schema, but no code writes an admin user, and every audit
  entry records a null actor. The service header says inventing an identity model
  that nothing authenticates against would be worse than leaving the columns
  empty.
* **The browser never receives the key.** The web Worker holds `INTERNAL_KEY` as
  a server-side secret (`bindings.secret()` in `apps/web/cloudflare.config.ts`)
  and attaches it as `X-Internal-Key` when it calls the API over the `API`
  Service Binding (`apps/web/lib/allclear-api.ts`). Nothing serialises it to the
  client.
* **There is no origin or CSRF check.** A request that reaches the Worker with
  the key is accepted regardless of where it appears to come from. The key and
  the Service Binding are the whole control.
* **Unexpected errors expose their message.** The `500` branch returns the raw
  error string in `detail`.
* **Two validation helpers were once defined but unused.** `requireSlug` and
  `nullableString` in `validate.ts` are now used: `requireSlug` validates the
  `slug` on `POST /pages` and `nullableString` handles the explicitly-nullable
  fields such as `PATCH /components/:publicId`'s `sectionPublicId`. The earlier
  version of this document recorded them as dead code; the console's page-create
  and page-rename routes are what made them live.
* **The route table is not a versioned public API.** It is the surface the web
  Worker calls; nothing in the repository documents it as stable for third
  parties.

The console that drives these routes is documented separately in
[admin-ui.md](admin-ui.md). That document owns the questions this one
deliberately does not answer: what the operator sees, how the `ADMIN_TOKEN` gate
differs from `INTERNAL_KEY`, and which write operations were left out on purpose.

A static scan reaches these same conclusions from the other direction: it
reported seven "no role or permission check observed" candidates, three of them
on the `DELETE` routes in this file, because it could not expand the `/internal/*`
middleware. [security-scan.md](security-scan.md) records the scan and resolves
each candidate.
