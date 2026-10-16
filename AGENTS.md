# AGENTS.md — working rules for this repository

## Branch workflow (strict)

- `develop` is the **development** branch. All feature work lands here.
- `main` is the **release** branch. It is what gets deployed.
- `feat/*` branches are allowed for parallel work, but must be merged back into
  `develop`.
- `hotfix/*` branches may be cut from `main` for emergencies, but must be merged
  back into **both** `main` and `develop`.
- **Never** merge `develop` → `main` on your own initiative. That is a release
  action and happens only when explicitly instructed.

## Deployment

Deployment is **not** automatic for this repository yet. There is no CI pipeline
that publishes on push. Deploying is a deliberate, manual step:

```
cd apps/api && npm run deploy
cd apps/web && npm run deploy
```

A successful `git push` is **not** evidence of a successful deployment. Verify
by hitting the deployed Worker.

## Verification honesty

`docs/spec/m0-findings.md` records what has actually been observed on real
Cloudflare infrastructure, separated from what is merely designed. Keep that
distinction. When you add a claim, state how it was verified, or mark it
unverified.

Do not describe something as working because the code looks right. Static
reading is not a test run.

## Secrets

Credentials come from environment variables or a secret store only. Never write
a usable credential literal into source, examples, tests, or documentation.

Local development secrets belong in `.dev.vars`, which is gitignored.

## Server-side request rules

Any code that fetches a URL supplied as data must:

- allow only `http` and `https` schemes;
- validate the host and reject loopback, private, link-local, and reserved
  addresses;
- deny redirects by default (and re-validate every hop if redirects are ever
  enabled).

## Database rules

All external input must be passed as bound parameters. Never build SQL by
concatenation, formatting, or string interpolation.

## Licensing hygiene

**This project's own license is GPL-3.0-only** — see `LICENSE`. Two consequences
for new work:

- Dependencies must stay GPL-3.0-compatible. The current set (MIT / ISC / OFL /
  Apache-2.0) all are. Adding a dependency under a GPL-incompatible or
  proprietary license would make the project undistributable — check before
  adding it, not after.
- The `license` field in every `package.json` says `GPL-3.0-only`. Keep those in
  step with `LICENSE`; a package that disagrees with the repository is a defect,
  not a detail.

This project is original work. Do not paste in third-party stylesheets, markup,
copy, message catalogs, logos, or images. Do not copy from AGPL projects.
