# Cloudflare deployment guide

[Back to README](../README.en.md) · [简体中文](deployment.md) · **English**

This guide covers deploying AllClear from source to your own Cloudflare account: initial setup, resource bindings, domains, email, and upgrades. Deployment is currently manual through the CLI; GitHub Actions is not required. Example names can be changed, and no resource belonging to the project author is required.

> AllClear is early-stage software. Review [known issues](#known-issues) and perform end-to-end acceptance in your environment before serving users. These instructions describe deployment, not a claim that the complete system has passed production acceptance.

## 1. Prepare your environment and source

You need:

- A Cloudflare account. Under **Workers & Pages**, configure your account's `workers.dev` subdomain before registering scheduled triggers, even though the API is not public.
- Git, Node.js 22.12+ and a compatible npm version. The latest maintained Node.js 24 LTS is recommended. The project's vinext / cf toolchain does not support Node.js 20.
- An active Cloudflare DNS zone in the same account for a custom domain. A domain is not required for initial deployment.

```sh
git clone --branch develop https://github.com/ZYongX09/AllClear.git
cd AllClear

npm --prefix packages/shared ci
npm --prefix apps/api ci
npm --prefix apps/web ci
npm --prefix packages/shared run build
```

Packages install independently; use their committed lockfiles. There is no root npm workspaces installation step. Both applications depend on the shared package's build output, so do not skip the final command.

**Run all subsequent commands from the repository root.** Parentheses run commands in a subdirectory without changing your terminal's working directory.

### Authenticate with Cloudflare

The API uses Wrangler; the web application uses `cf`. Their interactive login credentials are separate:

```sh
(cd apps/api && npx wrangler login)
(cd apps/web && npx cf auth login)
```

If you have multiple accounts, select the target explicitly and keep this variable set for subsequent commands:

```sh
export CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id"
```

For headless or automated environments, securely supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through environment configuration for both tools. The token needs the target account's deployment permissions for Workers, D1, KV, and any other resources you configure. Custom domains also involve the target zone. Scope the token to the accounts and resources you use; do not put it in source, documentation, command arguments, or shell history. See [Cloudflare API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

## 2. Create storage resources

```sh
(cd apps/api && npx wrangler d1 create allclear-db)
(cd apps/api && npx wrangler kv namespace create SNAPSHOT_KV)
```

Edit [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc), replacing the following placeholders with the command output:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "allclear-db",
    "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
  }
],
"kv_namespaces": [
  {
    "binding": "SNAPSHOT_KV",
    "id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
  }
]
```

Use IDs from your own account. `DB` and `SNAPSHOT_KV` are binding names used by the code and should remain unchanged. Database and Worker resource names can be changed.

### Multiple instances in one account

Use separate databases, KV namespaces, Worker names, and secrets for each instance to avoid sharing production data. Update these settings together:

| Setting | Default | Location |
| --- | --- | --- |
| API Worker name | `allclear-api` | `name` in `apps/api/wrangler.jsonc` |
| Web Worker name | `allclear-web` | `worker.name` in `apps/web/cloudflare.config.ts` |
| API referenced by the web Worker | `allclear-api` | `API: bindings.worker({ worker: ... })` in the same file |
| D1 database name | `allclear-db` | `database_name` in `apps/api/wrangler.jsonc` |

This guide uses the binding name `DB` in migration commands, so it does not depend on the database name. The existing `db:migrate:*` shortcuts in `apps/api/package.json` use the default name; update them if you rename the database, or continue using the binding-based commands here.

## 3. Initialize the database and API secret

```sh
(cd apps/api && npx wrangler d1 migrations apply DB --remote)
(cd apps/api && npx wrangler secret put INTERNAL_KEY)
```

`secret put` prompts for the value interactively. If it reports that the Worker does not exist, confirm creation of the intended Worker name before continuing with deployment.

Generate `INTERNAL_KEY` with a password manager or cryptographically secure generator and keep it available: the web Worker must receive **the same value**. Generate a separate `ADMIN_TOKEN` for console access; do not reuse the service key.

Migrations create a placeholder page, `example` / “Example Service”, and sample components. They create **no real probe targets or admin credentials**. An initial unknown status is not a successful health check. Use Wrangler's migration command rather than manually replaying SQL files; not all schema migrations are idempotent.

## 4. Deploy the API Worker

```sh
(cd apps/api && npm run deploy)
```

The default configuration retains `workers_dev: false` and declares no public route. The web Worker calls the API through a Service Binding. Do not add an API domain or expose management endpoints publicly just to troubleshoot deployment.

The configuration also registers a once-per-minute Cron Trigger. Cloudflare cron schedules use UTC; new or changed triggers can take up to 15 minutes to propagate. Check the Worker's trigger configuration, Cron Events, or logs rather than assuming a successful deployment means probes have run. See [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## 5. Deploy the web Worker for the first time

The web configuration is [`apps/web/cloudflare.config.ts`](../apps/web/cloudflare.config.ts), not the API's `wrangler.jsonc`. Confirm that `API` references the API Worker you just deployed.

Using a text editor, create a private file outside the repository, for example `$HOME/.config/allclear/web-secrets.env` (create its parent directories first):

```dotenv
INTERNAL_KEY=REPLACE_WITH_THE_SAME_API_INTERNAL_KEY
ADMIN_TOKEN=REPLACE_WITH_A_SEPARATE_RANDOM_ADMIN_PASSPHRASE
```

These are placeholders and must be replaced. Restrict access to the file, and do not commit or share it:

```sh
chmod 600 "$HOME/.config/allclear/web-secrets.env"
```

The first deployment must supply the secrets. The project's current `vinext-cloudflare deploy` command does not forward `--secrets-file`, so build first and invoke `cf` directly:

```sh
(cd apps/web && npm run build)
(cd apps/web && npx cf deploy --prebuilt \
  --secrets-file "$HOME/.config/allclear/web-secrets.env")
