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
    }),
  ],
  resolve: {
    alias: {
      // `next-intl` normally wires its request config through a Next.js plugin
      // (`createNextIntlPlugin`), which aliases the bare specifier
      // `next-intl/config` to the user's file using a webpack/turbopack alias.
      // vinext builds with Vite, so that alias never reaches the bundler and the
      // import resolves to nothing. Declaring the same alias in Vite is the
      // whole workaround; no patching of next-intl is required.
      "next-intl/config": fileURLToPath(new URL("./i18n/request.ts", import.meta.url)),
    },
  },
});
