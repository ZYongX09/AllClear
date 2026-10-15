/**
 * `wrangler types` derives the global `Env` from wrangler.jsonc bindings and
 * vars, but a secret is not declared there — it is set out of band with
 * `wrangler secret put`. This file augments the generated `Env` with the
 * secrets this Worker reads, so that `env.INTERNAL_KEY` type-checks.
 *
 * Declaration merging works because both this file and the generated
 * worker-configuration.d.ts declare `Env` at global scope.
 */
interface Env {
  /**
   * Shared secret required by every `/internal/*` route. Empty means the
   * internal namespace is disabled, not that it is open.
   */
  INTERNAL_KEY: string;
}
