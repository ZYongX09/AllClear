/**
 * Materialising daily uptime.
 *
 * `daily_uptime` is the only precomputed aggregate in the system, and it exists
 * for a specific reason: computing 90 days of uptime from `probe_result` on every
 * page view would be thousands of rows per request. Everything else in the
 * project derives from raw data at read time; this is the exception, so it is the
 * place where a stale value can hide.
 *
 * Two properties keep it honest:
 *
 *   * The recompute is *idempotent and total* for a day: it reads the impacts and
 *     probe results for that day and overwrites the row. There is no incremental
 *     accumulation, so a missed run is repaired by the next one rather than
 *     leaving a permanently wrong number.
 *   * Every transition recomputes the affected component's recent days
 *     immediately, so "today" is never a day behind.
 */

import {
  computeCoverageIntervals,
  computeUptime,
  defaultCoverageGapMax,
  startOfUtcDay,
  utcDay,
  type Interval,
  type Status,
  type UptimeImpact,
  type UptimeMaintenance,
} from "@allclear/shared";

/** How many days back a transition triggers an immediate recompute. */
export const TRANSITION_RECOMPUTE_DAYS = 2;

interface ComponentRow {
  id: number;
  available_since: number;
}

interface ImpactRow {
  severity: string;
  start_at: number;
  end_at: number | null;
  probe_target_id: number | null;
}

interface MaintenanceRow {
  starts_at: number;
  ends_at: number | null;
}

interface ProbeResultRow {
  observed_at: number;
}

interface TargetRow {
  interval_seconds: number;
}

export interface DailyUptimeRow {
  componentId: number;
  day: string;
  coveredSeconds: number;
  unknownSeconds: number;
  downtimeWeighted: number;
  uptime: number | null;
  worstStatus: Status;
}

const DAY_SECONDS = 86_400;

const FAULT_SEVERITIES = new Set(["degraded_performance", "partial_outage", "full_outage"]);

/**
 * Compute one component's uptime for one UTC day.
 *
 * Coverage is gathered from a window that starts one gap before the day and ends
 * at the day's end, because the observation *before* midnight is what brackets
 * the first covered second of the day. Fetching only the day's own results would
 * make every day look like it begins with an unmeasured gap.
 */
export async function computeDailyUptime(
  db: D1Database,
  componentId: number,
  day: string,
  now: number,
): Promise<DailyUptimeRow | null> {
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  if (!Number.isFinite(dayStart)) return null;
  const dayEnd = dayStart + DAY_SECONDS;

  const component = await db
    .prepare("SELECT id, available_since FROM component WHERE id = ?1")
    .bind(componentId)
    .first<ComponentRow>();
  if (!component) return null;

  const targets = await db
    .prepare(
      `SELECT interval_seconds FROM probe_target
        WHERE component_id = ?1 AND enabled = 1`,
    )
    .bind(componentId)
    .all<TargetRow>();

  const interval = targets.results.reduce(
    (max, row) => Math.max(max, row.interval_seconds),
    60,
  );
  const gapMax = defaultCoverageGapMax(interval);

  const [impacts, maintenances, results] = await db.batch([
    db
      .prepare(
        `SELECT severity, start_at, end_at, probe_target_id
           FROM impact
          WHERE component_id = ?1
            AND start_at < ?3
            AND (end_at IS NULL OR end_at > ?2)`,
      )
      .bind(componentId, dayStart, dayEnd),
    // Selected by *window overlap only* — deliberately not by `ch.status`.
    //
    // A status filter here looks reasonable and is wrong in both directions.
    // `status <> 'completed'` makes a past day's uptime change retroactively: the
    // window is deducted while the maintenance runs and counted once someone
    // marks it completed, so the same historical day reports a worse number after
    // the fact, and deliberate downtime inside an announced window is charged as
    // an outage. `status = 'in_progress'` has the same defect plus one more: a
    // window whose operator never posted the update that moves it out of
    // `scheduled` is silently ignored.
    //
    // The plan's rule is about the *window*, not about the change's present
    // status: "maintenance windows are deducted from the denominator". Whether a
    // window has started is already answered by the time overlap below, which is
    // why an announced future window cannot be deducted early — `starts_at` is
    // the announced start, so it does not intersect the day. And the exclusion
    // cannot hide downtime regardless: `computeUptime` keeps any segment with a
    // non-zero fault weight counted even when it falls inside a window.
    db
      .prepare(
        `SELECT ch.starts_at, ch.ends_at
           FROM change ch
           JOIN change_component cc ON cc.change_id = ch.id
          WHERE cc.component_id = ?1
            AND ch.kind = 'maintenance'
            AND ch.starts_at < ?3
            AND (ch.ends_at IS NULL OR ch.ends_at > ?2)`,
      )
      .bind(componentId, dayStart, dayEnd),
    db
      .prepare(
        `SELECT r.observed_at
           FROM probe_result r
           JOIN probe_target t ON t.id = r.probe_target_id
          WHERE t.component_id = ?1
            AND r.observed_at >= ?2
            AND r.observed_at <= ?3
          ORDER BY r.observed_at`,
      )
      .bind(componentId, dayStart - gapMax, dayEnd),
  ]);

  const impactRows = impacts.results as unknown as ImpactRow[];
  const maintenanceRows = maintenances.results as unknown as MaintenanceRow[];
  const resultRows = results.results as unknown as ProbeResultRow[];

  const uptimeImpacts: UptimeImpact[] = [];
  const uptimeMaintenances: UptimeMaintenance[] = [];

  for (const row of impactRows) {
    if (row.severity === "maintenance") {
      uptimeMaintenances.push({ startAt: row.start_at, endAt: row.end_at });
      continue;
    }
    if (!FAULT_SEVERITIES.has(row.severity)) continue;
    uptimeImpacts.push({
      severity: row.severity as UptimeImpact["severity"],
      startAt: row.start_at,
      endAt: row.end_at,
      // A probe target id is what distinguishes a sampled fault from a recorded
      // one, and that distinction decides whether the interval is intersected
      // with coverage. Deriving it from `severity` or from the timestamps would
      // be guesswork.
      source: row.probe_target_id === null ? "manual" : "probe",
    });
  }

  for (const row of maintenanceRows) {
    uptimeMaintenances.push({ startAt: row.starts_at, endAt: row.ends_at });
  }

  const coverage: Interval[] = computeCoverageIntervals(
    resultRows.map((row) => row.observed_at),
    gapMax,
  );

  const computed = computeUptime({
    windowStart: dayStart,
    windowEnd: dayEnd,
    availableSince: component.available_since,
    now,
    impacts: uptimeImpacts,
    maintenances: uptimeMaintenances,
    coverage,
  });

  return {
    componentId,
    day,
    coveredSeconds: computed.coveredSeconds,
    unknownSeconds: computed.unknownSeconds,
    downtimeWeighted: computed.weightedDowntimeSeconds,
    uptime: computed.uptime,
    worstStatus: computed.worstStatus,
  };
}

