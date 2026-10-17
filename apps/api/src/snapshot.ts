/** D1 live summary first; durable KV checkpoints are explicitly eventual fallbacks. */

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

import { readSnapshotFromCache, writeSnapshotToCache, readLiveSnapshotFromCache, writeLiveSnapshotToCache } from "./cache";

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
  live_revision: number;
  urgent_revision: number;
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
  computed_at: number;
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
export async function buildSnapshot(db: D1Database, slug: string, options: { now?: number } = {}): Promise<Snapshot> {
  return (await buildSnapshotEvidence(db, slug, options)).snapshot;
}

export interface SnapshotEvidence {
  snapshot: Snapshot;
  page: PageRow;
}

/** Metadata and evidence are read in the SAME transaction, never relabelled later. */
export async function buildSnapshotEvidence(
  db: D1Database,
  slug: string,
  options: { now?: number } = {},
): Promise<SnapshotEvidence> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const historyFloor = utcDay(now - (HISTORY_DAYS - 1) * 86_400);
  const changeFloor = now - CHANGE_HISTORY_SECONDS;

  // A single SQLite statement is a consistent read, including the revision
  // stamped on the document. Each subquery is constrained to this page.
  const data = await db.prepare(`SELECT
    (SELECT json_group_array(json_object('id',id,'slug',slug,'name',name,'snapshot_version',snapshot_version,'updated_at',updated_at,'live_revision',live_revision,'urgent_revision',urgent_revision)) FROM (SELECT id,slug,name,snapshot_version,updated_at,live_revision,urgent_revision FROM page WHERE slug=?1)) AS page,
    (SELECT json_group_array(json_object('id',id,'public_id',public_id,'name',name,'description',description,'order_id',order_id)) FROM (SELECT id,public_id,name,description,order_id FROM section WHERE page_id=(SELECT id FROM page WHERE slug=?1) ORDER BY order_id,id)) AS sections,
    (SELECT json_group_array(json_object('id',id,'public_id',public_id,'name',name,'description',description,'section_id',section_id,'order_id',order_id,'available_since',available_since)) FROM (SELECT id,public_id,name,description,section_id,order_id,available_since FROM component WHERE page_id=(SELECT id FROM page WHERE slug=?1) ORDER BY order_id,id)) AS components,
    (SELECT json_group_array(json_object('target_public_id',target_public_id,'component_id',component_id,'interval_seconds',interval_seconds,'last_probe_at',last_probe_at,'last_ok',last_ok)) FROM (SELECT t.public_id AS target_public_id,t.component_id,t.interval_seconds,s.last_probe_at,(SELECT r.ok FROM probe_result r WHERE r.public_id=s.last_result_id) AS last_ok FROM probe_target t JOIN component c ON c.id=t.component_id LEFT JOIN probe_state s ON s.probe_target_id=t.id WHERE c.page_id=(SELECT id FROM page WHERE slug=?1) AND t.enabled=1)) AS probes,
    (SELECT json_group_array(json_object('component_id',component_id,'severity',severity,'start_at',start_at,'end_at',end_at)) FROM (SELECT i.component_id,i.severity,i.start_at,i.end_at FROM impact i JOIN component c ON c.id=i.component_id WHERE c.page_id=(SELECT id FROM page WHERE slug=?1) AND (i.end_at IS NULL OR i.end_at>=?2))) AS impacts,
    (SELECT json_group_array(json_object('id',id,'public_id',public_id,'kind',kind,'status',status,'title',title,'body',body,'severity',severity,'starts_at',starts_at,'ends_at',ends_at,'scheduled_start_at',scheduled_start_at,'scheduled_end_at',scheduled_end_at)) FROM (SELECT id,public_id,kind,status,title,body,severity,starts_at,ends_at,scheduled_start_at,scheduled_end_at FROM change WHERE page_id=(SELECT id FROM page WHERE slug=?1) AND (ends_at IS NULL OR ends_at>=?4) ORDER BY starts_at DESC,id DESC LIMIT ?5)) AS changes,
    (SELECT json_group_array(json_object('change_id',change_id,'component_id',component_id)) FROM (SELECT cc.change_id,cc.component_id FROM change_component cc JOIN change ch ON ch.id=cc.change_id WHERE ch.page_id=(SELECT id FROM page WHERE slug=?1))) AS changeComponents,
    (SELECT json_group_array(json_object('id',id,'public_id',public_id,'change_id',change_id,'status',status,'body',body,'created_at',created_at)) FROM (SELECT u.id,u.public_id,u.change_id,u.status,u.body,u.created_at FROM change_update u JOIN change ch ON ch.id=u.change_id WHERE ch.page_id=(SELECT id FROM page WHERE slug=?1) ORDER BY u.created_at,u.id)) AS updates,
    (SELECT json_group_array(json_object('change_update_id',change_update_id,'component_id',component_id)) FROM (SELECT uc.change_update_id,uc.component_id FROM change_update_component uc JOIN change_update u ON u.id=uc.change_update_id JOIN change ch ON ch.id=u.change_id WHERE ch.page_id=(SELECT id FROM page WHERE slug=?1))) AS updateComponents,
    (SELECT json_group_array(json_object('component_id',component_id,'day',day,'uptime',uptime,'worst_status',worst_status,'covered_seconds',covered_seconds,'unknown_seconds',unknown_seconds,'computed_at',computed_at)) FROM (SELECT u.component_id,u.day,u.uptime,u.worst_status,u.covered_seconds,u.unknown_seconds,u.computed_at FROM daily_uptime u JOIN component c ON c.id=u.component_id WHERE c.page_id=(SELECT id FROM page WHERE slug=?1) AND u.day>=?3 ORDER BY u.day)) AS daily`)
    .bind(slug, now, historyFloor, changeFloor, MAX_CHANGES)
    .first<Record<string, string>>();
  if (!data) throw new Error(`no page with slug ${slug}`);
  const pageResult = { results: JSON.parse(data.page!) };
  const sectionsResult = { results: JSON.parse(data.sections!) };
  const componentsResult = { results: JSON.parse(data.components!) };
  const probesResult = { results: JSON.parse(data.probes!) };
  const impactsResult = { results: JSON.parse(data.impacts!) };
  const changesResult = { results: JSON.parse(data.changes!) };
  const changeComponentsResult = { results: JSON.parse(data.changeComponents!) };
  const updatesResult = { results: JSON.parse(data.updates!) };
  const updateComponentsResult = { results: JSON.parse(data.updateComponents!) };
  const dailyResult = { results: JSON.parse(data.daily!) };

  const page = pageResult.results[0] as unknown as PageRow | undefined;
  if (!page) throw new Error(`no page with slug ${slug}`);

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

  return { page, snapshot: {
    slug: page.slug,
    name: page.name,
    snapshotVersion: page.snapshot_version,
    generatedAt: now,
    sourceUpdatedAt: page.updated_at,
    historyComputedAt: daily.length === 0 ? null : Math.max(...daily.map((row) => row.computed_at)),
    sections: snapshotSections,
    components: snapshotComponents,
    changes: snapshotChanges,
  } };
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
  const results = await Promise.allSettled([
    kv.put(freshKey(snapshot.slug), body),
    kv.put(lastKey(snapshot.slug), body),
    writeSnapshotToCache(snapshot),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Snapshot>;
  return typeof item.slug === "string" && typeof item.name === "string" &&
    typeof item.snapshotVersion === "number" && Number.isFinite(item.snapshotVersion) &&
    typeof item.generatedAt === "number" && Number.isFinite(item.generatedAt) &&
    typeof item.sourceUpdatedAt === "number" && Number.isFinite(item.sourceUpdatedAt) &&
    Array.isArray(item.sections) && Array.isArray(item.components) && Array.isArray(item.changes);
}

async function readKv(kv: KVNamespace, key: string): Promise<Snapshot | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isSnapshot(parsed)) throw new Error("invalid snapshot document");
  return parsed;
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

  // A hot live key is independent from the hour-long failure hedge. Cache age
  // never changes probe timestamps; readers still derive strict freshness.
  const hot = await readLiveSnapshotFromCache(slug, now);
  if (hot) return finish(hot, "cache-live", false);
  try {
    const row = await db.prepare("SELECT s.body FROM snapshot_summary s JOIN page p ON p.id=s.page_id WHERE p.slug=?1 AND s.content_revision=p.snapshot_version AND s.live_revision=p.live_revision AND s.urgent_revision=p.urgent_revision")
      .bind(slug).first<{ body: string }>();
    if (row) {
      const live: unknown = JSON.parse(row.body);
      if (!isSnapshot(live)) throw new Error("invalid live summary document");
      await Promise.all([writeLiveSnapshotToCache(live, now), writeSnapshotToCache(live)]);
      return finish(live, "d1-live", false);
    }
    // Migration/cold miss: READ ONLY assembly. A visitor never repairs KV/D1.
    const rebuilt = await buildSnapshot(db, slug, { now });
    await Promise.all([writeLiveSnapshotToCache(rebuilt, now), writeSnapshotToCache(rebuilt)]);
    return finish(rebuilt, "d1-rebuild", false);
  } catch (error) {
    errors.push(`d1-rebuild: ${describe(error)}`);
  }
  try {
    const checkpoint = await readKv(kv, freshKey(slug));
    if (checkpoint) return finish(checkpoint, "kv-fresh", true);
  } catch (error) {
    errors.push(`kv-fresh: ${describe(error)}`);
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
      "UPDATE page SET snapshot_version = snapshot_version + 1, live_revision = live_revision + 1, urgent_revision = urgent_revision + 1, updated_at = ?2 WHERE id = ?1 RETURNING snapshot_version",
    )
    .bind(pageId, now)
    .first<{ snapshot_version: number }>();

  if (!row) throw new Error(`no page with id ${pageId}`);
  return row.snapshot_version;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
