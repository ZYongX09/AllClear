/**
 * Materialising daily uptime.
 *
 * `daily_uptime` is the only precomputed aggregate in the system, and it exists
 * for a specific reason: computing 90 days of uptime from `probe_result` on every
 * page view would be thousands of rows per request. Everything else in the
 * project derives from raw data at read time; this is the exception, so it is the
 * place where a stale value can hide.
 *
 * The full-day oracle remains available for transitions, finalization and
 * archival. Routine refreshes append an exact, revision-tagged prefix ending at
 * an actual observation, then freshly evaluate the uncommitted tail. Meaningful
 * evidence edits invalidate prefixes transactionally and queue bounded repairs.
 * The prefix and published daily totals commit in the same guarded UPSERT.
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
  type UptimeResult,
  FAULT_RANK,
  clamp01,
} from "@allclear/shared";

/** How many days back a transition triggers an immediate recompute. */
export const TRANSITION_RECOMPUTE_DAYS = 2;

interface ComponentRow {
  id: number;
  available_since: number;
  rollup_revision: number;
}

/** Only a proven prefix is accumulated; the unbracketed tail is never committed. */
export interface UptimePrefix {
  at: number;
  covered: number;
  unknown: number;
  excluded: number;
  weighted: number;
  degraded: number;
  partial: number;
  full: number;
}

interface CheckpointRow {
  component_id: number;
  day: string;
  rollup_revision: number;
  computed_at: number;
  prefix_state: string | null;
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
  /** Evidence revision captured before the reads; persistence rejects stale work. */
  rollupRevision?: number;
  prefix?: UptimePrefix | null;
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
  return computeBatch(db, requests, now, days, false);
}

/** Same maths/oracle, but read only the evidence after a valid prefix checkpoint. */
export async function computeIncrementalDailyUptimeBatch(
  db: D1Database, requests: DailyUptimeRequest[] | null, now: number,
  days: string[] = [utcDay(now)],
): Promise<DailyUptimeRow[]> {
  return computeBatch(db, requests, now, days, true);
}

