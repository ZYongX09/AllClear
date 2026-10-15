# allclear

A status page and basic availability monitor built for Cloudflare's serverless
platform.

`allclear` gives you a public status page (component tree, incident timeline,
uptime chart, subscriptions, i18n, dark mode) backed by **real measurement**:
scheduled probes record what actually happened, and uptime percentages are
computed from those recorded impacts rather than asserted by hand.

## Status

Early development. **M0 (deployment and technical-boundary validation) is the
current milestone** — see [`docs/spec/m0-findings.md`](docs/spec/m0-findings.md)
for what has actually been verified on real Cloudflare infrastructure, and what
has not.

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | Hono Worker — public read API, admin API, probe scheduler |
| `apps/web` | Next.js status page, built with [vinext](https://github.com/cloudflare/vinext) |
| `packages/shared` | Pure functions: status derivation, uptime math, probe coverage |
| `docs/spec` | Specifications and verification records |

## Design commitments

These are load-bearing, not aspirations:

- **Uptime is computed, never asserted.** `uptime = 1 − weighted_downtime / covered_duration`,
  where the numerator is a swept sum over non-overlapping segments taking the
  *most severe* active impact per segment. Overlapping incidents cannot
  double-count.
- **Absence of evidence is not evidence of uptime.** A component with no probe
  coverage, or stale probe data, reports `unknown` — not `operational`.
  Uncovered time is excluded from the denominator and reported separately as
  `unknown_duration`.
- **No silent 100%.** If the effective window is entirely excluded (e.g. fully
  covered by maintenance), uptime is `null` / N/A, not `100%`.
- **Probe timestamps are estimates.** `first_failed_at` / `detected_at` /
  `first_recovery_success_at` / `resolved_at` are stored separately, and the
  nominal detection lag is `(failure_threshold − 1) × interval` — not one
  interval.
- **The public read path does not require D1.** It serves a snapshot from KV,
  falling back to the last good snapshot, and reports its own freshness.
- **Probes are an admin-reviewed allowlist.** No user-submitted targets, and
  redirects are denied by default.

## Known single point of failure

The status page and the prober both run on Cloudflare. If Cloudflare itself is
down, this system cannot report on it. Detecting a full-platform outage requires
a probe source outside Cloudflare; that is deliberately out of scope for now.

## Attribution

Functionality was informed by studying mature commercial status-page products.
**All code and assets here are original.** No third-party stylesheets, markup,
copy, message catalogs, logos, or images were copied. Reusable dependencies are
MIT / ISC / OFL licensed (shadcn/ui, Radix UI, lucide, Inter, Tailwind CSS).

Note that [OpenStatus](https://github.com/openstatusHQ/openstatus) is
AGPL-3.0 — it is not a source for this project's code.

## License

MIT — see [LICENSE](LICENSE).
