/**
 * Uptime maths: a weighted interval sweep with coverage intersection.
 *
 * Three ideas carry the whole file, and each one exists because the obvious
 * simpler version gets it wrong.
 *
 * ## 1. Sweep, do not union
 *
 * The naive calculation sums the duration of each active impact. That
 * double-counts whenever two impacts overlap, and the usual repair — take the
 * union per severity, then add the severities together — still double-counts
 * when a `partial_outage` and a `full_outage` overlap in time: the minute is
 * charged once at 0.5 and again at 1.0, producing a downtime longer than the
 * window and an uptime below zero.
 *
 * So the window is cut at every impact boundary into non-overlapping segments,
 * and each segment is charged once at the *worst* weight active during it:
 *
 *     D_weighted = sum over segments of (delta_t x max weight active in segment)
 *
 * ## 2. Downtime needs evidence, so it is intersected with coverage
 *
 * A probe *samples*. An impact that a probe opened is bounded by two samples,
 * not by the real fault. More importantly, a probe that stopped reporting leaves
 * an impact open forever, and an unmonitored week must not be charged as a week
 * of downtime — nor credited as a week of uptime.
 *
 * Probe-sourced impacts are therefore intersected with the coverage intervals
 * (see `computeCoverageIntervals`) and only the overlap is counted. Time with
 * neither coverage nor a hand-entered record is reported as `unknownSeconds` and
 * is *excluded from the denominator* rather than assumed healthy.
 *
 * Hand-entered impacts are different in kind: a human recording an outage is
 * direct evidence, not a sample, so those count wherever they fall.
 *
 * ## 3. A zero denominator is `null`, never 100
 *
 * `uptime` is `null` whenever nothing measurable happened in the window — no
 * coverage, or a window entirely excluded as maintenance. Returning 1.0 there
 * would manufacture a perfect record out of an absence of measurement, which is
 * the single most misleading number this system could print.
 *
 * See docs/spec/uptime-math.md for the worked cases and the test matrix.
 */

import { FAULT_RANK, type FaultSeverity, type Status } from "./status";

/** Half-open interval `[start, end)` in epoch seconds. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Relative weights of the fault severities.
 *
 * `partial_outage` is half of a full outage and `degraded_performance` a quarter,
 * which is a stated convention rather than a measurement. It is configurable
 * because the right ratio is a judgement about a particular service, and the
 * algorithm must not silently encode someone else's.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<FaultSeverity, number>> = {
  degraded_performance: 0.25,
  partial_outage: 0.5,
  full_outage: 1,
};

/**
 * Whether an impact came from a probe or from a human.
 *
 * This is not cosmetic bookkeeping: it decides whether the interval is treated as
 * a sample (and therefore intersected with coverage) or as direct evidence.
 */
export type ImpactSource = "probe" | "manual";

export interface UptimeImpact {
  severity: FaultSeverity;
  startAt: number;
  /** `null` while the impact is still open. */
  endAt: number | null;
  source: ImpactSource;
}

/** A declared maintenance window. Excluded from the denominator by default. */
export interface UptimeMaintenance {
  startAt: number;
  /** `null` for an open-ended window. */
  endAt: number | null;
}

export interface UptimeInput {
  /** Window start, inclusive. */
  windowStart: number;
  /** Window end, exclusive. */
  windowEnd: number;
  /** When the component first existed. Windows before this are not measurable. */
  availableSince: number;
  /** Evaluation time. Nothing after this is counted, so today is not extrapolated. */
  now: number;
  impacts: readonly UptimeImpact[];
  maintenances: readonly UptimeMaintenance[];
  /** Coverage intervals, already computed by `computeCoverageIntervals`. */
  coverage: readonly Interval[];
  weights?: Readonly<Record<FaultSeverity, number>>;
}

export interface UptimeResult {
  /**
   * `1 - weightedDowntime / coveredSeconds`, clamped to `[0, 1]`.
   * `null` when there is nothing measurable: no coverage, or a window that is
   * entirely excluded maintenance.
   */
  uptime: number | null;
  /** Denominator: seconds with coverage evidence or a hand-entered record. */
  coveredSeconds: number;
  /** Seconds with no evidence at all. Excluded from the denominator. */
  unknownSeconds: number;
  /** Seconds removed from the window as maintenance-only. */
  excludedSeconds: number;
  /** Numerator. */
  weightedDowntimeSeconds: number;
  /** Whether an impact was still open at `now`. */
  ongoing: boolean;
  /** Whether the window extends past `now` (today, or a partial day). */
  partial: boolean;
  /**
   * The worst thing that happened during the counted time, for a calendar cell.
   *
   * Ordering, and the reasoning for the awkward middle case: any fault wins,
   * because a fault is an observation. Otherwise a window with no coverage at all
   * is `unknown`, and so is one where unknown time outlasts covered time — a day
   * nobody could measure for most of its length is not a healthy day. Only then
   * does maintenance, and finally `operational`, apply.
   */
  worstStatus: Status;
  /** Segments the sweep produced, in order. Exposed for tests and diagnostics. */
  segments: readonly UptimeSegment[];
}

