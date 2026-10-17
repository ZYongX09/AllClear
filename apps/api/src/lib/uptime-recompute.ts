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
  /** Finalized immediately before raw evidence is purged. */
  archived?: boolean;
}

const DAY_SECONDS = 86_400;

const FAULT_SEVERITIES = new Set(["degraded_performance", "partial_outage", "full_outage"]);

/** A bounded set of component/day requests shares four reads, not four per row. */
export interface DailyUptimeRequest {
  componentId: number;
  day: string;
}

/**
 * Read both neighbours of midnight. A successor is evidence only once it has
 * actually been observed (`<= now`), never merely because a probe is due.
 */
export async function computeDailyUptime(
  db: D1Database,
  componentId: number,
  day: string,
  now: number,
): Promise<DailyUptimeRow | null> {
  return (await computeDailyUptimeBatch(db, [{ componentId, day }], now))[0] ?? null;
}

/** Null requests means all components for `days`; callers bound the day count. */
export async function computeDailyUptimeBatch(
  db: D1Database,
  requests: DailyUptimeRequest[] | null,
  now: number,
  days: string[] = [utcDay(now)],
): Promise<DailyUptimeRow[]> {
  if (requests?.length === 0) return [];
  const { results: components } = await db.prepare(
    `SELECT c.id, c.available_since,
            MAX(60, COALESCE(MAX(t.interval_seconds), 60)) AS interval_seconds,
            (SELECT MAX(day) FROM daily_uptime d
              WHERE d.component_id = c.id AND d.archived = 1) AS archived_through
       FROM component c
       LEFT JOIN probe_target t ON t.component_id = c.id AND t.enabled = 1
      WHERE ?1 IS NULL OR c.id IN
        (SELECT json_extract(value, '$.componentId') FROM json_each(?1))
      GROUP BY c.id`,
  ).bind(requests === null ? null : JSON.stringify(requests))
    .all<ComponentRow & TargetRow & { archived_through: string | null }>();
  const wanted = (requests ?? components.flatMap((c) => days.map((day) => ({ componentId: c.id, day }))))
    .filter((r) => {
      const component = components.find((c) => c.id === r.componentId);
      return component && (component.archived_through === null || r.day > component.archived_through);
    });
  const spans = components.flatMap((component) => {
    const starts = wanted.filter((r) => r.componentId === component.id)
      .map((r) => Date.parse(`${r.day}T00:00:00Z`) / 1000).filter(Number.isFinite);
    if (starts.length === 0) return [];
    const gapMax = defaultCoverageGapMax(component.interval_seconds);
    return [{ componentId: component.id, from: Math.min(...starts),
      to: Math.max(...starts) + DAY_SECONDS, gapMax }];
  });
  if (spans.length === 0) return [];
  const encoded = JSON.stringify(spans);
  const [impacts, maintenances, results] = await db.batch([
    db.prepare(
      `SELECT i.component_id, i.severity, i.start_at, i.end_at, i.probe_target_id
         FROM json_each(?1) s JOIN impact i
           ON i.component_id = json_extract(s.value, '$.componentId')
        WHERE i.start_at < json_extract(s.value, '$.to')
          AND (i.end_at IS NULL OR i.end_at > json_extract(s.value, '$.from'))`,
    ).bind(encoded),
    // Window overlap, not the maintenance change's current status, is evidence.
    db.prepare(
      `SELECT cc.component_id, ch.starts_at, ch.ends_at
         FROM json_each(?1) s JOIN change_component cc
           ON cc.component_id = json_extract(s.value, '$.componentId')
         JOIN change ch ON ch.id = cc.change_id
        WHERE ch.kind = 'maintenance'
          AND ch.starts_at < json_extract(s.value, '$.to')
          AND (ch.ends_at IS NULL OR ch.ends_at > json_extract(s.value, '$.from'))`,
    ).bind(encoded),
    db.prepare(
      `SELECT t.component_id, r.observed_at
         FROM json_each(?1) s JOIN probe_target t
           ON t.component_id = json_extract(s.value, '$.componentId')
         JOIN probe_result r ON r.probe_target_id = t.id
          AND r.observed_at >= json_extract(s.value, '$.from') - json_extract(s.value, '$.gapMax')
          AND r.observed_at <= MIN(json_extract(s.value, '$.to') + json_extract(s.value, '$.gapMax'), ?2)
        ORDER BY t.component_id, r.observed_at`,
    ).bind(encoded, now),
  ]);
  return wanted.flatMap(({ componentId, day }) => {
    const component = components.find((c) => c.id === componentId);
    const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
    if (!component || !Number.isFinite(dayStart)) return [];
    const gapMax = defaultCoverageGapMax(component.interval_seconds);
    const impactRows = (impacts.results as unknown as (ImpactRow & { component_id: number })[])
      .filter((r) => r.component_id === componentId);
    const maintenanceRows = (maintenances.results as unknown as (MaintenanceRow & { component_id: number })[])
      .filter((r) => r.component_id === componentId);
    const resultRows = (results.results as unknown as (ProbeResultRow & { component_id: number })[])
      .filter((r) => r.component_id === componentId && r.observed_at >= dayStart - gapMax
        && r.observed_at <= Math.min(dayStart + DAY_SECONDS + gapMax, now));
    return [calculateDailyUptime(componentId, day, dayStart, component, impactRows, maintenanceRows, resultRows, gapMax, now)];
  });
}

