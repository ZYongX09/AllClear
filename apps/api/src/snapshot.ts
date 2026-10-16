/**
 * Snapshot construction and the public read chain.
 *
 * ## The read chain
 *
 * The ordering is written out here rather than left implicit, because "which
 * source answered" is the single most useful thing to know when a status page
 * looks wrong:
 *
 *   1. KV fresh   — the normal path. Does not touch D1 at all.
 *   2. D1 rebuild — reached on a KV miss (cold cache, evicted key). Rebuilds the
 *                   snapshot and repopulates KV and the colo-local copy.
 *   3. KV last    — reached only when D1 is also unavailable. Serves the last
 *                   known good snapshot.
 *   4. cache      — reached when KV itself could not answer, which is the one
 *                   failure `:last` cannot cover because `:last` is also in KV.
 *                   See `cache.ts`.
 *   5. none       — nothing to serve. The caller must render an explicit
 *                   "unavailable" state rather than an empty-but-plausible page.
 *
 * ## `stale` means "unconfirmed", not "old"
 *
 * M0 surfaced this as an open question and M2 settles it here. The original
 * implementation derived `stale` from the *document's* age, which made the flag
 * permanently true for any page whose content had not changed in five minutes —
 * a status page for a stable service would light up its own warning indicator
 * forever, and an indicator that is always on is an indicator nobody reads.
 *
 * So the two facts are now reported separately:
 *
 *   * `stale` — the read chain could not *confirm* the data is current, because
 *     it fell back to the last-known-good key or had nothing to serve. This is a
 *     statement about the read path.
 *   * `ageSeconds` / `aged` — how old the document is. This is a statement about
 *     the document.
 *
 * Both are true at different times, and collapsing them into one boolean forces
 * a choice between a flag that lies and a flag that never turns off.
 *
 * ## The snapshot carries evidence, not verdicts
 *
 * No component status is stored. Status depends on `now`: a maintenance window
 * ending, or an impact interval closing, changes the correct answer without any
 * write happening — so a stored status goes stale in a way no version bump can
 * detect. The snapshot carries the intervals and the latest probe result, and
 * the reader derives the status at its own clock. See `packages/shared/src/snapshot.ts`.
 */

import {
  DEFAULT_AGE_WARNING_SECONDS,
  defaultCoverageGapMax,
  freshKey,
  lastKey,
  utcDay,
  type ChangeKind,
  type ChangeSeverity,
  type ChangeStatus,
  type FaultSeverity,
  type ImpactWindow,
  type MaintenanceWindow,
  type ReadResult,
  type Snapshot,
  type SnapshotChange,
  type SnapshotChangeUpdate,
  type SnapshotComponent,
  type SnapshotDay,
  type SnapshotProbe,
  type SnapshotSection,
  type SnapshotSource,
  type Status,
} from "@allclear/shared";

import { readSnapshotFromCache, writeSnapshotToCache } from "./cache";

export { freshKey, lastKey } from "@allclear/shared";
export type { ReadResult, Snapshot } from "@allclear/shared";

/** How much change history the snapshot carries, in seconds. */
export const CHANGE_HISTORY_SECONDS = 30 * 86_400;
/** How many daily history rows per component the snapshot carries. */
export const HISTORY_DAYS = 90;
/** Upper bound on changes embedded in one snapshot. */
export const MAX_CHANGES = 50;

interface PageRow {
  id: number;
  slug: string;
  name: string;
  snapshot_version: number;
  updated_at: number;
}

interface SectionRow {
  id: number;
  public_id: string;
  name: string;
  description: string | null;
  order_id: number;
}

interface ComponentRow {
  id: number;
  public_id: string;
  name: string;
  description: string | null;
  section_id: number | null;
  order_id: number;
  available_since: number;
}

interface ProbeRow {
  target_public_id: string;
  component_id: number;
  interval_seconds: number;
  last_probe_at: number | null;
  last_ok: number | null;
}

interface ImpactRow {
  component_id: number;
  severity: string;
  start_at: number;
  end_at: number | null;
}

