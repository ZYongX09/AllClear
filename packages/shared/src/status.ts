/**
 * Two-stage component status derivation.
 *
 * Stage one reads **events** — impacts recorded against incidents, and declared
 * maintenance windows. Stage two reads **monitoring evidence** — whether a probe
 * covers this component and how old its most recent result is. The two stages
 * are deliberately not merged into one ranking, because they answer different
 * questions and one of them can be silent.
 *
 * The failure this shape exists to prevent is "absence of evidence reported as
 * uptime". A component with no probe target, or whose probe stopped reporting,
 * must come out `unknown` — never `operational`. A naive implementation that
 * starts from `operational` and lets faults demote it gets this backwards, which
 * is why stage two is written as an explicit decision over evidence rather than
 * as a default with exceptions.
 *
 * A second property worth stating, because it is easy to lose: resolving one
 * incident must not clear a component that another incident is still affecting.
 * That falls out of deriving the status from the set of *currently active*
 * impact intervals rather than from a stored per-component status field, so
 * closing impact A simply removes A from the set.
 */

/** The severities an impact can carry. These map to the public status names. */
export type FaultSeverity = "degraded_performance" | "partial_outage" | "full_outage";

export type Status = FaultSeverity | "operational" | "maintenance" | "unknown";

/**
 * Ranking used *only* to pick the worst of several concurrently active faults.
 *
 * Note what is absent: `unknown`, `operational` and `maintenance` have no rank.
 * `unknown` is not a low-severity fault, it is the absence of a verdict, and the
 * derivation never resolves it by comparing numbers. Ranking it alongside faults
 * is the specific mistake that lets "we have no idea" lose to "looks fine".
 */
export const FAULT_RANK: Readonly<Record<FaultSeverity, number>> = {
  degraded_performance: 1,
  partial_outage: 2,
  full_outage: 3,
};

export function isFaultSeverity(value: unknown): value is FaultSeverity {
  return value === "degraded_performance" || value === "partial_outage" || value === "full_outage";
}

/** Returns whichever of the two severities is worse. Ties return `a`. */
export function worstFault(a: FaultSeverity, b: FaultSeverity): FaultSeverity {
  return FAULT_RANK[a] >= FAULT_RANK[b] ? a : b;
}

/**
 * One component's interval of degradation, as recorded in the `impact` table.
 *
 * `startsAt` is the probe's `first_failed_at` and `endsAt` its
 * `first_recovery_success_at` for automated impacts, which means both ends are
 * *estimates* sampled at the probe interval — not the true fault boundaries.
 * The derivation treats them as the best available evidence, not as ground
 * truth; see docs/spec/probe.md.
 */
export interface ImpactWindow {
  severity: FaultSeverity;
  /** Epoch seconds. */
  startsAt: number;
  /** Epoch seconds, or null while the impact is still open. */
  endsAt: number | null;
}

export type MaintenanceStatus = "scheduled" | "in_progress" | "completed";

/** A maintenance window, already scoped to the component being derived. */
export interface MaintenanceWindow {
  status: MaintenanceStatus;
  startsAt: number;
  /** Epoch seconds, or null for an open-ended window. */
  endsAt: number | null;
}

export interface EventEvidence {
  impacts: readonly ImpactWindow[];
  maintenances: readonly MaintenanceWindow[];
}

/**
 * What the monitoring layer can say about a component.
 *
 * `uncovered` means no enabled probe target exists at all, which is a
 * configuration state and not a measurement. `probe` carries the most recent
 * result; whether it is fresh enough to count is decided by the caller-supplied
 * `statusFreshnessMax`, because the right threshold depends on the probe
 * interval and is not a property of the evidence itself.
 */
export type MonitoringEvidence =
  | { readonly kind: "uncovered" }
  | { readonly kind: "probe"; readonly lastProbeAt: number; readonly ok: boolean };

/**
 * Why a status came out the way it did. Callers use this for logs, for the
 * admin UI, and for tests; `unknown` in particular is useless to an operator
 * without it, since three unrelated situations all produce it.
 */
export type DerivationReason =
  | "active_fault"
  | "active_maintenance"
  | "monitoring_ok"
  | "monitoring_stale"
  | "monitoring_uncovered"
  | "monitoring_failing_unclassified";

export interface Derivation {
  status: Status;
  reason: DerivationReason;
}