```

Deployment output provides the web address, typically `https://allclear-web.<your-subdomain>.workers.dev`. Subsequent ordinary deployments can use `npm --prefix apps/web run deploy`; existing remote secrets are retained. To rotate secrets, update the private file and repeat the build and deployment commands above.

A local `.dev.vars` file does not replace remote secret configuration, and Wrangler authentication does not replace `cf` authentication.

## 6. Configure a page and verify it

1. Open `/admin` on the web address and sign in with `ADMIN_TOKEN`.
2. Edit the sample page or create one, then add sections, components, and probe targets. Targets must be permitted, publicly reachable HTTP(S) services.
3. After scheduled triggers take effect, inspect probe records in the console. If necessary, use **Page → Rebuild snapshot** on the page detail screen to rebuild the public snapshot.
4. Check the rendered page and machine-readable responses:

| Path | Purpose |
| --- | --- |
| `/` | Landing page and default status-page link |
| `/admin` | Admin console |
| `/status/example` | Sample page; replace with your page's slug |
| `/status/example/snapshot.json` | Public JSON snapshot, source, and stale indicators |
| `/status/example/feed.xml` | Atom feed |

`/api/hello` only proves that the web Worker responds. It does not verify D1, KV, the Service Binding, or probes. JSON uses the `ReadResult` envelope, not a single status value; integrations should follow the [snapshot contract](spec/snapshot.md).

For a different page slug, change `DEFAULT_STATUS_SLUG: bindings.text("your-page-slug")` in the web configuration, then rebuild and redeploy the web Worker. This changes the landing-page link; it does not create or rename a database page.

Set the API's `PUBLIC_BASE_URL` to the canonical web origin, such as `https://status.example.com` or the actual `workers.dev` address, and redeploy the API. Do not use the API address, a `/status/example` path, or a URL with query parameters.

> **Important:** Unknown does not necessarily mean a failed probe. An unconfigured target, no observations, expired evidence, or the snapshot-refresh issue below can all result in unknown status. Reloading the browser does not force a server-side snapshot rebuild.

## Configuration reference

### API Worker: `apps/api/wrangler.jsonc` and secrets

