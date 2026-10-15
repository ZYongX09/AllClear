import { applyD1Migrations } from "cloudflare:test";

import { testEnv } from "./env";

// Applied once per test file's storage snapshot. Each test then starts from the
// migrated schema, so a test's writes never leak into its neighbours.
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