export interface UptimeSegment {
  start: number;
  end: number;
  /** Worst fault weight active in the segment; 0 when none. */
  weight: number;
  /** Worst fault severity active in the segment, or null. */
  severity: FaultSeverity | null;
  hasCoverage: boolean;
  isMaintenance: boolean;
  /** How the segment was accounted for. */
  counted: "covered" | "unknown" | "excluded";
}

/**
 * Derive coverage intervals from a component's probe results.
 *
 * A component is covered between two *adjacent* observations when the gap
 * between them is no larger than `gapMax`. Coverage is therefore the union of
 * `[r_k, r_{k+1})` over qualifying adjacent pairs — deliberately not including
 * any tail after the final observation. Extending coverage to "the next result
 * should have arrived by now" would credit a prober that has stopped reporting,
 * which is exactly the failure the coverage concept exists to catch.
 *
 * One consequence is worth stating because it surprises people: a component with
 * a single observation has *no* coverage, not full coverage. One sample cannot
 * bracket anything, so there is nothing to intersect a fault with.
 *
 * Results must be sorted ascending and free of duplicates; the caller owns that.
 */
export function computeCoverageIntervals(
  observedAt: readonly number[],
  gapMax: number,
): Interval[] {
  const intervals: Interval[] = [];
  for (let i = 0; i + 1 < observedAt.length; i += 1) {
    const start = observedAt[i];
    const end = observedAt[i + 1];
    if (start === undefined || end === undefined) continue;
    if (end - start > gapMax) continue;
    if (end <= start) continue;
    const previous = intervals[intervals.length - 1];
    // Adjacent qualifying pairs share an endpoint, so they merge into one run.
    if (previous !== undefined && previous.end === start) {
      previous.end = end;
    } else {
      intervals.push({ start, end });
    }
  }
  return intervals;
}

/** `max(2 x interval, 120)`, the default freshness and coverage thresholds. */
export function defaultCoverageGapMax(intervalSeconds: number): number {
  return Math.max(2 * intervalSeconds, 120);
}

interface EffectiveInterval extends Interval {
  severity: FaultSeverity;
  weight: number;
  source: ImpactSource;
}

function clip(interval: Interval, start: number, end: number): Interval | null {
  const s = Math.max(interval.start, start);
  const e = Math.min(interval.end, end);
  return e > s ? { start: s, end: e } : null;
}

/** Intersect two half-open intervals, or null when they do not overlap. */
function intersect(a: Interval, b: Interval): Interval | null {
  return clip({ start: a.start, end: a.end }, b.start, b.end);
}

/**
 * The window the sweep actually evaluates.
 *
 * Clipped to the component's lifetime and to `now`, so a future window yields a
 * zero-length span (and therefore `null`) rather than a fabricated 100%.
 */
function evaluateSpan(input: UptimeInput): { start: number; end: number } | null {
  const start = Math.max(input.windowStart, input.availableSince);
  const end = Math.min(input.windowEnd, Math.max(input.now, start));
  return end > start ? { start, end } : null;
}

/**
 * Expand impacts into non-overlapping-weight intervals.
 *
 * Probe-sourced impacts are split against the coverage intervals, so only the
 * monitored part of the fault survives. Manual impacts pass through whole.
 */
function effectiveIntervals(
  impacts: readonly UptimeImpact[],
  coverage: readonly Interval[],
  start: number,
  end: number,
  now: number,
  weights: Readonly<Record<FaultSeverity, number>>,
): EffectiveInterval[] {
  const out: EffectiveInterval[] = [];

  for (const impact of impacts) {
    const rawEnd = impact.endAt === null ? now : impact.endAt;
    const base = clip({ start: impact.startAt, end: rawEnd }, start, end);
    if (base === null) continue;

    const weight = weights[impact.severity];
    const severity = impact.severity;

    if (impact.source === "manual") {
      out.push({ ...base, severity, weight, source: "manual" });
      continue;
    }

    for (const covered of coverage) {
      const piece = intersect(base, covered);
      if (piece === null) continue;
      out.push({ ...piece, severity, weight, source: "probe" });
    }
  }

  return out;
}

function covers(interval: Interval, start: number, end: number): boolean {
  return interval.start <= start && interval.end >= end;
}

/**
 * Sweep the window and account for every second exactly once.
 *
 * Segments are cut at every boundary of every interval involved, so within a
 * segment each interval either covers it entirely or not at all. That is what
 * makes the per-segment `max weight` exact rather than approximate.
 */