function calculateDailyUptime(
  componentId: number, day: string, dayStart: number, component: ComponentRow,
  impactRows: ImpactRow[], maintenanceRows: MaintenanceRow[], resultRows: ProbeResultRow[],
  gapMax: number, now: number,
): DailyUptimeRow {
  const dayEnd = dayStart + DAY_SECONDS;
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
  await persistDailyUptimeBatch(db, [row], now);
}

/** One SQL statement; D1 batch() alone does not reduce statement counts. */
export function dailyUptimeStatement(
  db: D1Database, rows: DailyUptimeRow[], now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO daily_uptime
       (component_id, day, covered_seconds, unknown_seconds, downtime_weighted,
        uptime, worst_status, computed_at, archived)
     SELECT json_extract(value, '$.componentId'), json_extract(value, '$.day'),
            json_extract(value, '$.coveredSeconds'), json_extract(value, '$.unknownSeconds'),
            json_extract(value, '$.downtimeWeighted'), json_extract(value, '$.uptime'),
            json_extract(value, '$.worstStatus'), ?2, COALESCE(json_extract(value, '$.archived'), 0)
       FROM json_each(?1) WHERE 1
     ON CONFLICT(component_id, day) DO UPDATE SET
       covered_seconds = excluded.covered_seconds,
       unknown_seconds = excluded.unknown_seconds,
       downtime_weighted = excluded.downtime_weighted,
       uptime = excluded.uptime, worst_status = excluded.worst_status,
       computed_at = excluded.computed_at, archived = excluded.archived
     WHERE daily_uptime.archived = 0`,
  ).bind(JSON.stringify(rows), now);
}

export async function persistDailyUptimeBatch(
  db: D1Database, rows: DailyUptimeRow[], now: number,
): Promise<void> {
  if (rows.length > 0) await dailyUptimeStatement(db, rows, now).run();
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
  const requests = Array.from({ length: days }, (_, offset) => ({
    componentId, day: utcDay(startOfUtcDay(now) - offset * DAY_SECONDS),
  }));
  await persistDailyUptimeBatch(db, await computeDailyUptimeBatch(db, requests, now), now);
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
  const wanted = Array.from({ length: days }, (_, offset) =>
    utcDay(startOfUtcDay(now) - offset * DAY_SECONDS));
  const rows = await computeDailyUptimeBatch(db, null, now, wanted);
  await persistDailyUptimeBatch(db, rows, now);
  return new Set(rows.map((r) => r.componentId)).size;
}
