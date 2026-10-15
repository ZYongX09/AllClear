# Static security scan record

**Status: scan completed, result inconclusive, no confirmed vulnerability.** This
document records what a Mimosa deep scan reported on the M2–M5 tree, what each
candidate turned out to be when read against the code, and — the part that
matters most — what the scan does not establish.

The scan was requested because the commit gate that let the M2–M5 commit through
said, in its own words, that it had no complete conclusion and that the project
must not be described as secure until a full audit was re-run. This is that
re-run. It is recorded here rather than only in a terminal because "we ran a
scan and it was fine" is exactly the claim that gets made from memory and then
turns out to be false.

## The scan

| Field | Value |
| --- | --- |
| Scan id | `scan-2026-10-15T17-35-38.684Z-55598090529a` |
| Depth | deep |
| Run status | **inconclusive** |
| Seal | `sha256:46869160e816822b2b06b2c92f8a17a1c54b8605e067ca0bc41d87404ade6ca4` |
| Findings | 7 — all `business-logic`, all `candidate` |
| `verdictEffect` | `none` |
| `evidenceBoundary` | `static_only_no_runtime_execution` |
| Files | 75 selected, 75 parsed, 0 read or parse failures, not truncated |
| Dependencies | 457 packages scanned, 0 matched advisories |

Coverage was **partial**. The one recorded gap is that the call graph is
incomplete — some calls are dispatched dynamically or exceed the analysis budget,
so cross-file reachability may be incomplete. That gap is the direct cause of
every finding below, which is why it is quoted before them rather than after.

The threat model phase reports the number that explains the whole result:
`entryPoints: 25, principals: 0, authorizationSurfaces: 20`. **Zero principals.**
The scanner found no identity model because the code has none, which is a
documented decision (see [admin-api.md](admin-api.md), "What this does not
cover"), not an oversight it uncovered.

## The seven candidates, resolved

All seven share one title — "敏感操作未观察到角色或权限检查" — and one shape: a
route whose handler contains no role or permission check. Each is accurate as a
statement about the handler and misleading as a statement about the system,
because the check lives in middleware the scanner did not expand. Its own proof
gaps say so: "尚未展开全局 guard" and, for one of them, "查询预算耗尽：未能获取入口
guard".

| # | Route | File:line | What actually guards it |
| --- | --- | --- | --- |
| 1 | `DELETE /sections/:publicId` | `apps/api/src/admin/routes.ts:167` | `/internal/*` middleware: `X-Internal-Key` vs `INTERNAL_KEY`, constant-time; plus `workers_dev: false` |
| 2 | `DELETE /components/:publicId` | `apps/api/src/admin/routes.ts:208` | same |
| 3 | `DELETE /probes/:publicId` | `apps/api/src/admin/routes.ts:378` | same |
| 4 | `POST /api/status/:slug/subscribe` | `apps/api/src/subscribe/routes.ts:92` | Intentionally public. Rate-limited per email and per IP, double opt-in, email shape and length checks |
| 5 | `GET /api/subscribe/confirm` | `apps/api/src/subscribe/routes.ts:283` | The token *is* the authorisation: single-use, TTL-bounded, looked up as a bound parameter |
| 6 | `GET /u/:token` | `apps/api/src/subscribe/routes.ts:337` | HMAC signature + expiry + subscriber existence + version; renders only |
| 7 | `POST /u/:token` | `apps/api/src/subscribe/routes.ts:359` | The same four checks, then acts. RFC 8058 one-click |

Findings 1–3. `createAdminRoutes()` is mounted at `/internal/admin` in
`apps/api/src/index.ts`, behind `app.use("/internal/*", …)`. That middleware
returns `503 internal_key_not_configured` when the key is unset, `401` when the
header does not match, and compares with `constantTimeEqual`. The handler is
thin by design — the file header says "a route that contains business logic is a
route that cannot be tested without an HTTP request" — so it is *supposed* to
contain no check of its own. The scanner read the handler, could not reach the
`app.use` registration, and reported what it saw.

Finding 4. Subscribing has to be reachable by anyone; a permission check would
defeat the feature. The guards that matter are of a different kind and are
present: `consumeRateLimit` on `subscribe:email:<hash>` and `subscribe:ip:<hash>`
before any work is done, `isValidEmail`, a per-page subscriber cap, a global
daily send counter, and double opt-in — nothing is delivered until the address
confirms.

Finding 5 is the one the scanner marked `supported_static` rather than
`inconclusive`. The static pattern does support the hypothesis: `confirm` has no
role check. It does not need one. `confirm_token` is a random single-use value,
compared by bound parameter, refused after `CONFIRM_TOKEN_TTL_SECONDS`, and set
to NULL on use so a replayed link fails. The capability is the token.

Findings 6 and 7. Both go through `loadUnsubscribeTarget`, which checks four
independent things and returns a distinct status for each: signature
(`verifyUnsubscribeToken`, HMAC with `UNSUBSCRIBE_HMAC_KEY`), expiry, subscriber
existence, and `row.version === payload.version` — the version check being the
revocation mechanism. `GET` only renders a confirmation form; the state change
happens on `POST`, which is what stops a mail scanner's link prefetch from
unsubscribing people.

So: **no finding in this scan is a real missing authorisation check.** The one
genuine limitation the scan gestures at — no roles, no per-actor identity, one
key that authorises everything equally — is already written down in
[admin-api.md](admin-api.md) and in the `service.ts` header, together with the
statement that per-user auth is a prerequisite for exposing this Worker publicly.

## What this scan does not establish

* **It is not runtime verification.** `evidenceBoundary` is
  `static_only_no_runtime_execution`. No request was sent, no payload was
  crafted, nothing was exploited or attempted. "No confirmed vulnerability" means
  the static pass confirmed nothing; it does not mean the code was tested against
  an attacker.
* **`verdictEffect: none`.** The scan changed no verdict. Every finding is a
  `candidate` that the validation phase could not resolve either way, and the run
  status is `inconclusive`.
* **The call graph was incomplete.** The scanner's own gap note says cross-file
  reachability may be missing. A check it cannot follow is indistinguishable, to
  the scanner, from a check that is absent — which is precisely what happened
  here, seven times.
* **Partial coverage.** 75 files were parsed out of a 6367-file limit; nothing
  was truncated or failed to parse, but the coverage record says `partial`, not
  `complete`.
* **No dependency advisory matched, and that is not the same as safe.** 457
  packages were scanned against the advisory set; the set is only as current as
  the scan date.
* **This is one tool on one commit.** It says nothing about the deployment, the
  Cloudflare account configuration, the secrets in it, or any future commit.

The correct summary is: **a deep static scan ran on the M2–M5 tree and found no
confirmed vulnerability; seven candidates were examined by hand and all seven are
explained by the documented architecture.** The project is not thereby
established as secure, and this document should not be cited as if it were.
