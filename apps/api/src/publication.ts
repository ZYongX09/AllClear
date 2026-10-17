/** One bounded checkpoint publisher for cron, admin and explicit rebuilds.
 *
 * D1 is authoritative. The nonce protects claims/acks in D1, NOT an in-flight
 * KV put: an expired worker may finish after a newer one. KV is an eventually
 * repaired fallback and can temporarily regress (including partial two-key puts).
 */
import { startOfUtcDay, utcDay, type Snapshot } from "@allclear/shared";
import { refreshHistoryFragment } from "./history-fragment";
import { writeLiveSnapshotToCache, writeSnapshotToCache } from "./cache";
import { buildSnapshotEvidence, writeSnapshot } from "./snapshot";

export const CHECKPOINT_SECONDS = 600;
export const PERIODIC_PUTS_PER_DAY = 288;
export const MAX_PUTS_PER_DAY = 800;
export const PUBLISH_LEASE_SECONDS = 120;

export async function refreshLiveSummary(db: D1Database, slug: string, now: number): Promise<Snapshot> {
  await refreshHistoryFragment(db, slug, now);
  const { page, snapshot } = await buildSnapshotEvidence(db, slug, { now });
  const saved = await db.prepare(`INSERT INTO snapshot_summary
    (page_id,content_revision,live_revision,urgent_revision,body,generated_at,history_revision,history_valid_until)
    SELECT id,?2,?3,?4,?5,?6,?7,?8 FROM page
    WHERE id=?1 AND snapshot_version=?2 AND live_revision=?3 AND urgent_revision=?4 AND history_revision=?7
    ON CONFLICT(page_id) DO UPDATE SET content_revision=excluded.content_revision,
      live_revision=excluded.live_revision,urgent_revision=excluded.urgent_revision,
      body=excluded.body,generated_at=excluded.generated_at,history_revision=excluded.history_revision,
      history_valid_until=excluded.history_valid_until
    WHERE snapshot_summary.generated_at<=excluded.generated_at`)
    .bind(page.id, snapshot.snapshotVersion, page.live_revision, page.urgent_revision, JSON.stringify(snapshot), now,
      page.history_revision, startOfUtcDay(now) + 86_400).run();
  if (saved.meta.changes > 0) {
    await Promise.all([writeLiveSnapshotToCache(snapshot, now), writeSnapshotToCache(snapshot)]);
  }
  return snapshot;
}

interface Claimed {
  id: number;
  body: string;
  content_revision: number;
  urgent_revision: number;
  failures: number;
  periodic: number;
}
export interface PublicationResult { published: boolean; deferred: boolean; error?: string }

export async function publishCheckpoint(db: D1Database, kv: KVNamespace, slug: string, now: number): Promise<PublicationResult> {
  const nonce = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE page SET publish_nonce=?2,publish_lease_until=?3
    WHERE slug=?1 AND publish_lease_until<=?4 AND publish_retry_at<=?4
      AND (urgent_revision>published_urgent_revision OR snapshot_version>published_content_revision OR next_checkpoint_at<=?4)
      AND EXISTS (SELECT 1 FROM snapshot_summary s WHERE s.page_id=page.id
        AND s.content_revision=page.snapshot_version AND s.live_revision=page.live_revision AND s.urgent_revision=page.urgent_revision
        AND s.history_revision=page.history_revision AND s.history_valid_until>?4)
    RETURNING id,(SELECT body FROM snapshot_summary WHERE page_id=page.id) AS body,
      (SELECT content_revision FROM snapshot_summary WHERE page_id=page.id) AS content_revision,
      (SELECT urgent_revision FROM snapshot_summary WHERE page_id=page.id) AS urgent_revision,
      publish_failures AS failures,
      CASE WHEN urgent_revision>published_urgent_revision OR snapshot_version>published_content_revision THEN 0 ELSE 1 END AS periodic`)
    .bind(slug, nonce, now + PUBLISH_LEASE_SECONDS, now).first<Claimed>();
  if (!claimed) return { published: false, deferred: true };
  const fail = async (error: string): Promise<PublicationResult> => {
    const backoff = Math.min(3600, 30 * 2 ** Math.min(claimed.failures, 7));
    await db.prepare(`UPDATE page SET publish_nonce=NULL,publish_lease_until=0,
      publish_failures=publish_failures+1,publish_retry_at=?3,publish_error=?4
      WHERE id=?1 AND publish_nonce=?2`)
      .bind(claimed.id, nonce, now + backoff, error).run();
    return { published: false, deferred: true, error };
  };
  // Reserve two possible writes even if only one put succeeds. No refund on
  // timeout/crash: we cannot know whether KV actually accepted that operation.
  const reserved = await db.prepare(`INSERT INTO snapshot_publish_budget(day,puts,periodic_puts)
    VALUES (?1,2,?2) ON CONFLICT(day) DO UPDATE SET puts=puts+2,periodic_puts=periodic_puts+?2
    WHERE puts+2<=?3 AND periodic_puts+?2<=?4 RETURNING puts`)
    .bind(utcDay(now), claimed.periodic * 2, MAX_PUTS_PER_DAY, PERIODIC_PUTS_PER_DAY).first();
  if (!reserved) return fail("daily checkpoint write budget exhausted");
  try {
    await writeSnapshot(kv, JSON.parse(claimed.body) as Snapshot);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // Acknowledge precisely the document claimed, never the page's newer revision.
  const ack = await db.prepare(`UPDATE page SET published_urgent_revision=MAX(published_urgent_revision,?3),
    published_content_revision=MAX(published_content_revision,?4),next_checkpoint_at=?5,
    publish_nonce=NULL,publish_lease_until=0,publish_retry_at=0,publish_failures=0,publish_error=NULL
    WHERE id=?1 AND publish_nonce=?2`)
    .bind(claimed.id, nonce, claimed.urgent_revision, claimed.content_revision, now + CHECKPOINT_SECONDS).run();
  return { published: ack.meta.changes > 0, deferred: ack.meta.changes === 0 };
}

/** D1 revision repair, not a per-minute KV read/version mismatch bypass. */
export async function repairAndPublishSnapshots(db: D1Database, kv: KVNamespace, now: number, historyChanged = false): Promise<void> {
  const { results } = await db.prepare(`SELECT p.slug,
      CASE WHEN s.page_id IS NULL OR s.live_revision<>p.live_revision OR s.content_revision<>p.snapshot_version OR s.urgent_revision<>p.urgent_revision
        OR s.history_revision<>p.history_revision OR s.history_valid_until<=?1 THEN 1 ELSE 0 END AS dirty,
      CASE WHEN p.publish_retry_at<=?1 AND p.publish_lease_until<=?1 AND
        (p.urgent_revision>p.published_urgent_revision OR p.snapshot_version>p.published_content_revision OR p.next_checkpoint_at<=?1) THEN 1 ELSE 0 END AS due
    FROM page p LEFT JOIN snapshot_summary s ON s.page_id=p.id`).bind(now).all<{ slug: string; dirty: number; due: number }>();
  for (const page of results) {
    if (page.dirty || historyChanged) await refreshLiveSummary(db, page.slug, now);
    if (page.due) {
      const result = await publishCheckpoint(db, kv, page.slug, now);
      if (result.error) console.warn("checkpoint deferred", { slug: page.slug, error: result.error });
    }
  }
}