async function computeBatch(
  db: D1Database, requests: DailyUptimeRequest[] | null, now: number,
  days: string[], incremental: boolean,
): Promise<DailyUptimeRow[]> {
  if (requests?.length === 0) return [];
  const { results: components } = await db.prepare(
    `SELECT c.id, c.available_since, c.rollup_revision,
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
  const checkpoints = incremental && wanted.length > 0
    ? (await db.prepare(`SELECT d.component_id, d.day, d.rollup_revision,
           d.computed_at, d.prefix_state
         FROM json_each(?1) w JOIN daily_uptime d
           ON d.component_id=json_extract(w.value,'$.componentId')
          AND d.day=json_extract(w.value,'$.day') WHERE d.archived=0`)
      .bind(JSON.stringify(wanted)).all<CheckpointRow>()).results : [];
  const prefixFor = (componentId: number, day: string): UptimePrefix | null => {
    const component = components.find((c) => c.id === componentId);
    const checkpoint = checkpoints.find((c) => c.component_id === componentId && c.day === day);
    if (!component || !checkpoint || checkpoint.rollup_revision !== component.rollup_revision
      || checkpoint.computed_at > now || checkpoint.prefix_state === null) return null;
    const prefix = JSON.parse(checkpoint.prefix_state) as UptimePrefix;
    const start = Date.parse(`${day}T00:00:00Z`) / 1000;
    return prefix.at >= start && prefix.at <= Math.min(start + DAY_SECONDS, now) ? prefix : null;
  };
  const spans = components.flatMap((component) => {
    const componentRequests = wanted.filter((r) => r.componentId === component.id);
    const starts = componentRequests.map((r) => Date.parse(`${r.day}T00:00:00Z`) / 1000)
      .filter(Number.isFinite);
    if (starts.length === 0) return [];
    const from = Math.min(...componentRequests.map((r) =>
      prefixFor(r.componentId, r.day)?.at ?? Date.parse(`${r.day}T00:00:00Z`) / 1000));
    const gapMax = defaultCoverageGapMax(component.interval_seconds);
    return [{ componentId: component.id, from,
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
    return [calculateDailyUptime(componentId, day, dayStart, component, impactRows,
      maintenanceRows, resultRows, gapMax, now, incremental ? prefixFor(componentId, day) : undefined)];
  });
}

function calculateDailyUptime(
  componentId: number, day: string, dayStart: number, component: ComponentRow,
  impactRows: ImpactRow[], maintenanceRows: MaintenanceRow[], resultRows: ProbeResultRow[],
  gapMax: number, now: number, previousPrefix?: UptimePrefix | null,
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

  const evaluate = (start: number, end: number) => computeUptime({
    windowStart: start, windowEnd: end, availableSince: component.available_since,
    now, impacts: uptimeImpacts, maintenances: uptimeMaintenances, coverage,
  });
  if (previousPrefix === undefined) {
    const computed = evaluate(dayStart, dayEnd);
    return { componentId, day, coveredSeconds: computed.coveredSeconds,
      unknownSeconds: computed.unknownSeconds, downtimeWeighted: computed.weightedDowntimeSeconds,
      uptime: computed.uptime, worstStatus: computed.worstStatus,
      rollupRevision: component.rollup_revision, prefix: null };
  }
  const prefix = previousPrefix ?? emptyPrefix(dayStart);
  // Never seal the absence of a successor: a later sample may bracket that tail.
  // A post-midnight successor may seal through dayEnd, but must already exist.
  const last = resultRows.reduce((at, row) => Math.max(at, Math.min(dayEnd, row.observed_at)), prefix.at);
  const nextAt = Math.max(prefix.at, Math.min(last, dayEnd, now));
  const next = addResult(prefix, evaluate(prefix.at, nextAt), nextAt);
  const total = addResult(next, evaluate(nextAt, dayEnd), nextAt);
  return { componentId, day, coveredSeconds: total.covered, unknownSeconds: total.unknown,
    downtimeWeighted: total.weighted,
    uptime: total.covered > 0 ? clamp01(1 - total.weighted / total.covered) : null,
    worstStatus: prefixStatus(total), rollupRevision: component.rollup_revision, prefix: next };
}

function emptyPrefix(at: number): UptimePrefix {
  return { at, covered: 0, unknown: 0, excluded: 0, weighted: 0, degraded: 0, partial: 0, full: 0 };
}

function addResult(prefix: UptimePrefix, result: UptimeResult, at: number): UptimePrefix {
  const next = { ...prefix, at, covered: prefix.covered + result.coveredSeconds,
    unknown: prefix.unknown + result.unknownSeconds, excluded: prefix.excluded + result.excludedSeconds,
    weighted: prefix.weighted + result.weightedDowntimeSeconds };
  for (const segment of result.segments) {
    if (segment.counted !== 'covered' || segment.weight <= 0) continue;
    const duration = segment.end - segment.start;
    if (segment.severity === 'degraded_performance') next.degraded += duration;
    if (segment.severity === 'partial_outage') next.partial += duration;
    if (segment.severity === 'full_outage') next.full += duration;
  }
  return next;
}

function prefixStatus(total: UptimePrefix): Status {
  const severities = [
    ...(total.degraded > 0 ? ['degraded_performance' as const] : []),
    ...(total.partial > 0 ? ['partial_outage' as const] : []),
    ...(total.full > 0 ? ['full_outage' as const] : []),
  ];
  if (severities.length > 0) return severities.reduce((a, b) => FAULT_RANK[a] > FAULT_RANK[b] ? a : b);
  if (total.covered === 0) return total.excluded > 0 ? 'maintenance' : 'unknown';
  if (total.unknown > total.covered) return 'unknown';
  return total.excluded > 0 ? 'maintenance' : 'operational';
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
        uptime, worst_status, computed_at, archived, rollup_revision, prefix_state)
     SELECT json_extract(value, '$.componentId'), json_extract(value, '$.day'),
            json_extract(value, '$.coveredSeconds'), json_extract(value, '$.unknownSeconds'),
            json_extract(value, '$.downtimeWeighted'), json_extract(value, '$.uptime'),
            json_extract(value, '$.worstStatus'), ?2, COALESCE(json_extract(value, '$.archived'), 0),
            COALESCE(json_extract(value, '$.rollupRevision'), c.rollup_revision),
            json_extract(value, '$.prefix')
       FROM json_each(?1) JOIN component c ON c.id=json_extract(value,'$.componentId')
      WHERE json_extract(value,'$.rollupRevision') IS NULL
         OR c.rollup_revision=json_extract(value,'$.rollupRevision')
     ON CONFLICT(component_id, day) DO UPDATE SET
       covered_seconds = excluded.covered_seconds,
       unknown_seconds = excluded.unknown_seconds,
       downtime_weighted = excluded.downtime_weighted,
       uptime = excluded.uptime, worst_status = excluded.worst_status,
       computed_at = excluded.computed_at, archived = excluded.archived,
       rollup_revision = excluded.rollup_revision, prefix_state = excluded.prefix_state
     WHERE daily_uptime.archived = 0
       AND (daily_uptime.rollup_revision <> excluded.rollup_revision
         OR (daily_uptime.computed_at <= excluded.computed_at
           AND (excluded.prefix_state IS NULL OR daily_uptime.prefix_state IS NULL
             OR json_extract(excluded.prefix_state,'$.at') >= json_extract(daily_uptime.prefix_state,'$.at'))))`,
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
