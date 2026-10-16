/**
 * The snapshot contract: what the API Worker publishes and the status page reads.
 *
 * This type lives in `packages/shared` rather than in either Worker because it is
 * the interface *between* them. Defining it twice — once where it is produced and
 * once where it is consumed — is how the two silently drift apart, and a drift
 * here shows up as a status page that renders a field nobody writes.
 *
 * ## Why the snapshot carries evidence, not verdicts
 *
 * The obvious design stores each component's computed `status` in the snapshot.
 * It is wrong, and the reason is time: status depends on `now`. A maintenance
 * window that ends at 03:00, or an impact whose interval closes, changes the
 * correct status without any write occurring. A stored status therefore goes
 * stale in a way the snapshot version cannot detect, because no version bump
 * accompanies the passage of time.
 *
 * So the snapshot carries the *evidence* — impact intervals, maintenance
 * windows, the latest probe result and its freshness budget — and the reader
 * derives the status from it with the pure functions in `status.ts`. Derivation
 * is cheap, deterministic, and always evaluated at the reader's clock.
 *
 * The one thing that *is* precomputed is the daily uptime history, because that
 * is an aggregate over thousands of probe results and cannot be recomputed per
 * page view. It is materialised into `daily_uptime` by the API Worker.
 */

import { deriveComponentStatus } from "./status";
import { clamp01 } from "./uptime";
import type {
  Derivation,
  ImpactWindow,
  MaintenanceWindow,
  MonitoringEvidence,
  Status,
} from "./status";

export type ChangeKind = "incident" | "maintenance";

export type ChangeStatus =
  | "scheduled"
  | "in_progress"
  | "verifying"
  | "resolved"
  | "completed";

/** Severity of a change as a whole, for the timeline. */
export type ChangeSeverity =
  | "none"
  | "degraded_performance"
  | "partial_outage"
  | "full_outage";

export interface SnapshotDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /**
   * `null` when the day had no measurable time. Kept distinct from 1 so that a
   * day nobody measured cannot read as a perfect day.
   */
  uptime: number | null;
  status: Status;
  coveredSeconds: number;
  unknownSeconds: number;
}

export interface SnapshotProbe {
  targetPublicId: string;
  lastProbeAt: number;
  ok: boolean;
}

export interface SnapshotComponent {
  publicId: string;
  name: string;
  description: string | null;
  sectionPublicId: string | null;
  orderId: number;
  availableSince: number;
  /** `null` means no enabled probe target: an uncovered component. */
  probe: SnapshotProbe | null;
  /** How old `probe.lastProbeAt` may be and still count as evidence. */
  statusFreshnessMax: number;
  /**
   * Impact intervals whose window could still contain the reader's `now`. An
   * interval that had already closed before the snapshot was built is omitted,
   * because it can only be inactive at a later read time too.
   */
  impacts: ImpactWindow[];
  /** Maintenance windows that could still apply, including `scheduled` ones. */
  maintenances: MaintenanceWindow[];
  /** Public ids of the changes currently contributing to this component. */
  changePublicIds: string[];
  /** Daily history, oldest first. Bounded by the retention horizon. */
  days: SnapshotDay[];
}

export interface SnapshotSection {
  publicId: string;
  name: string;
  description: string | null;
  orderId: number;
  componentPublicIds: string[];
}

export interface SnapshotChangeUpdate {
  publicId: string;
  status: ChangeStatus;
  body: string;
  createdAt: number;
  /** Components whose status this particular update overrides. */
  componentPublicIds: string[];
}

export interface SnapshotChange {
  publicId: string;
  kind: ChangeKind;
  status: ChangeStatus;
  title: string;
  body: string | null;
  severity: ChangeSeverity;
  startsAt: number;
  endsAt: number | null;
  scheduledStartAt: number | null;
  scheduledEndAt: number | null;
  componentPublicIds: string[];
  updates: SnapshotChangeUpdate[];
}

export interface Snapshot {
  slug: string;
  name: string;
  /** Bumped by every write that changes public output. */
  snapshotVersion: number;
  /** When this document was assembled. */
  generatedAt: number;
  /** When the underlying page row last changed. */
  sourceUpdatedAt: number;
  sections: SnapshotSection[];
  components: SnapshotComponent[];
  /** Active changes plus recently resolved ones, newest first. */
  changes: SnapshotChange[];
}