| Name | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | Pages, components, incidents, subscriptions, and observations; required |
| `SNAPSHOT_KV` | KV binding | Published public snapshots; required |
| `INTERNAL_KEY` | Secret | Protects internal endpoints; required, matching the web Worker |
| `PUBLIC_BASE_URL` | Variable | Absolute web origin; required for confirmation and incident email |
| `MAX_TARGETS_PER_RUN` | Variable | Targets processed per trigger, default `"20"`, maximum 20 |
| `EMAIL` | `send_email` binding | Optional real email delivery; absent by default |
| `EMAIL_FROM` | Variable | Envelope sender; replace `status@localhost` when enabling email |
| `UNSUBSCRIBE_HMAC_KEY` | Secret | Signs unsubscribe links; required for incident notifications |

### Web Worker: `apps/web/cloudflare.config.ts` and secrets

| Name | Type | Purpose |
| --- | --- | --- |
| `API` | Service Binding | References your API Worker; required |
| `INTERNAL_KEY` | Secret | Same service key as the API; required |
| `ADMIN_TOKEN` | Secret | Separate admin passphrase, also used to verify sessions; required |
| `DEFAULT_STATUS_SLUG` | Text binding | Landing-page destination, default `example` |
| `ASSETS` / `IMAGES` | Integration bindings | Managed by the build integration; no manual D1/KV-style provisioning |

Keep ordinary variables in their versioned configuration and redeploy after changes. Dashboard-only edits may be overwritten by a later source deployment. Manage credentials as secrets, not `vars`.

## Custom domains

Use `workers.dev` for initial verification if desired. With an active DNS zone in the same account, add these fields inside the web configuration's `defineWorker({ ... })`, retaining the other settings:

```ts
name: "allclear-web",
domains: ["status.example.com"],
```

Use your own hostname, ensure there is no conflicting CNAME, then rebuild and deploy the web Worker. This is `cf` typed configuration: **do not paste Wrangler's `routes` JSON into this file**. Set `workersDev: true` explicitly if you also want to retain the `workers.dev` address.

Update the API's `PUBLIC_BASE_URL` to the new canonical origin and redeploy the API. See [Cloudflare Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Optional: enable email subscriptions

Subscription logic is implemented, but the default configuration **does not deliver email**. Without an `EMAIL` binding, the API uses a recording sender; a successful subscription response does not mean a confirmation message arrived. Requests are rejected if `PUBLIC_BASE_URL` is empty.

To enable delivery:

