import { applyD1Migrations } from "cloudflare:test";

import { testEnv } from "./env";

/**
 * Applied once per test file, against storage that is *shared by every test in
 * that file*.
 *
 * This is worth stating plainly because the opposite is easy to assume. The
 * `@cloudflare/vitest-pool-workers` package this plugin replaced had an
 * `isolatedStorage` option that snapshotted and restored bindings around each
 * test; `@cloudflare/vitest-plugin` 1.4.2 has no such option, and a two-test
 * experiment confirms the behaviour: a row written in one test is still readable
 * in the next.
 *
 * The consequence is a rule for writing tests here, not a defect to work around:
 *
 *   * A test that only reads what it seeded itself is fine. Seeding a page with a
 *     unique slug per test — which `helpers.ts` does — is enough isolation.
 *   * A test that exercises a *global* operation is not. `runProbes` selects every
 *     due target, `applyRetention` deletes by age across the whole table, and the
 *     rate limiter counts per bucket name, so each of those files must clear or
 *     disable the state it depends on in `beforeEach`. That is why
 *     `probe-run.test.ts` disables every target before each test and
 *     `uptime-retention.test.ts` clears `probe_result`.
 */
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