/**
 * Which step of the read chain produced the data.
 *
 * `cache` is the colo-local copy written by the same call that writes KV. It is
 * only reached when KV has missed, and it is reported as its own value rather
 * than folded into `kv-fresh` because it is a different claim: KV is the
 * authority for every reader, whereas this copy is known only to the data centre
 * that wrote it. See docs/spec/snapshot.md.
 */
export type SnapshotSource = "kv-fresh" | "cache" | "d1-rebuild" | "kv-last" | "none";

export interface ReadResult {
  snapshot: Snapshot | null;
  source: SnapshotSource;
  /**
   * `true` when the read chain could not confirm the data is current — it was
   * served from the last-known-good key because D1 was unreachable, or there was
   * nothing to serve at all.
   *
   * Note what this deliberately does *not* mean. It is not "the document is old":
   * a page whose content has not changed in an hour is perfectly current, and
   * flagging it would make the indicator permanently lit and therefore ignored.
   * Age is reported separately as `ageSeconds`, because the two are different
   * facts and a single flag cannot express both. See docs/spec/snapshot.md.
   */
  stale: boolean;
  /** Age of the document in seconds, or null when there is no document. */
  ageSeconds: number | null;
  /** Whether `ageSeconds` exceeds the configured warning threshold. */
  aged: boolean;
  errors: string[];
}

/** Snapshot older than this is reported as `aged`, though not as `stale`. */
export const DEFAULT_AGE_WARNING_SECONDS = 300;

export const freshKey = (slug: string): string => `snapshot:${slug}`;
export const lastKey = (slug: string): string => `snapshot:${slug}:last`;

/** Derive one component's status from the evidence the snapshot carries. */
export function deriveSnapshotComponent(
  component: SnapshotComponent,
  now: number,
): Derivation {
  const monitoring: MonitoringEvidence =
    component.probe === null
      ? { kind: "uncovered" }
      : { kind: "probe", lastProbeAt: component.probe.lastProbeAt, ok: component.probe.ok };

  return deriveComponentStatusFromEvidence(
    component.impacts,
    component.maintenances,
    monitoring,
    component.statusFreshnessMax,
    now,
  );
}

/**
 * `deriveComponentStatus` with the arguments unpacked from the snapshot shape.
 *
 * It exists so the reader has exactly one call to make and cannot accidentally
 * pass the wrong freshness budget — the snapshot stores it per component, since
 * it depends on that component's probe interval.
 */
export function deriveComponentStatusFromEvidence(
  impacts: readonly ImpactWindow[],
  maintenances: readonly MaintenanceWindow[],
  monitoring: MonitoringEvidence,
  statusFreshnessMax: number,
  now: number,
): Derivation {
  return deriveComponentStatus(
    { events: { impacts, maintenances }, monitoring, statusFreshnessMax },
    now,
  );
}

/**
 * Fold a component's daily history into one uptime figure for its calendar.
 *
 * This is `aggregateUptime`'s rule — sum the raw seconds and take the ratio once
 * at the end — applied to the *stored* daily rows rather than to freshly computed
 * results. The two must agree, or the number printed above a 90-day bar chart
 * would disagree with the bars underneath it.
 *
 * The conversion back to seconds is exact because `uptime` is defined as
 * `1 - weightedDowntimeSeconds / coveredSeconds`: multiplying the shortfall by the
 * day's covered seconds recovers the weighted downtime the day was computed from.
 * A day with `uptime === null` is skipped rather than treated as 100% — that is the
 * whole point of the nullable field, and averaging in a fabricated 1.0 would let an
 * unmeasured day improve the record.
 *
 * `null` when no day contributed measurable time.
 */
export function aggregateDayUptime(days: readonly SnapshotDay[]): number | null {
  let covered = 0;
  let downtime = 0;
  for (const day of days) {
    if (day.uptime === null || day.coveredSeconds <= 0) continue;
    covered += day.coveredSeconds;
    downtime += (1 - day.uptime) * day.coveredSeconds;
  }
  return covered > 0 ? clamp01(1 - downtime / covered) : null;
}