export interface DeriveInput {
  events: EventEvidence;
  monitoring: MonitoringEvidence;
  /**
   * How old (seconds) the most recent probe result may be and still count as
   * evidence. Beyond this the component is `unknown`, not `operational`.
   */
  statusFreshnessMax: number;
}

/** Whether an impact interval covers `now`. Half-open: `[startsAt, endsAt)`. */
export function isImpactActive(impact: ImpactWindow, now: number): boolean {
  return impact.startsAt <= now && (impact.endsAt === null || now < impact.endsAt);
}

/**
 * Stage one: the status implied by events alone, or null if events say nothing.
 *
 * Maintenance is handled from the *change* window and status rather than from
 * an impact, and the `scheduled` status contributes nothing at all. That is
 * load-bearing: a maintenance window announced for next week must not paint the
 * component as under maintenance today. Only `in_progress` counts, and only
 * inside its own window.
 */
export function deriveEventStatus(
  evidence: EventEvidence,
  now: number,
): FaultSeverity | "maintenance" | null {
  let worst: FaultSeverity | null = null;
  for (const impact of evidence.impacts) {
    if (!isImpactActive(impact, now)) continue;
    worst = worst === null ? impact.severity : worstFault(worst, impact.severity);
  }
  if (worst !== null) return worst;

  for (const maintenance of evidence.maintenances) {
    if (maintenance.status !== "in_progress") continue;
    if (maintenance.startsAt > now) continue;
    if (maintenance.endsAt !== null && now >= maintenance.endsAt) continue;
    return "maintenance";
  }

  return null;
}

/**
 * Stage two: decide between `operational` and `unknown` when events are silent.
 *
 * The case that is easy to overlook is a probe that is fresh *and failing* while
 * no impact exists. That is not a normal state: opening an impact and advancing
 * `probe_state` happen in one D1 batch, so a failing probe with no impact means
 * either the batch half-applied or a probe target was reconfigured underneath a
 * recorded fault. Reporting a fault severity here would invent a classification
 * the data does not contain, and reporting `operational` would be a lie, so it
 * is reported as `unknown` under its own reason — visible to operators instead
 * of silently rounded to one of the two plausible answers.
 */
export function deriveComponentStatus(input: DeriveInput, now: number): Derivation {
  const event = deriveEventStatus(input.events, now);
  if (event !== null) {
    return {
      status: event,
      reason: event === "maintenance" ? "active_maintenance" : "active_fault",
    };
  }

  const monitoring = input.monitoring;
  if (monitoring.kind === "uncovered") {
    return { status: "unknown", reason: "monitoring_uncovered" };
  }
  if (now - monitoring.lastProbeAt > input.statusFreshnessMax) {
    return { status: "unknown", reason: "monitoring_stale" };
  }
  if (!monitoring.ok) {
    return { status: "unknown", reason: "monitoring_failing_unclassified" };
  }
  return { status: "operational", reason: "monitoring_ok" };
}

/** Convenience wrapper returning only the status. */
export function deriveStatus(input: DeriveInput, now: number): Status {
  return deriveComponentStatus(input, now).status;
}

/**
 * Roll a set of component statuses up into one for a section or page.
 *
 * Aggregation is deliberately *not* a severity ranking over every status. It is
 * a priority order that puts `unknown` above the benign states, for the same
 * reason stage two does: a group containing a component nobody can measure is
 * not a healthy group, and must not be reported as one merely because the
 * measurable members are fine.
 */
export function aggregateStatus(statuses: readonly Status[]): Status {
  if (statuses.length === 0) return "unknown";

  let worstFaultStatus: FaultSeverity | null = null;
  let sawMaintenance = false;
  let sawUnknown = false;
  let sawOperational = false;

  for (const status of statuses) {
    if (isFaultSeverity(status)) {
      worstFaultStatus =
        worstFaultStatus === null ? status : worstFault(worstFaultStatus, status);
    } else if (status === "maintenance") {
      sawMaintenance = true;
    } else if (status === "unknown") {
      sawUnknown = true;
    } else {
      sawOperational = true;
    }
  }

  if (worstFaultStatus !== null) return worstFaultStatus;
  if (sawUnknown) return "unknown";
  if (sawMaintenance) return "maintenance";
  return sawOperational ? "operational" : "unknown";
}
