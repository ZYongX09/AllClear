/**
 * The dev config used to look at the status page with content on it.
 *
 *   npx vite dev --config verify/vite.config.verify.ts
 *
 * It mirrors `vite.config.ts` and adds one thing: `allclear-api` as an auxiliary
 * Worker, so the web Worker's Service Binding resolves to the fixture in
 * `verify/api-stub.ts` instead of failing with "Worker allclear-api not found".
 *
 * The real config is not touched. An auxiliary Worker cannot be expressed by
 * pointing at `apps/api/wrangler.jsonc` — the plugin takes a typed inline config,
 * not a path — so wiring the real API in for local development would mean
 * duplicating its D1 and KV ids here, which is a worse trade than a fixture that
 * only exists to be rendered against.
 *
 * `types.generate` is off: the auxiliary Worker would otherwise be included in
 * the generated `Env`, and `.cloudflare/types/index.d.ts` must keep describing
 * the Worker that actually deploys.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

export default defineConfig({
  plugins: [
    vinext({
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
      types: { generate: false },
      auxiliaryWorkers: [
        {
          config: {
            name: "allclear-api",
            // `entrypoint`, not `main`: the typed `cf` config calls the module
            // specifier `entrypoint`, and the plugin rejects an auxiliary Worker
            // without one.
            entrypoint: fileURLToPath(new URL("./api-stub.ts", import.meta.url)),
            compatibilityDate: "2026-10-15",
            workersDev: false,
          },
        },
      ],
    }),
  ],
  resolve: {
    alias: {
      "next-intl/config": fileURLToPath(new URL("../i18n/request.ts", import.meta.url)),
    },
  },
});