export function computeUptime(input: UptimeInput): UptimeResult {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const span = evaluateSpan(input);
  const partial = input.windowEnd > input.now;

  if (span === null) {
    return {
      uptime: null,
      coveredSeconds: 0,
      unknownSeconds: 0,
      excludedSeconds: 0,
      weightedDowntimeSeconds: 0,
      ongoing: false,
      partial,
      worstStatus: "unknown",
      segments: [],
    };
  }

  const { start, end } = span;

  const faults = effectiveIntervals(
    input.impacts,
    input.coverage,
    start,
    end,
    input.now,
    weights,
  );

  const maintenances: Interval[] = [];
  for (const window of input.maintenances) {
    const rawEnd = window.endAt === null ? input.now : window.endAt;
    const clipped = clip({ start: window.startAt, end: rawEnd }, start, end);
    if (clipped !== null) maintenances.push(clipped);
  }

  const coverage: Interval[] = [];
  for (const interval of input.coverage) {
    const clipped = clip(interval, start, end);
    if (clipped !== null) coverage.push(clipped);
  }

  const ongoing = input.impacts.some(
    (impact) => impact.endAt === null && impact.startAt <= input.now,
  );

  // Every boundary, deduplicated and ordered. Nothing else can change inside a
  // segment, so the segment list is the complete partition of the window.
  const boundaries = new Set<number>([start, end]);
  for (const list of [faults, maintenances, coverage]) {
    for (const interval of list) {
      boundaries.add(interval.start);
      boundaries.add(interval.end);
    }
  }
  const cuts = [...boundaries]
    .filter((value) => value >= start && value <= end)
    .sort((a, b) => a - b);

  let coveredSeconds = 0;
  let unknownSeconds = 0;
  let excludedSeconds = 0;
  let weightedDowntimeSeconds = 0;
  const severitiesPresent = new Set<FaultSeverity>();
  const segments: UptimeSegment[] = [];

  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (a === undefined || b === undefined || b <= a) continue;

    let weight = 0;
    let severity: FaultSeverity | null = null;
    for (const fault of faults) {
      if (!covers(fault, a, b)) continue;
      if (fault.weight > weight) {
        weight = fault.weight;
        severity = fault.severity;
      } else if (fault.weight === weight && severity !== null && fault.severity !== severity) {
        // Equal weights for different severities would make the tie-break
        // arbitrary, so fall back to the documented severity ranking.
        severity = FAULT_RANK[fault.severity] > FAULT_RANK[severity] ? fault.severity : severity;
      }
    }

    const isMaintenance = maintenances.some((window) => covers(window, a, b));
    const hasCoverage = coverage.some((interval) => covers(interval, a, b));
    const hasManualFault = faults.some((fault) => fault.source === "manual" && covers(fault, a, b));
    const delta = b - a;

    // A fault outranks a maintenance declaration: an outage that happens to fall
    // inside an announced window is still an outage, and hiding it would let a
    // convenient maintenance window launder real downtime out of the record.
    if (isMaintenance && weight === 0) {
      excludedSeconds += delta;
      segments.push({ start: a, end: b, weight, severity, hasCoverage, isMaintenance, counted: "excluded" });
      continue;
    }

    if (hasCoverage || hasManualFault) {
      coveredSeconds += delta;
      weightedDowntimeSeconds += delta * weight;
      if (weight > 0 && severity !== null) severitiesPresent.add(severity);
      segments.push({ start: a, end: b, weight, severity, hasCoverage, isMaintenance, counted: "covered" });
      continue;
    }

    unknownSeconds += delta;
    segments.push({ start: a, end: b, weight, severity, hasCoverage, isMaintenance, counted: "unknown" });
  }

  let worstStatus: Status;
  if (severitiesPresent.size > 0) {
    worstStatus = [...severitiesPresent].reduce((worst, next) =>
      FAULT_RANK[next] > FAULT_RANK[worst] ? next : worst,
    );
  } else if (coveredSeconds === 0) {
    worstStatus = excludedSeconds > 0 ? "maintenance" : "unknown";
  } else if (unknownSeconds > coveredSeconds) {
    worstStatus = "unknown";
  } else if (excludedSeconds > 0) {
    worstStatus = "maintenance";
  } else {
    worstStatus = "operational";
  }

  const uptime =
    coveredSeconds > 0
      ? clamp01(1 - weightedDowntimeSeconds / coveredSeconds)
      : null;

  return {
    uptime,
    coveredSeconds,
    unknownSeconds,
    excludedSeconds,
    weightedDowntimeSeconds,
    ongoing,
    partial,
    worstStatus,
    segments,
  };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Fold several components' results into one, for a section or a page.
 *
 * Deliberately *not* an average of percentages. Averaging lets one unmeasured
 * component dilute a real outage, and lets a component with one second of
 * coverage weigh as much as one with a full day. Instead the raw seconds are
 * summed and the ratio taken once at the end, so every second of evidence counts
 * exactly once regardless of which component produced it.
 *
 * `null` when no component contributed measurable time.
 */
export function aggregateUptime(results: readonly UptimeResult[]): number | null {
  let covered = 0;
  let downtime = 0;
  for (const result of results) {
    covered += result.coveredSeconds;
    downtime += result.weightedDowntimeSeconds;
  }
  return covered > 0 ? clamp01(1 - downtime / covered) : null;
}

/** `YYYY-MM-DD` for an epoch-second timestamp, in UTC. */
export function utcDay(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/** Start of the UTC day containing `timestamp`, in epoch seconds. */
export function startOfUtcDay(timestamp: number): number {
  return Math.floor(timestamp / 86400) * 86400;
}
