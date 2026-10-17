/** Persisted maintenance scheduling; no wall-clock modulo slots to miss. */
import { startOfUtcDay, utcDay } from "@allclear/shared";
import { applyRetention, type RetentionSummary } from "./retention";
import { computeDailyUptimeBatch, computeIncrementalDailyUptimeBatch, persistDailyUptimeBatch } from "./uptime-recompute";

export const HISTORY_INTERVAL_SECONDS = 300;
/** At least the default one-minute probe's complete midnight coverage gap. */
export const FINALIZATION_GRACE_SECONDS = 600;
const DAY = 86_400;
const LEASE = 120;

interface Job {
  job: "today" | "finalize" | "retention" | "repair";
  completed_day: string | null;
  cursor_day: string | null;
  finalization_grace: number | null;
  failures: number;
}

export async function runScheduledMaintenance(
  db: D1Database, now: number, urgentComponentIds: number[] = [],
): Promise<{
  historyChanged: boolean;
  historyComputedAt: number | null;
  rolledUp: number;
  retention: RetentionSummary | null;
  errors: string[];
}> {
  const summary = { historyChanged: false, historyComputedAt: null as number | null,
    rolledUp: 0, retention: null as RetentionSummary | null, errors: [] as string[] };
  const today = startOfUtcDay(now);
  const urgent = [...new Set(urgentComponentIds)];
  // Transition evidence has priority; do not add background bursts to that tick.
  if (urgent.length > 0) {
    try {
      const rows = await computeDailyUptimeBatch(db, urgent.flatMap((componentId) =>
        [utcDay(today), utcDay(today - DAY)].map((day) => ({ componentId, day }))), now);
      await persistDailyUptimeBatch(db, rows, now);
      summary.rolledUp = rows.length;
      summary.historyChanged = rows.length > 0;
      summary.historyComputedAt = rows.length > 0 ? now : null;
    } catch (error) { summary.errors.push(`urgent: ${message(error)}`); }
    return summary;
  }
  const token = crypto.randomUUID();
  let job: Job | null = null;
  try {
    // One atomic claim, including the due selection. Leases recover a killed
    // invocation; failed jobs use persisted exponential retry capped at 15 min.
    job = await db.prepare(
      `UPDATE maintenance_job SET claim_token = ?2, lease_until = ?1 + ?3,
          cursor_day = CASE WHEN job = 'finalize' THEN COALESCE(cursor_day,
            date(completed_day, '+1 day'), date(?4, 'unixepoch', '-1 day')) ELSE cursor_day END
        WHERE job = (SELECT job FROM maintenance_job
          WHERE next_run_at <= ?1 AND lease_until <= ?1
            AND (job <> 'repair' OR EXISTS(SELECT 1 FROM component WHERE rollup_dirty=1))
          ORDER BY CASE job WHEN 'today' THEN 0 ELSE 1 END, next_run_at,
            CASE job WHEN 'finalize' THEN 0 WHEN 'retention' THEN 1 ELSE 2 END
          LIMIT 1)
        RETURNING job, completed_day, cursor_day, failures,
          CASE WHEN job = 'finalize' THEN MAX(?5,
            COALESCE((SELECT MAX(2 * interval_seconds) FROM probe_target WHERE enabled = 1), 0))
          END AS finalization_grace`,
    ).bind(now, token, LEASE, today, FINALIZATION_GRACE_SECONDS).first<Job>();
    if (!job) return summary;
    let next = now + HISTORY_INTERVAL_SECONDS;
    let completedDay = job.completed_day;
    let cursorDay = job.cursor_day;
    if (job.job === "repair") {
      // A meaningful mutation invalidates every unsealed day of that component.
      // Repair one historical day per tick; today and probe transitions win.
      const dirty = await db.prepare(`SELECT c.id AS component_id,c.rollup_revision,
        MAX(COALESCE(c.rollup_dirty_from,?1),?2,COALESCE(
          (SELECT date(MAX(d.day),'+1 day') FROM daily_uptime d
            WHERE d.component_id=c.id AND d.archived=1),?2)) AS day
        FROM component c WHERE c.rollup_dirty=1 ORDER BY day,c.id LIMIT 1`)
        .bind(utcDay(today), utcDay(today - 30 * DAY))
        .first<{ component_id: number; rollup_revision: number; day: string }>();
      if (dirty) {
        const candidates = await db.prepare(`SELECT day FROM daily_uptime
          WHERE component_id=?1 AND archived=0 AND rollup_revision<>?2 AND day>=?3
            AND day>COALESCE((SELECT MAX(day) FROM daily_uptime WHERE component_id=?1 AND archived=1),'')
          ORDER BY day LIMIT 1`)
          .bind(dirty.component_id, dirty.rollup_revision,utcDay(today - 30 * DAY)).first<{ day: string }>();
        const day = candidates && candidates.day < dirty.day ? candidates.day : dirty.day;
        if (day <= utcDay(today)) {
          const rows = await computeDailyUptimeBatch(db, [{ componentId: dirty.component_id, day }], now);
          await persistDailyUptimeBatch(db, rows, now);
          summary.rolledUp = rows.length;
        }
        // Only advance the cursor captured with these reads. A concurrent edit
        // lowers dirty_from and increments revision, so this ack cannot erase it.
        const nextDay = utcDay(Date.parse(`${day}T00:00:00Z`) / 1000 + DAY);
        await db.prepare(`UPDATE component SET rollup_dirty_from=?3,
          rollup_dirty=CASE WHEN ?3>?4 AND NOT EXISTS(SELECT 1 FROM daily_uptime d
            WHERE d.component_id=component.id AND d.archived=0 AND d.rollup_revision<>?2
              AND d.day>=?5 AND d.day>COALESCE((SELECT MAX(a.day) FROM daily_uptime a
                WHERE a.component_id=component.id AND a.archived=1),''))
            THEN 0 ELSE 1 END
          WHERE id=?1 AND rollup_revision=?2`)
          .bind(dirty.component_id, dirty.rollup_revision,
            candidates && candidates.day < dirty.day ? dirty.day : nextDay, utcDay(today),utcDay(today - 30 * DAY)).run();
      }
      next = now + 60;
    } else if (job.job === "retention") {
      summary.retention = await applyRetention(db, now, { maxDays: 1 });
      summary.rolledUp = summary.retention.rolledUp;
      if (summary.retention.rollupFailures > 0) throw new Error(summary.retention.skippedDeletionReason);
      if (summary.retention.complete) {
        // Daily housekeeping belongs to the same persisted completion gate.
        await db.prepare("DELETE FROM rate_limit WHERE window_start < ?1").bind(now - DAY).run();
        completedDay = utcDay(today);
        next = today + DAY;
      } else next = now + 60;
    } else {
      const day = job.job === "today" ? utcDay(today) : cursorDay!;
      const dayEnd = Date.parse(`${day}T00:00:00Z`) / 1000 + DAY;
      const eligibleAt = dayEnd + (job.finalization_grace ?? FINALIZATION_GRACE_SECONDS);
      // Persist the initial candidate even before grace. Rebasing on today's
      // midnight would make intervals >= 12 hours ineligible forever.
      if (job.job === "finalize" && now < eligibleAt) next = eligibleAt;
      else {
        const rows = await (job.job === 'today' ? computeIncrementalDailyUptimeBatch : computeDailyUptimeBatch)(db, null, now, [day]);
        await persistDailyUptimeBatch(db, rows, now);
        summary.rolledUp = rows.length;
        completedDay = day;
        if (job.job === "finalize") {
          // One day per tick, including missed days; never jump to yesterday.
          cursorDay = utcDay(dayEnd);
          next = Math.max(now + 60, eligibleAt + DAY);
        }
      }
    }
    summary.historyChanged = summary.rolledUp > 0;
    summary.historyComputedAt = summary.historyChanged ? now : null;
    await db.prepare(
      `UPDATE maintenance_job SET next_run_at = ?3, lease_until = 0, claim_token = NULL,
         completed_day = ?4, cursor_day = ?5, failures = 0, last_error = NULL
         WHERE job = ?1 AND claim_token = ?2`,
    ).bind(job.job, token, next, completedDay, cursorDay).run();
  } catch (error) {
    summary.errors.push(`${job?.job ?? "claim"}: ${message(error)}`);
    // Some completed chunks remain useful even if a later completion write fails.
    summary.historyChanged = summary.rolledUp > 0;
    summary.historyComputedAt = summary.historyChanged ? now : null;
    if (job) {
      try {
        await db.prepare(
          `UPDATE maintenance_job SET next_run_at = ?3, lease_until = 0, claim_token = NULL,
             failures = failures + 1, last_error = ?4 WHERE job = ?1 AND claim_token = ?2`,
        ).bind(job.job, token, now + Math.min(900, 60 * 2 ** Math.min(job.failures, 4)), message(error)).run();
      } catch (releaseError) { summary.errors.push(`release: ${message(releaseError)}`); }
    }
  }
  return summary;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