/** Write one day's row. Idempotent: the row is replaced, never accumulated. */
export async function persistDailyUptime(
  db: D1Database,
  row: DailyUptimeRow,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_uptime
         (component_id, day, covered_seconds, unknown_seconds, downtime_weighted,
          uptime, worst_status, computed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(component_id, day) DO UPDATE SET
         covered_seconds   = excluded.covered_seconds,
         unknown_seconds   = excluded.unknown_seconds,
         downtime_weighted = excluded.downtime_weighted,
         uptime            = excluded.uptime,
         worst_status      = excluded.worst_status,
         computed_at       = excluded.computed_at`,
    )
    .bind(
      row.componentId,
      row.day,
      row.coveredSeconds,
      row.unknownSeconds,
      row.downtimeWeighted,
      row.uptime,
      row.worstStatus,
      now,
    )
    .run();
}

/**
 * Recompute the days a state change could have affected.
 *
 * Two days rather than one because an impact opened just before midnight and
 * closed just after it touches both. The cost is bounded and the alternative —
 * recomputing only "today" — leaves yesterday's row permanently wrong.
 */
export async function recomputeRecentDays(
  db: D1Database,
  componentId: number,
  now: number,
  days = TRANSITION_RECOMPUTE_DAYS,
): Promise<void> {
  for (let offset = 0; offset < days; offset += 1) {
    const day = utcDay(startOfUtcDay(now) - offset * DAY_SECONDS);
    const row = await computeDailyUptime(db, componentId, day, now);
    if (row !== null) await persistDailyUptime(db, row, now);
  }
}

/**
 * Recompute every component's recent days.
 *
 * Run from cron so that a day's row is finalised after midnight even when nothing
 * transitions — without this, a quiet day would keep yesterday's row until the
 * next write, and "yesterday" would silently mean "yesterday as of whenever the
 * last incident happened".
 */
export async function recomputeAllRecentDays(
  db: D1Database,
  now: number,
  days = TRANSITION_RECOMPUTE_DAYS,
): Promise<number> {
  const { results } = await db
    .prepare("SELECT id FROM component")
    .all<{ id: number }>();

  for (const component of results) {
    await recomputeRecentDays(db, component.id, now, days);
  }
  return results.length;
}