interface ChangeRow {
  id: number;
  public_id: string;
  kind: ChangeKind;
  status: ChangeStatus;
  title: string;
  body: string | null;
  severity: ChangeSeverity;
  starts_at: number;
  ends_at: number | null;
  scheduled_start_at: number | null;
  scheduled_end_at: number | null;
}

interface ChangeComponentRow {
  change_id: number;
  component_id: number;
}

interface ChangeUpdateRow {
  id: number;
  public_id: string;
  change_id: number;
  status: ChangeStatus;
  body: string;
  created_at: number;
}

interface ChangeUpdateComponentRow {
  change_update_id: number;
  component_id: number;
}

interface DailyUptimeRow {
  component_id: number;
  day: string;
  uptime: number | null;
  worst_status: string;
  covered_seconds: number;
  unknown_seconds: number;
}

const FAULT_SEVERITIES: readonly FaultSeverity[] = [
  "degraded_performance",
  "partial_outage",
  "full_outage",
];

function isFaultSeverity(value: string): value is FaultSeverity {
  return (FAULT_SEVERITIES as readonly string[]).includes(value);
}

/** Assemble a snapshot from D1. Throws if the page does not exist. */
export async function buildSnapshot(
  db: D1Database,
  slug: string,
  options: { now?: number } = {},
): Promise<Snapshot> {
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const page = await db
    .prepare("SELECT id, slug, name, snapshot_version, updated_at FROM page WHERE slug = ?1")
    .bind(slug)
    .first<PageRow>();

  if (!page) throw new Error(`no page with slug ${slug}`);

  const historyFloor = utcDay(now - (HISTORY_DAYS - 1) * 86_400);
  const changeFloor = now - CHANGE_HISTORY_SECONDS;

  // One round trip for everything that depends only on the page id. Reads in a
  // `batch` run as a transaction, which is what makes the assembled document
  // internally consistent: no write can land between the components query and
  // the impacts query and produce a snapshot describing a state that never
  // existed.
  const [
    sectionsResult,
    componentsResult,
    probesResult,
    impactsResult,
    changesResult,
    changeComponentsResult,
    updatesResult,
    updateComponentsResult,
    dailyResult,
  ] = await db.batch([
    db
      .prepare(
        "SELECT id, public_id, name, description, order_id FROM section WHERE page_id = ?1 ORDER BY order_id, id",
      )
      .bind(page.id),
    db
      .prepare(
        `SELECT id, public_id, name, description, section_id, order_id, available_since
           FROM component WHERE page_id = ?1 ORDER BY order_id, id`,
      )
      .bind(page.id),
    db
      .prepare(
        `SELECT t.public_id AS target_public_id, t.component_id, t.interval_seconds,
                s.last_probe_at,
                (SELECT r.ok FROM probe_result r
                  WHERE r.probe_target_id = t.id
                  ORDER BY r.observed_at DESC, r.id DESC LIMIT 1) AS last_ok
           FROM probe_target t
           JOIN component c ON c.id = t.component_id
           LEFT JOIN probe_state s ON s.probe_target_id = t.id
          WHERE c.page_id = ?1 AND t.enabled = 1`,
      )
      .bind(page.id),
    // Only impacts that could still be active at a *later* read time. One that
    // had already closed before this build can only be inactive afterwards too.
    db
      .prepare(
        `SELECT i.component_id, i.severity, i.start_at, i.end_at
           FROM impact i
           JOIN component c ON c.id = i.component_id
          WHERE c.page_id = ?1 AND (i.end_at IS NULL OR i.end_at >= ?2)`,
      )
      .bind(page.id, now),
    db
      .prepare(
        `SELECT id, public_id, kind, status, title, body, severity,
                starts_at, ends_at, scheduled_start_at, scheduled_end_at
           FROM change
          WHERE page_id = ?1 AND (ends_at IS NULL OR ends_at >= ?2)
          ORDER BY starts_at DESC, id DESC
          LIMIT ?3`,
      )
      .bind(page.id, changeFloor, MAX_CHANGES),
    db
      .prepare(
        `SELECT cc.change_id, cc.component_id
           FROM change_component cc
           JOIN change ch ON ch.id = cc.change_id
          WHERE ch.page_id = ?1`,
      )
      .bind(page.id),
    db
      .prepare(
        `SELECT u.id, u.public_id, u.change_id, u.status, u.body, u.created_at
           FROM change_update u
           JOIN change ch ON ch.id = u.change_id
          WHERE ch.page_id = ?1
          ORDER BY u.created_at, u.id`,
      )
      .bind(page.id),
    db
      .prepare(
        `SELECT uc.change_update_id, uc.component_id
           FROM change_update_component uc
           JOIN change_update u ON u.id = uc.change_update_id
           JOIN change ch ON ch.id = u.change_id
          WHERE ch.page_id = ?1`,
      )
      .bind(page.id),
    db
      .prepare(
        `SELECT u.component_id, u.day, u.uptime, u.worst_status,
                u.covered_seconds, u.unknown_seconds
           FROM daily_uptime u
           JOIN component c ON c.id = u.component_id
          WHERE c.page_id = ?1 AND u.day >= ?2
          ORDER BY u.day`,
      )
      .bind(page.id, historyFloor),
  ]);

  const sections = sectionsResult.results as unknown as SectionRow[];
  const components = componentsResult.results as unknown as ComponentRow[];
  const probes = probesResult.results as unknown as ProbeRow[];
  const impacts = impactsResult.results as unknown as ImpactRow[];
  const changes = changesResult.results as unknown as ChangeRow[];
  const changeComponents = changeComponentsResult.results as unknown as ChangeComponentRow[];
  const updates = updatesResult.results as unknown as ChangeUpdateRow[];
  const updateComponents = updateComponentsResult.results as unknown as ChangeUpdateComponentRow[];
  const daily = dailyResult.results as unknown as DailyUptimeRow[];

  const sectionPublicIdByInternal = new Map(sections.map((s) => [s.id, s.public_id]));
  const componentPublicIdByInternal = new Map(components.map((c) => [c.id, c.public_id]));

  // --- impacts, split into faults and maintenance -------------------------
  //
  // `impact.severity` permits 'maintenance' for hand-entered windows. The
  // derivation takes maintenance from the change table, so a maintenance-severity
  // impact is routed there rather than being silently dropped — dropping it would
  // make the component look uncovered during an announced window.
  const impactsByComponent = new Map<number, ImpactWindow[]>();
  const maintenanceByComponent = new Map<number, MaintenanceWindow[]>();

  for (const row of impacts) {
    if (row.severity === "maintenance") {
      const list = maintenanceByComponent.get(row.component_id) ?? [];
      list.push({ status: "in_progress", startsAt: row.start_at, endsAt: row.end_at });
      maintenanceByComponent.set(row.component_id, list);
      continue;
    }
    if (!isFaultSeverity(row.severity)) continue;
    const list = impactsByComponent.get(row.component_id) ?? [];
    list.push({ severity: row.severity, startsAt: row.start_at, endsAt: row.end_at });
    impactsByComponent.set(row.component_id, list);
  }

  // --- changes ------------------------------------------------------------
  const componentIdsByChange = new Map<number, number[]>();
  for (const link of changeComponents) {
    const list = componentIdsByChange.get(link.change_id) ?? [];
    list.push(link.component_id);
    componentIdsByChange.set(link.change_id, list);
  }

  const componentIdsByUpdate = new Map<number, number[]>();
  for (const link of updateComponents) {
    const list = componentIdsByUpdate.get(link.change_update_id) ?? [];
    list.push(link.component_id);
    componentIdsByUpdate.set(link.change_update_id, list);
  }

  const updatesByChange = new Map<number, SnapshotChangeUpdate[]>();
  for (const row of updates) {
    const list = updatesByChange.get(row.change_id) ?? [];
    list.push({
      publicId: row.public_id,
      status: row.status,
      body: row.body,
      createdAt: row.created_at,
      componentPublicIds: (componentIdsByUpdate.get(row.id) ?? [])
        .map((id) => componentPublicIdByInternal.get(id))
        .filter((value): value is string => value !== undefined),
    });
    updatesByChange.set(row.change_id, list);
  }

  const snapshotChanges: SnapshotChange[] = [];
  for (const row of changes) {
    const linkedIds = componentIdsByChange.get(row.id) ?? [];
    const linkedPublicIds = linkedIds
      .map((id) => componentPublicIdByInternal.get(id))
      .filter((value): value is string => value !== undefined);

    snapshotChanges.push({
      publicId: row.public_id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      body: row.body,
      severity: row.severity,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
      componentPublicIds: linkedPublicIds,
      updates: updatesByChange.get(row.id) ?? [],
    });

    // A maintenance window contributes to its components' derived status. Only
    // `in_progress` counts — the derivation checks that — but `scheduled` is
    // carried too so the page can announce upcoming work.
    if (row.kind === "maintenance" && row.status !== "completed") {
      for (const componentId of linkedIds) {
        const list = maintenanceByComponent.get(componentId) ?? [];
        list.push({
          status: row.status === "in_progress" ? "in_progress" : "scheduled",
          startsAt: row.starts_at,
          endsAt: row.ends_at,
        });
        maintenanceByComponent.set(componentId, list);
      }
    }
  }

  // --- per-component change links, for the UI -----------------------------
  const activeChangePublicIds = new Map<number, string[]>();
  for (const row of changes) {
    if (row.status === "resolved" || row.status === "completed") continue;
    for (const componentId of componentIdsByChange.get(row.id) ?? []) {
      const list = activeChangePublicIds.get(componentId) ?? [];
      list.push(row.public_id);
      activeChangePublicIds.set(componentId, list);
    }
  }

  // --- daily history ------------------------------------------------------
  const daysByComponent = new Map<number, SnapshotDay[]>();
  for (const row of daily) {
    const list = daysByComponent.get(row.component_id) ?? [];
    list.push({
      day: row.day,
      uptime: row.uptime,
      status: row.worst_status as Status,
      coveredSeconds: row.covered_seconds,
      unknownSeconds: row.unknown_seconds,
    });
    daysByComponent.set(row.component_id, list);
  }

  const probeByComponent = new Map<number, ProbeRow>();
  for (const row of probes) probeByComponent.set(row.component_id, row);

  const snapshotComponents: SnapshotComponent[] = components.map((row) => {
    const probeRow = probeByComponent.get(row.id);
    let probe: SnapshotProbe | null = null;
    let statusFreshnessMax = defaultCoverageGapMax(60);

    if (probeRow) {
      statusFreshnessMax = defaultCoverageGapMax(probeRow.interval_seconds);
      // A target with no recorded observation yet is *not* evidence of health.
      // Reporting it as an uncovered component keeps the derivation from
      // treating "we have never probed this" as a fresh success.
      if (probeRow.last_probe_at !== null && probeRow.last_ok !== null) {
        probe = {
          targetPublicId: probeRow.target_public_id,
          lastProbeAt: probeRow.last_probe_at,
          ok: probeRow.last_ok === 1,
        };
      }
    }

    return {
      publicId: row.public_id,
      name: row.name,
      description: row.description,
      sectionPublicId:
        row.section_id === null ? null : (sectionPublicIdByInternal.get(row.section_id) ?? null),
      orderId: row.order_id,
      availableSince: row.available_since,
      probe,
      statusFreshnessMax,
      impacts: impactsByComponent.get(row.id) ?? [],
      maintenances: maintenanceByComponent.get(row.id) ?? [],
      changePublicIds: activeChangePublicIds.get(row.id) ?? [],
      days: daysByComponent.get(row.id) ?? [],
    };
  });

  const snapshotSections: SnapshotSection[] = sections.map((row) => ({
    publicId: row.public_id,
    name: row.name,
    description: row.description,
    orderId: row.order_id,
    componentPublicIds: snapshotComponents
      .filter((component) => component.sectionPublicId === row.public_id)
      .map((component) => component.publicId),
  }));

  return {
    slug: page.slug,
    name: page.name,
    snapshotVersion: page.snapshot_version,
    generatedAt: now,
    sourceUpdatedAt: page.updated_at,
    sections: snapshotSections,
    components: snapshotComponents,
    changes: snapshotChanges,
  };
}

