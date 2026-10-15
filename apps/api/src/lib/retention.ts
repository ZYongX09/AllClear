/**
 * Probe-result retention.
 *
 * The plan's rule is that raw observations are kept for 30 days and then folded
 * into `daily_uptime` and deleted. The order matters and is the whole point of
 * this module: **roll up, then delete**. Deleting first and rolling up later
 * would destroy the evidence for a day that has no `daily_uptime` row yet, and the
 * loss would be invisible — the day would simply report `unknown` forever, which
 * looks like "nobody measured it" rather than "we deleted the measurement".
 *
 * The delete is therefore gated on the rollup having succeeded for the boundary
 * day. If a component's rollup fails, that day's results are retained and the
 * next run tries again, because a growing table is a recoverable problem and
 * missing evidence is not.
 */

import { startOfUtcDay, utcDay } from "@allclear/shared";

import { computeDailyUptime, persistDailyUptime } from "./uptime-recompute";

/** How long raw observations are kept. */
export const RETENTION_DAYS = 30;

const DAY_SECONDS = 86_400;

export interface RetentionSummary {
  rolledUp: number;
  rollupFailures: number;
  deleted: number;
  cutoffDay: string;
  /** Set when the rollup did not complete, in which case nothing was deleted. */
  skippedDeletionReason?: string;
}

export interface RetentionOptions {
  retentionDays?: number;
  /**
   * The rollup to run before deleting, injectable so the gate can be tested.
   *
   * "Deletion is skipped when a rollup fails" is the property this module exists
   * for, and there is no way to make the real rollup fail from a test without
   * breaking the database underneath it. A safety property with no test is a
   * safety property that gets deleted the first time it is inconvenient, so the
   * seam is deliberate and mirrors the `fetchImpl`/`newId` injection used
   * elsewhere. Production always takes the default.
   */
  computeDay?: typeof computeDailyUptime;
}

/**
 * Roll up the boundary day, then delete observations older than the horizon.
 *
 * The boundary is the day that is *about to* fall out of the retention window:
 * with a 30-day horizon and today at D, that is day `D - 30`. Rolling it up first
 * is what makes the subsequent delete safe.
 */
export async function applyRetention(
  db: D1Database,
  now: number,
  options: RetentionOptions = {},
): Promise<RetentionSummary> {
  const retentionDays = options.retentionDays ?? RETENTION_DAYS;
  const computeDay = options.computeDay ?? computeDailyUptime;
  const cutoffDay = utcDay(startOfUtcDay(now) - retentionDays * DAY_SECONDS);
  const cutoffStart = Math.floor(Date.parse(`${cutoffDay}T00:00:00Z`) / 1000);
  // Everything strictly before the cutoff day's start is out of the window.
  const deleteBefore = cutoffStart;

  const { results: components } = await db
    .prepare("SELECT id FROM component")
    .all<{ id: number }>();

  const summary: RetentionSummary = {
    rolledUp: 0,
    rollupFailures: 0,
    deleted: 0,
    cutoffDay,
  };

  for (const component of components) {
    try {
      const row = await computeDay(db, component.id, cutoffDay, now);
      if (row !== null) {
        await persistDailyUptime(db, row, now);
        summary.rolledUp += 1;
      }
    } catch (error) {
      summary.rollupFailures += 1;
      console.error("retention rollup failed; deletion skipped", {
        componentId: component.id,
        day: cutoffDay,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.rollupFailures > 0) {
    summary.skippedDeletionReason =
      `${summary.rollupFailures} component rollup(s) failed for ${cutoffDay}; ` +
      "raw results retained so the evidence is not lost";
    return summary;
  }

  const deleted = await db
    .prepare("DELETE FROM probe_result WHERE observed_at < ?1")
    .bind(deleteBefore)
    .run();

  summary.deleted = deleted.meta.changes ?? 0;
  return summary;
}
