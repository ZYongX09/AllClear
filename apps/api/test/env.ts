/**
 * The test runtime's bindings, with the one test-only binding typed.
 *
 * `cloudflare:workers`'s `env` is typed `Cloudflare.Env`, which `wrangler types`
 * generates from `wrangler.jsonc`. `TEST_MIGRATIONS` is injected by
 * vitest.config.ts through Miniflare bindings instead, so it is deliberately
 * *not* part of that generated interface.
 *
 * It is added here as a narrow, test-local type rather than by augmenting
 * `Cloudflare.Env` globally. An augmentation would live in the same TypeScript
 * program as `src/`, so production code could read `env.TEST_MIGRATIONS` and
 * typecheck while always seeing `undefined` at runtime.
 *
 * `env` is imported from `cloudflare:workers` rather than from `cloudflare:test`
 * because the latter is marked deprecated in `@cloudflare/vitest-plugin` 1.4.2.
 * `applyD1Migrations` has no replacement yet and still comes from
 * `cloudflare:test`.
 */
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";

export const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
