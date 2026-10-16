import { bindings, defineConfig, defineWorker } from "cf/config";

/**
 * The web Worker is configured through `cloudflare.config.ts` rather than
 * `wrangler.jsonc` because `@cloudflare/vite-plugin` (currently `2.0.0-beta`)
 * reads Worker configuration only from this file. When the file is absent the
 * plugin falls back to a bare `{ name, compatibilityDate }` default and
 * silently ignores `wrangler.jsonc`, so bindings, `main` and asset routing are
 * lost. See docs/spec/m0-findings.md.
 */
export default defineConfig({
  worker: defineWorker({
    name: "allclear-web",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-15",
    compatibilityFlags: ["nodejs_compat"],

    // No `run_worker_first` here: vinext emits the routing rules into the
    // Cloudflare Build Output itself. `notFoundHandling: "none"` keeps unknown
    // paths reaching the Worker instead of a generated 404 page.
    assets: { notFoundHandling: "none" },

    env: {
      // Provided by the vinext/Cloudflare integration.
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),

      // `allclear-api` has no public route. This Service Binding is the only
      // way to reach it, and it is not by itself an authorisation: the Worker
      // also requires INTERNAL_KEY on every /internal/* route.
      //
      // Note what is *not* here: this Worker has no KV or D1 binding. The read
      // chain — KV first, rebuild from D1 on a miss, fall back to the
      // last-known-good key if D1 is unreachable — lives in `allclear-api`, and
      // reaches this Worker as one `ReadResult` over the binding. Binding the
      // same storage here would offer a second, differently-cached path to the
      // same document, which is how two readers end up disagreeing.
      API: bindings.worker({ worker: "allclear-api" }),

      // Server-side only. Never exposed to the browser: the web Worker holds
      // it and attaches it when calling the API Worker.
      INTERNAL_KEY: bindings.secret(),

      // Gates the /admin UI, and is deliberately a *different* secret from
      // INTERNAL_KEY. The two answer different questions: INTERNAL_KEY says "this
      // request comes from the web Worker", which is a property of the
      // deployment; ADMIN_TOKEN says "a human who knows it is operating this
      // console", which is a property of the request. Sharing one value would
      // mean every operator knows the credential the Worker uses to reach the
      // API, and rotating it to revoke a person would break the site.
      //
      // Unset means the admin console refuses everything rather than opening. The
      // console exists because a Server Action is a public POST endpoint: it runs
      // on this Worker and attaches INTERNAL_KEY itself, so without a gate here
      // anyone who can reach the page can write to the API.
      ADMIN_TOKEN: bindings.secret(),

      // Which status page this deployment's landing page links to. The baseline
      // migration seeds `example`, so a fresh checkout works without further
      // configuration; an empty value renders the "not configured" hint instead
      // of a link to a page that does not exist.
      DEFAULT_STATUS_SLUG: bindings.text("example"),
    },
  }),
});
