/**
 * `wrangler types` derives the global `Env` from wrangler.jsonc bindings and
 * vars, but a secret is not declared there — it is set out of band with
 * `wrangler secret put`. This file augments the generated `Env` with the
 * secrets this Worker reads, so that `env.INTERNAL_KEY` type-checks.
 *
 * Declaration merging works because both this file and the generated
 * worker-configuration.d.ts declare `Env` at global scope. Note that the
 * generated file already declares the `vars` from wrangler.jsonc
 * (`PUBLIC_BASE_URL`, `EMAIL_FROM`, `MAX_TARGETS_PER_RUN`), so those must not be
 * repeated here: a merged interface requires every duplicated member to have an
 * identical type, and the generated ones are string literals.
 */
interface Env {
  /**
   * Shared secret required by every `/internal/*` route. Empty means the
   * internal namespace is disabled, not that it is open.
   */
  INTERNAL_KEY: string;

  /**
   * Signing key for unsubscribe links.
   *
   * Empty disables notification entirely rather than degrading to unsigned
   * links: an unsubscribe URL that anyone can forge is a way to unsubscribe
   * other people, and one that cannot be revoked never expires. Subscribing
   * still works without it — the address is recorded and confirmable — but no
   * message is ever sent.
   */
  UNSUBSCRIBE_HMAC_KEY: string;

  /**
   * The `send_email` binding.
   *
   * Declared here rather than in wrangler.jsonc on purpose: adding the binding
   * to the config makes `wrangler deploy` fail on any account without a verified
   * sending domain, which would break deployment for anyone who only wants a
   * status page. When it is absent, `createEmailSender` falls back to a
   * recording sender and **no email is delivered** — see
   * docs/spec/subscriptions.md.
   */
  EMAIL?: import("../src/subscribe/email").EmailBinding;
}
