import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * The state-machine tests run against a real `workerd` with a real D1 binding,
 * not a mock. That is not incidental: the design depends on specific SQLite
 * behaviour — `batch()` rolling back as one transaction, a conditional UPDATE
 * matching zero rows without raising, partial unique indexes, `meta.changes` —
 * and a mock would assert my beliefs about those instead of the behaviour
 * itself. See docs/spec/state-machine.md.
 *
 * Note the package name. This integration was renamed from
 * `@cloudflare/vitest-pool-workers` (now marked deprecated) to
 * `@cloudflare/vitest-plugin`, which also replaced the `defineWorkersConfig`
 * helper with a plain Vite plugin. Both exist on npm and the older name still
 * installs, so this is worth stating explicitly rather than rediscovering.
 */
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Vitest's 5 s default is sized for in-process unit tests. These are
    // integration tests: each one starts real `workerd` work, and the
    // concurrency cases deliberately run several 5-attempt retry loops against
    // one D1 row, so a single test has been measured at over a second on an idle
    // machine. A slow CI box would trip the default and report a timeout, which
    // looks like a state-machine failure and is not one.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
