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

      // The public read path. The status page reads the snapshot from KV and
      // must keep working when D1 is unavailable, so KV is the primary source.
      SNAPSHOT_KV: bindings.kv({ id: "c0ef8e657cbe47a6a6e9e72a5df41581" }),

      // Only used by the read chain's documented fallback (KV miss or a stale
      // snapshot_version). Deliberately not required for a normal page view.
      DB: bindings.d1({
        name: "allclear-db",
        id: "81f85a9d-9aae-4c7c-94a8-a84a812b1c51",
      }),

      // `allclear-api` has no public route. This Service Binding is the only
      // way to reach it, and it is not by itself an authorisation: the Worker
      // also requires INTERNAL_KEY on every /internal/* route.
      API: bindings.worker({ worker: "allclear-api" }),

      // Server-side only. Never exposed to the browser: the web Worker holds
      // it and attaches it when calling the API Worker.
      INTERNAL_KEY: bindings.secret(),
    },
  }),
});