1. Follow [Cloudflare's email-sending guide](https://developers.cloudflare.com/email-service/get-started/send-emails/) to enable sending and configure the domain and DNS records.
2. Check your plan and recipient policy. Free sending to verified destinations is not the same as sending to arbitrary subscribers; do not assume free Email Routing covers a public mailing list. See [Email Service](https://developers.cloudflare.com/email-service/).
3. Add this top-level binding to the API's `wrangler.jsonc`, and set `EMAIL_FROM` to an address on your onboarded sending domain:

   ```jsonc
   "send_email": [{ "name": "EMAIL" }]
   ```

4. Set a real `PUBLIC_BASE_URL`, then create a separate unsubscribe signing key interactively:

   ```sh
   (cd apps/api && npx wrangler secret put UNSUBSCRIBE_HMAC_KEY)
   (cd apps/api && npm run deploy)
   ```

5. Test with a real address you control: submit a subscription, receive and follow the confirmation link, publish a manual incident, receive a notification, and unsubscribe. Do not verify delivery with HTTP status codes alone.

The implementation uses `EmailMessage` from `cloudflare:email`. The official [Workers API documentation](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) confirms backward compatibility, but delivery in your account still requires the checks above. Other providers require an implementation of the project's sender adapter; supplying an API key alone does not integrate them.

The application defaults to 2,000 send attempts per UTC day, shared with confirmation messages, and processes at most 500 matching recipients per incident notification. There is no queued-delivery guarantee. These are application budgets, not the provider's free allowances. Automatic probe failures do not themselves trigger incident email.

## Upgrade an existing deployment

1. Record the deployed revision and privately back up configuration and secrets. Before schema changes, export remote D1:

   ```sh
   (cd apps/api && npx wrangler d1 export DB --remote \
     --output /absolute/private/path/allclear-before-upgrade.sql)
   ```

   Backups can contain subscriber addresses and other sensitive data; keep them outside the repository.

2. Fetch your target revision and review changes and migration instructions. Preserve your instance's bindings, domains, and variables instead of overwriting them with template values. Current development is on `develop`; the existence of `main` does not imply a stable release.
3. Repeat the three `npm ci` commands and shared build from step 1, then run:

   ```sh
   npm run typecheck
   npm test
   npm run build
   (cd apps/api && npx wrangler d1 migrations apply DB --remote)
   (cd apps/api && npm run deploy)
   (cd apps/web && npm run deploy)
   ```

4. Recheck the public page, JSON, console, probes, and email flow. Worker code rollback does not automatically reverse database changes; check compatibility before rolling back.

Pushing source does not automatically deploy this repository's Workers. If you add CI, retain the same configuration, migration order, and secret-management requirements.

## Known issues

### Continuously successful probes may not refresh public snapshots

Static tracing found that after observations are written, the scheduled task publishes snapshots only for pages whose probe impacts opened or closed. Continued healthy observations and uptime updates may therefore be absent from existing snapshots. The repair pass can also skip a snapshot whose version has not changed. Initial or subsequent successful checks may not appear publicly, and old evidence may expire into unknown status.

This is a source-inspection finding, not a reproduced runtime scenario. As a temporary diagnostic, use **Page → Rebuild snapshot** at `/admin/pages/<slug>`. This reflects current data but does not repair ongoing publication. Repeated manual rebuilds are not a production-monitoring solution and should not underpin freshness or alert-timing promises.

Relevant code: [probe results](../apps/api/src/probe/run.ts), [scheduling and publication](../apps/api/src/index.ts), and [snapshot reads](../apps/api/src/snapshot.ts).

### Capacity and operational boundaries

- The deployment budget is 20 enabled targets across all pages, with at most 20 due targets processed per run. The 21st target is not necessarily rejected at creation; exceeding the budget can introduce backlog and delay. Each component permits one enabled target, with an interval of at least 60 seconds.
- Probes support public HTTP(S) GET / HEAD on ports 80 / 443 and do not follow redirects. The console exposes basic settings; advanced expected-status, timeout, and threshold settings are available through the internal admin API. Do not grant target-editing access to untrusted users.
- Operators must advance maintenance states; planned timestamps do not automatically start or end maintenance.
- The console uses a shared admin passphrase. Public pages support Chinese and English; the console and email currently use English.
- Backend and shared logic have automated tests; the frontend has no automated regression coverage yet. See the [engineering verification boundary](engineering.md#verification-honesty).

## Troubleshooting

**Deployment reports missing resources or placeholder-related errors.** Check that D1 / KV IDs have been replaced, that the resources belong to your selected account, and that `CLOUDFLARE_ACCOUNT_ID` is correct. Do not retry an unchanged template configuration.

**Wrangler is authenticated, but the web deployment is not.** Run `npx cf auth login` in `apps/web`, or supply both tools with the same secure environment variables. The first web deployment also requires its secrets file.

**Console login or writes are refused.** Confirm the web Worker has an actual `ADMIN_TOKEN`, both Workers have identical `INTERNAL_KEY` values, and the Service Binding references the correct API. Changing the admin passphrase invalidates existing sessions.

**Probes do not run, or status remains unknown.** Check trigger propagation, Worker logs, the target URL, and last-check data, then inspect the known snapshot-refresh issue. `localhost`, private addresses, credential-bearing URLs, and redirecting endpoints are unsuitable targets. Do not disable address validation to work around a configuration error.

**Subscription succeeds, but no confirmation arrives.** Check whether the default recording sender is still active, then inspect the sending binding, domain, sender address, recipient policy, public origin, quota, and logs. Request success is not delivery success.

**Local build output is inconsistent.** Stop the fixture preview and other frontend development servers before building. They write to the same `.vinext` / `.cloudflare` output directories.
