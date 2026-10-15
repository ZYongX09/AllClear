# M0 — Deployment and technical-boundary validation

**Status: complete.** M0 answers one question — *is the chosen technical route
viable on real Cloudflare infrastructure?* — and nothing else. It is not a
statement that the product works: the status page, the prober, and the uptime
maths are all still unimplemented. See [What M0 did not prove](#what-m0-did-not-prove).

**Decision: build on `vinext`.** No fallback was needed. OpenNext was not
evaluated, because no capability in the list below failed. The alternative
architecture (Next.js static export on Pages + a separate Hono Worker, giving up
RSC) was likewise not needed.

Verified on 2026-10-15 against a real Cloudflare account
(`REDACTED`), Workers.dev subdomain enabled.

## Verified items

Each row is a capability the plan required, the evidence that it holds, and the
cost of getting it. "Cost" means workarounds that must be carried forward —
these are the part worth reading.

| # | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1 | vinext builds and deploys | Pass | `allclear-web` deployed, `https://allclear-web.<subdomain>.workers.dev`; `allclear-api` deployed with cron `* * * * *` registered |
| 2 | A Next.js page can read D1 and KV | Pass | `/status/example` renders both KV keys (with `snapshotVersion`, `generatedAt`) and a live D1 read (`page.snapshot_version`, `components = 4`) |
| 3 | Server Actions execute in the expected runtime | Pass | Clicking the page's buttons ran two actions in the Worker and returned their payloads to the browser (see below) |
| 4 | `next-intl` + Radix/shadcn + theme switching coexist | Pass | `/m0/ui`: locale switched `en → zh-CN`, Radix menu opened through its portal, theme switched `dark → light` |
| 5 | Refresh / SSR / caching behave as expected | Pass | Per-request SSR, no HTML caching, preferences survive reload (see below) |
| 6 | Simulated D1 read failure still serves the old snapshot | Pass | HTTP 200, `source: kv-last`, `stale: true`, all four components still rendered |
| 7 | web Worker → api Worker over a Service Binding | Pass | Read path plus a key-protected internal route both returned 200 |

### Item 3 — Server Action results, as returned to the browser

```json
{ "operation": "GET /internal/echo",
  "result": { "ok": true, "status": 200,
              "data": { "ok": true, "reachedVia": "service-binding", "at": 1792054205 } } }
```

```json
{ "operation": "POST /internal/snapshot/example/rebuild",
  "result": { "ok": true, "status": 200,
              "data": { "ok": true, "snapshotVersion": 1, "components": 4 } } }
```

### Item 5 — Caching and SSR

Response headers for the status page:

```
cache-control: private, no-cache, no-store, max-age=0, must-revalidate
vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch,
      Next-Router-Segment-Prefetch, Next-Url, X-Vinext-Interception-Context,
      X-Vinext-Interception-Id, X-Vinext-Mounted-Slots, X-Vinext-Rsc-Render-Mode,
      X-Vinext-Rsc-State-Fingerprint
```

No `cf-cache-status` header: the HTML is not cached at the edge. The page
re-reads its data per request — after the rebuild action, the KV `generatedAt`
visible on the page changed on the next load. Locale (cookie) and theme
(`localStorage`) both survived a reload.

### Item 6 — D1 failure, step by step

The public read path is `GET /api/status/:slug` on `allclear-api`, which reads KV
first and D1 only on a KV miss. The failure was injected there, because that
Worker owns the read chain.

1. Both KV keys populated; page reported `source: kv-fresh`.
2. `M0_SIMULATE_D1_FAILURE` set to `d1_read_failure` in `apps/api/wrangler.jsonc`
   and the API Worker redeployed. This replaces every D1 statement in the read
   path with one that throws.
3. `snapshot:example` (the fresh key) deleted from KV. Order matters: the cron
   repair pass treats a *missing* fresh key as "rebuild me", so the D1 outage has
   to be live before the key is removed or cron restores it within a minute.
4. Page fetched. Result:

```
HTTP          200
source        kv-last
stale         true
snapshotVersion 1
errors        d1-rebuild: M0: simulated D1 read failure
components    API / Website / Mobile web / Download server  (all present)
```

5. Fault reverted, API redeployed, fresh key restored.

A useful side effect: during step 3 the cron ran while D1 was healthy and
rewrote `snapshot:example:last` with a newer `generatedAt`, which is direct
evidence that the repair pass works.

### `stale` is computed at read time, not baked in

The same code path produced both values, which is the property the plan called
for:

| Snapshot age | `source` | `stale` |
| --- | --- | --- |
| 1452 s (older than `DEFAULT_MAX_AGE_SECONDS = 300`) | `kv-fresh` | `true` |
| ~0 s (immediately after a rebuild) | `kv-fresh` | `false` |

## Workarounds that must be carried forward

These are the real cost of the route, and the reason M0 ran against a live
account instead of reading documentation.

### 1. The beta `@cloudflare/vite-plugin` cannot read `wrangler.jsonc`

The plugin reads Worker configuration **only** from `cloudflare.config.ts`. With
no such file it falls back to `createDefaultWorkerConfig(name)`, which is just
`{ name, compatibilityDate }`, and **silently ignores `wrangler.jsonc`**. The
`main` entry point and asset configuration are therefore lost.

This is not a cosmetic problem: with the entry point lost, the RSC CSS pipeline
broke and `vite build` failed deterministically with a confusing
`[plugin vite:css] .../app/globals.css:undefined:NaN` /
`[postcss] ENOENT: no such file or directory, open '.../tailwindcss'` error.

**Consequence, and the resulting split:**

| Worker | Config | Deploy command | Why |
| --- | --- | --- | --- |
| `apps/web` | `cloudflare.config.ts` (typed config) | `vinext-cloudflare deploy` → `cf deploy --prebuilt` | Forced: the vite plugin requires it |
| `apps/api` | `wrangler.jsonc` | `wrangler deploy` | A plain Worker with no vite step; Wrangler credentials already exist |

The split is deliberate, not accidental. `cf` and Wrangler are two different
credential systems.

### 2. `cf` does not reuse Wrangler's credentials

`cf` resolves credentials **only** from `CLOUDFLARE_API_TOKEN` or its own OAuth
profile (`cf auth login`). It does not read Wrangler's OAuth session. On a
machine where Wrangler is already authenticated, `cf deploy` still fails with
`No authentication token found.`

Also note that the live Wrangler session lives in `~/.wrangler/config/default.toml`,
not `~/.config/.wrangler/config/default.toml`; the latter held a stale token
(expired 2026-06-02) and cost time before the live one was found.

### 3. The first deploy of a Worker with secret bindings needs `cf` directly

`vinext-cloudflare deploy` does **not** forward `--secrets-file`. A Worker whose
config declares a secret binding cannot be created by that command; the first
deploy must be:

```bash
cf deploy --prebuilt --secrets-file ~/.config/allclear/m0-secrets.env
```

Subsequent deploys work through `vinext-cloudflare deploy`, because the secret is
already stored on the Worker.

### 4. A Workers.dev subdomain is required for cron triggers

Registering a cron trigger on an account without a Workers.dev subdomain fails
with API code `10063` ("You need a workers.dev subdomain in order to proceed"),
even for a Worker with `workers_dev: false`. The subdomain was created with
`PUT /accounts/{id}/workers/subdomain`. The same condition affects public
reachability (code `10007`).

### 5. `next-intl` needs a Vite alias

`next-intl` normally wires its request config through `createNextIntlPlugin()`,
which aliases the bare specifier `next-intl/config` to the user's file using a
webpack/turbopack alias. vinext builds with Vite, so that alias never reaches the
bundler.

The fix is one entry in `apps/web/vite.config.ts`:

```ts
resolve: { alias: { "next-intl/config": fileURLToPath(new URL("./i18n/request.ts", import.meta.url)) } }
```

No patching of `next-intl` is required, and `next.config.ts` is not involved.

### 6. Smaller items

- **`wrangler types` narrows `vars` to literal types.** A `vars` entry whose value
  is `"none"` is typed as the literal `"none"`, so comparing it against any other
  string is a compile error (`TS2367`). The value must be widened through a
  `string`-typed local before comparison.
- **Tailwind 4 needs an explicit dark variant.** `dark:` defaults to
  `prefers-color-scheme`; class-based switching requires
  `@custom-variant dark (&:is(.dark *));`. Without it the theme toggle appears
  broken on any machine whose OS preference disagrees.
- **`next-themes` requires `suppressHydrationWarning` on `<html>`**, because it
  writes the theme class before hydration.
- **npm 12 blocked install scripts** for `esbuild`, `workerd`, `@parcel/watcher`
  and `@swc/core` in both apps. Builds, typechecks and deploys all succeed
  regardless; the `workerd` binary is present via
  `@cloudflare/workerd-linux-64`. Worth knowing before it is mistaken for the
  cause of a future failure.
- **Server-side secrets stay out of the RSC payload.** `INTERNAL_KEY` is read
  inside the action body via `env` from `cloudflare:workers`, so it is never
  serialised to the browser.

## Issues surfaced for later milestones

M0 was not asked to resolve these, but it made them concrete.

1. **`stale` will be permanently `true` for an unchanging page.** `stale` is
   computed from the *snapshot document's* age, while the cron rebuilds only when
   the embedded `snapshotVersion` differs from D1. A page whose content does not
   change for five minutes therefore reports `stale: true` even though nothing is
   wrong. Either `stale` must mean "data may be out of date" (tie it to
   `sourceUpdatedAt` and version agreement) or the repair pass must refresh
   `generatedAt`. This needs a decision in M2 — it is a semantics question, not a
   bug.

2. **The `:last` key is self-healing, which cuts both ways.** `repairSnapshots`
   rebuilds when the fresh key is missing, so deleting it is not a durable state.
   That is good for availability, but it means "fresh key absent" cannot be used
   as a signal anywhere.

3. **The M0 page reads D1 with its own binding, which production should not.**
   The page reads KV and D1 directly only to prove capability item 2
   independently. The real status page should depend on the snapshot alone; the
   direct reads are an M0 artifact and should not survive into M4.

4. **D1 read-subrequest limits were not measured.** The Free-tier limit is 50 read
   subrequests per invocation (Paid: 1000). The plan requires a documented
   capacity boundary for probe targets; that boundary is still an estimate and
   must be established by measurement in M3.

5. **The cron repair pass has no test coverage.** It was exercised incidentally
   (see item 6) but never deliberately.

## What M0 did not prove

Stated plainly, because a deployment that renders a page is easy to over-read.

- **The D1 failure was simulated in-process, not a real outage.** The read path
  was made to throw. This proves the *fallback logic* is reachable and correct;
  it does not prove behaviour under a real D1 incident, partial failures, or
  timeouts.
- **No probe, no state machine, no uptime maths.** Nothing about the detection
  lag, transition atomicity, coverage rules, or the interval-sweep uptime
  algorithm has been implemented or tested. Those are M1 and M3, and both still
  need their own gates.
- **The prober does not exist**, so the monitoring-capacity boundary is unmeasured.
- **No independent monitoring source.** The status page and the prober both run
  on Cloudflare. M0 does not change that, and it remains a known single point of
  failure.
- **No load, latency, or cost measurements.** Detection latency, timeout
  behaviour, and concurrency were not measured.
- **No security review of the new surface.** The `/m0/ui` page and the M0
  scaffolding are throwaway, but they have not been audited.
- **No real-browser verification of the production status page's visual design.**
  Item 4 verified that the i18n/Radix/theme stack works; it says nothing about
  fidelity to any reference design, which is M4 work.

## M0 scaffolding to remove in M1

- `apps/api/src/index.ts`: `maybeBrokenDb` and its caller.
- `apps/api/wrangler.jsonc`: the `M0_SIMULATE_D1_FAILURE` var.
- `apps/web/app/status/[slug]/` and `apps/web/app/m0/ui/`: capability reports, not
  the product. The `/status/[slug]` route name is reused by the real page in M4.
- `~/.config/allclear/m0-secrets.env`: local only, outside the repository.

## Reproducing

```bash
# API Worker
cd apps/api
CLOUDFLARE_ACCOUNT_ID=<account> npx wrangler deploy

# Web Worker (first deploy of a Worker with secret bindings)
cd apps/web
npm run build
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account> \
  npx cf deploy --prebuilt --secrets-file ~/.config/allclear/m0-secrets.env

# Subsequent web deploys
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account> \
  npx vinext-cloudflare deploy
```

Secrets are read from the environment or a secrets file and are never committed.
See `AGENTS.md`.
