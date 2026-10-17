# allclear-web

The Next.js (vinext) Worker: the public status page, the `/admin` console, and the
Server Actions that write to the API Worker over a Service Binding.

See the [repository README](../../README.md) for the project overview, the
[deployment guide](../../docs/deployment.en.md) for production setup and secrets,
and [engineering notes](../../docs/engineering.md) for the architecture.

## Scripts

- `npm run dev` — vinext dev server.
- `npm run build` — build the Cloudflare Worker output.
- `npm run start` — preview the built Worker locally.
- `npm run deploy` — deploy the Cloudflare Worker (manual; see AGENTS.md).
- `npm run typecheck` — generate Worker types, then `tsc --noEmit`.

## Running the UI without Cloudflare resources

The fixture Workers under `verify/` let the pages render with no D1, no KV and no
migrations applied:

```sh
npx vite dev --config verify/vite.config.verify.ts --port 5219
```

This is a dev-only harness, not a second implementation of the API: it deliberately
reproduces only the response shapes the UI depends on. `verify/admin-stub.ts`
checks `X-Internal-Key` for *presence* only, which is enough to exercise the console's
own session gate and is not a model of the API's authorisation.

**Stop this server before running `npm run build`** — both write to the same
`.vinext`/`.cloudflare` output directory and will corrupt each other.

Fixture status slugs under `/status/` exercise the read metadata independently:
`fixture` (D1 live), `fixture-cached`, `fixture-fallback` (unconfirmed with expired
probe evidence), `fixture-legacy` (missing history time), `fixture-history-unknown`
(null history time), and `fixture-unavailable`. Assembly, history computation,
and probe timestamps intentionally differ. These are development fixtures, not
production health or browser-regression evidence.
