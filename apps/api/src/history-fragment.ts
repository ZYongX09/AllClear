/** Sparse, revision-guarded D1 history cache. Never called by public readers. */
import { startOfUtcDay, utcDay } from "@allclear/shared";

export const HISTORY_DAYS = 90;

interface HistoryRow {
  component_id: number;
  day: string;
  uptime: number | null;
  worst_status: string;
  covered_seconds: number;
  unknown_seconds: number;
  computed_at: number;
}
interface DirtyRow extends Omit<HistoryRow, "worst_status" | "covered_seconds" | "unknown_seconds" | "computed_at"> {
  worst_status: string | null;
  covered_seconds: number | null;
  unknown_seconds: number | null;
  computed_at: number | null;
}

/** Fixed SQL only: callers bind page slug, now and floor as ?1/?2/?3. */
export const RAW_HISTORY_SQL = `(SELECT json_group_array(json_object(
  'component_id',u.component_id,'day',u.day,'uptime',u.uptime,'worst_status',u.worst_status,
  'covered_seconds',u.covered_seconds,'unknown_seconds',u.unknown_seconds,'computed_at',u.computed_at))
  FROM (SELECT d.component_id,d.day,d.uptime,d.worst_status,d.covered_seconds,d.unknown_seconds,d.computed_at
    FROM daily_uptime d JOIN component c ON c.id=d.component_id
    WHERE c.page_id=(SELECT id FROM page WHERE slug=?1) AND d.day>=?3 ORDER BY d.day) u)`;

export const CACHED_HISTORY_SQL = `(SELECT h.body FROM snapshot_history h JOIN page p ON p.id=h.page_id
  WHERE p.slug=?1 AND h.history_revision=p.history_revision AND h.valid_until>?2)`;

/** A revision mismatch patches only queued component-days; cold initialization
 * alone scans the bounded history. Daily triggers persist crash-safe tombstones.
 */
export async function refreshHistoryFragment(db: D1Database, slug: string, now: number): Promise<void> {
  const floor = utcDay(now - (HISTORY_DAYS - 1) * 86_400);
  const source = await db.prepare(`SELECT p.id,p.history_revision,h.body,h.valid_until,
    CASE WHEN h.page_id IS NULL THEN ${RAW_HISTORY_SQL} ELSE NULL END AS baseline,
    CASE WHEN h.history_revision IS NOT p.history_revision THEN (
      SELECT json_group_array(json_object('component_id',q.component_id,'day',q.day,
        'uptime',d.uptime,'worst_status',d.worst_status,'covered_seconds',d.covered_seconds,
        'unknown_seconds',d.unknown_seconds,'computed_at',d.computed_at))
      FROM snapshot_history_dirty q
      LEFT JOIN component c ON c.id=q.component_id AND c.page_id=q.page_id
      LEFT JOIN daily_uptime d ON d.component_id=c.id AND d.day=q.day
      WHERE q.page_id=p.id AND q.revision<=p.history_revision
    ) ELSE '[]' END AS dirty,
    h.history_revision AS cached_revision
    FROM page p LEFT JOIN snapshot_history h ON h.page_id=p.id WHERE p.slug=?1`)
    .bind(slug, now, floor).first<{
      id: number; history_revision: number; body: string | null; valid_until: number | null;
      baseline: string | null; dirty: string; cached_revision: number | null;
    }>();
  if (!source) throw new Error(`no page with slug ${slug}`);
  if (source.cached_revision === source.history_revision && source.valid_until! > now) return;

  const rows = JSON.parse(source.baseline ?? source.body ?? "[]") as HistoryRow[];
  const keyed = new Map(rows.map((row) => [`${row.component_id}/${row.day}`, row]));
  for (const row of JSON.parse(source.dirty) as DirtyRow[]) {
    const key = `${row.component_id}/${row.day}`;
    if (row.computed_at === null) keyed.delete(key);
    else keyed.set(key, row as HistoryRow);
  }
  const retained = [...keyed.values()].filter((row) => row.day >= floor)
    .sort((a, b) => a.day.localeCompare(b.day) || a.component_id - b.component_id);
  const computedAt = retained.length === 0 ? null : Math.max(...retained.map((row) => row.computed_at));
  const validUntil = startOfUtcDay(now) + 86_400;
  // Both statements commit together. A losing revision CAS must not clear any
  // invalidation, including a newer update to the same component/day key.
  await db.batch([
    db.prepare(`INSERT INTO snapshot_history(page_id,history_revision,body,computed_at,valid_until)
      SELECT id,?2,?3,?4,?5 FROM page WHERE id=?1 AND history_revision=?2
      ON CONFLICT(page_id) DO UPDATE SET history_revision=excluded.history_revision,
        body=excluded.body,computed_at=excluded.computed_at,valid_until=excluded.valid_until
      WHERE snapshot_history.history_revision<excluded.history_revision
        OR snapshot_history.valid_until<=excluded.valid_until`)
      .bind(source.id, source.history_revision, JSON.stringify(retained), computedAt, validUntil),
    db.prepare(`DELETE FROM snapshot_history_dirty WHERE page_id=?1 AND revision<=?2
      AND EXISTS (SELECT 1 FROM page p JOIN snapshot_history h ON h.page_id=p.id
        WHERE p.id=?1 AND p.history_revision=?2 AND h.history_revision=?2 AND h.valid_until=?3)`)
      .bind(source.id, source.history_revision, validUntil),
  ]);
}
