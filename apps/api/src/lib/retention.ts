/** Roll up every expired evidence day before deleting it, in bounded chunks. */
import { startOfUtcDay, utcDay } from "@allclear/shared";
import { computeDailyUptime, dailyUptimeStatement } from "./uptime-recompute";

export const RETENTION_DAYS = 30;
const DAY_SECONDS = 86_400;

export interface RetentionSummary {
  rolledUp: number;
  rollupFailures: number;
  deleted: number;
  cutoffDay: string;
  skippedDeletionReason?: string;
  /** False means persisted archive watermarks have more catch-up work. */
  complete?: boolean;
}

export interface RetentionOptions {
  retentionDays?: number;
  computeDay?: typeof computeDailyUptime;
  /** Component-days per invocation; scheduled maintenance uses one. */
  maxDays?: number;
}

export async function applyRetention(
  db: D1Database, now: number, options: RetentionOptions = {},
): Promise<RetentionSummary> {
  const cutoff = startOfUtcDay(now) - (options.retentionDays ?? RETENTION_DAYS) * DAY_SECONDS;
  const summary: RetentionSummary = {
    rolledUp: 0, rollupFailures: 0, deleted: 0, cutoffDay: utcDay(cutoff), complete: false,
  };
  const limit = Math.max(1, Math.min(options.maxDays ?? 32, 32));
  for (let chunk = 0; chunk < limit; chunk += 1) {
    // Once seeded, the archive watermark is a continuous day cursor, not a
    // search for the next sample date: neighbouring samples (or manual impacts)
    // can cover an entire intervening day with no observations of its own.
    // Only the initial seed seeks actual evidence; available_since alone must
    // not manufacture years of empty archives. Each raw MIN is a target/time
    // index seek, including disabled targets, never a probe_result table scan.
    const candidate = await db.prepare(
      `SELECT component_id, first_at FROM (
         SELECT c.id AS component_id, COALESCE(
           (SELECT unixepoch(MAX(d.day), '+1 day') FROM daily_uptime d
             WHERE d.component_id = c.id AND d.archived = 1),
           (SELECT MIN(first_at) FROM (
             SELECT (SELECT MIN(r.observed_at) FROM probe_result r
                       WHERE r.probe_target_id = t.id AND r.observed_at < ?1) AS first_at
               FROM probe_target t WHERE t.component_id = c.id
             UNION ALL
             SELECT MIN(i.start_at) FROM impact i
               WHERE i.component_id = c.id AND i.probe_target_id IS NULL AND i.start_at < ?1
           ))
         ) AS first_at FROM component c
       ) WHERE first_at < ?1
       ORDER BY first_at, component_id LIMIT 1`,
    ).bind(cutoff).first<{ component_id: number; first_at: number }>();
    if (!candidate) { summary.complete = true; break; }
    const day = utcDay(candidate.first_at);
    const dayEnd = startOfUtcDay(candidate.first_at) + DAY_SECONDS;
    try {
      const row = await (options.computeDay ?? computeDailyUptime)(db, candidate.component_id, day, now);
      if (!row) throw new Error(`no rollup for component ${candidate.component_id} on ${day}`);
      // Materialization+seal+purge commit together. Any failed write rolls back
      // all three; retry can never observe a seal without its aggregate.
      // Uptime reads all targets with a component-level enabled-target gap.
      // Preserve each target's anchor using that same gap, even if disabled.
      const result = await db.batch([
        dailyUptimeStatement(db, [{ ...row, archived: true }], now),
        db.prepare(
          `DELETE FROM probe_result WHERE EXISTS (
             SELECT 1 FROM daily_uptime d JOIN component c ON c.id=d.component_id
              WHERE d.component_id=?1 AND d.day=?3 AND d.archived=1
                AND d.rollup_revision=c.rollup_revision
           ) AND id IN (
             SELECT r.id FROM probe_target t JOIN probe_result r
               ON r.probe_target_id = t.id AND r.observed_at < ?2
              WHERE t.component_id = ?1
                AND r.public_id IS NOT (SELECT s.last_result_id FROM probe_state s
                                        WHERE s.probe_target_id = t.id)
                AND r.id IS NOT (
                  SELECT p.id FROM probe_result p
                   WHERE p.probe_target_id = t.id AND p.observed_at < ?2
                     AND p.observed_at >= ?2 - MAX(120, 2 * COALESCE(
                       (SELECT MAX(enabled.interval_seconds) FROM probe_target enabled
                         WHERE enabled.component_id = ?1 AND enabled.enabled = 1), 60))
                   ORDER BY p.observed_at DESC, p.id DESC LIMIT 1)
           )`,
        ).bind(candidate.component_id, dayEnd, day),
      ]);
      if ((result[0]!.meta.changes ?? 0) === 0) throw new Error('evidence changed before archival commit; retry required');
      summary.rolledUp += 1;
      summary.deleted += result[1]!.meta.changes ?? 0;
    } catch (error) {
      summary.rollupFailures += 1;
      summary.skippedDeletionReason = `rollup failed for ${day}; raw results retained: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  return summary;
}