/**
 * Persist a snapshot to both keys, and to the colo-local cache.
 *
 * `snapshot:<slug>:last` is written by the same call that writes
 * `snapshot:<slug>`. That is not incidental: the fallback path in
 * `readSnapshot` depends on the key existing, so the write path has to maintain
 * it deliberately. Writing only the fresh key would leave the documented
 * fallback with no write contract behind it.
 *
 * The cache write is best-effort and cannot fail this call. See `cache.ts` for
 * what that layer is for and why it is deliberately not an authority.
 */
export async function writeSnapshot(kv: KVNamespace, snapshot: Snapshot): Promise<void> {
  const body = JSON.stringify(snapshot);
  await Promise.all([
    kv.put(freshKey(snapshot.slug), body),
    kv.put(lastKey(snapshot.slug), body),
    writeSnapshotToCache(snapshot),
  ]);
}

async function readKv(kv: KVNamespace, key: string): Promise<Snapshot | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  return JSON.parse(raw) as Snapshot;
}

export async function readSnapshot(
  db: D1Database,
  kv: KVNamespace,
  slug: string,
  options: { now?: number; ageWarningSeconds?: number } = {},
): Promise<ReadResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ageWarning = options.ageWarningSeconds ?? DEFAULT_AGE_WARNING_SECONDS;
  const errors: string[] = [];

  const finish = (
    snapshot: Snapshot | null,
    source: SnapshotSource,
    stale: boolean,
  ): ReadResult => {
    const ageSeconds = snapshot === null ? null : Math.max(0, now - snapshot.generatedAt);
    return {
      snapshot,
      source,
      stale,
      ageSeconds,
      aged: ageSeconds !== null && ageSeconds > ageWarning,
      errors,
    };
  };

  // 1. Normal path: KV only. The snapshot is written synchronously by whatever
  //    changed the data, so a hit here is current and `stale` is false. What
  //    this path *cannot* detect is a KV propagation delay; that is documented
  //    rather than papered over with a timestamp heuristic.
  try {
    const cached = await readKv(kv, freshKey(slug));
    if (cached) return finish(cached, "kv-fresh", false);
  } catch (error) {
    errors.push(`kv-fresh: ${describe(error)}`);
  }

  // 2. KV missed — rebuild from D1 and repopulate both keys.
  try {
    const rebuilt = await buildSnapshot(db, slug, { now });
    try {
      await writeSnapshot(kv, rebuilt);
    } catch (error) {
      // A write failure must not fail the read: we already have the data.
      errors.push(`kv-write: ${describe(error)}`);
    }
    return finish(rebuilt, "d1-rebuild", false);
  } catch (error) {
    errors.push(`d1-rebuild: ${describe(error)}`);
  }

  // 3. D1 unavailable — fall back to the last known good snapshot. This is one of
  //    the two paths where `stale` is a real signal: we are serving data whose
  //    currency we could not check.
  try {
    const last = await readKv(kv, lastKey(slug));
    if (last) return finish(last, "kv-last", true);
  } catch (error) {
    errors.push(`kv-last: ${describe(error)}`);
  }

  // 4. KV could not answer at all — try this data centre's own copy. This is the
  //    one failure `kv-last` cannot cover, because `kv-last` is also in KV. Like
  //    `kv-last` it is reported stale: the chain could not confirm currency.
  try {
    const local = await readSnapshotFromCache(slug);
    if (local) return finish(local, "cache", true);
  } catch (error) {
    errors.push(`cache: ${describe(error)}`);
  }

  // 5. Nothing left. Report that plainly.
  return finish(null, "none", true);
}

/**
 * Advance `page.snapshot_version`.
 *
 * Every write that changes public output must call this, and the snapshot is
 * rebuilt synchronously by the same request. The version exists so that the cron
 * repair pass can tell, without rebuilding, whether a KV payload has fallen
 * behind D1 — which is a different question from whether the data changed.
 */
export async function bumpSnapshotVersion(
  db: D1Database,
  pageId: number,
  now: number,
): Promise<number> {
  const row = await db
    .prepare(
      "UPDATE page SET snapshot_version = snapshot_version + 1, updated_at = ?2 WHERE id = ?1 RETURNING snapshot_version",
    )
    .bind(pageId, now)
    .first<{ snapshot_version: number }>();

  if (!row) throw new Error(`no page with id ${pageId}`);
  return row.snapshot_version;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
