/**
 * The v1 capacity boundaries, in one place.
 *
 * These three numbers are each enforced in more than one layer — a database
 * `CHECK`, an API validator, the scheduler's own cap, and now the console's
 * forms — and a boundary that is written down four times is a boundary that
 * drifts. They live in `shared` rather than in `apps/api` for the same reason
 * `status.ts` does: both the Worker and the console need the same value, and
 * neither may import the other.
 *
 * They are constants rather than configuration on purpose. The plan's position is
 * that these are the numbers the deployment was *tested* at, and that raising
 * them is a change that needs its own measurement (detection latency, timeout and
 * concurrency behaviour under real load), not a setting an operator can nudge.
 * Making them configurable would let a deployment move outside its evidence
 * without anyone noticing.
 */

/**
 * Hard cap on enabled probe targets.
 *
 * Not a storage limit — it is the size the scheduler was measured at. The cron
 * runs once a minute and selects due targets up to this many per run, so the cap
 * is also what keeps one run inside the D1 subrequest budget on the Free plan.
 */
export const MAX_ENABLED_TARGETS = 20;

/**
 * Minimum probe interval, in seconds.
 *
 * Equal to the cron period. Allowing a shorter interval would let an operator
 * configure a cadence with no mechanism to execute it: the target would simply be
 * checked once a minute while the configuration claimed otherwise, and the
 * documented detection latency — derived from the interval — would be wrong.
 */
export const MIN_PROBE_INTERVAL_SECONDS = 60;

/**
 * Maximum probe interval, in seconds (24 hours).
 *
 * An upper bound exists so that `coverage_gap_max` and the staleness threshold,
 * both of which are derived from the interval, stay within a range where the
 * derived values still mean something. A target checked once a week is a target
 * whose status is `unknown` for most of the week, and the honest way to express
 * that is to disable it rather than to schedule it far apart.
 */
export const MAX_PROBE_INTERVAL_SECONDS = 86_400;
