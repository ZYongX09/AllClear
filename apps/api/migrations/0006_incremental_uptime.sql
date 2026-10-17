-- Exact cumulative prefixes share the daily row's atomic write. Old rows start
-- without a checkpoint and are rebuilt once, never inferred from percentages.
ALTER TABLE component ADD COLUMN rollup_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE component ADD COLUMN rollup_dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE component ADD COLUMN rollup_dirty_from TEXT;
ALTER TABLE daily_uptime ADD COLUMN rollup_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_uptime ADD COLUMN prefix_state TEXT;
INSERT INTO maintenance_job(job) VALUES ('repair');

-- Internal rollup bookkeeping is NOT a public component edit or urgent event.
DROP TRIGGER component_dirty_update;
CREATE TRIGGER component_dirty_update
AFTER UPDATE OF page_id, public_id, name, description, section_id, available_since, order_id ON component
WHEN OLD.page_id IS NOT NEW.page_id OR OLD.public_id IS NOT NEW.public_id
 OR OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description
 OR OLD.section_id IS NOT NEW.section_id OR OLD.available_since IS NOT NEW.available_since
 OR OLD.order_id IS NOT NEW.order_id BEGIN
 UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1
  WHERE id IN (OLD.page_id,NEW.page_id);
END;

CREATE TRIGGER component_rollup_availability AFTER UPDATE OF available_since ON component
WHEN OLD.available_since IS NOT NEW.available_since BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),date(MIN(OLD.available_since,NEW.available_since),'unixepoch'))
  WHERE id=NEW.id;
END;

CREATE TRIGGER impact_rollup_insert AFTER INSERT ON impact BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),date(NEW.start_at,'unixepoch'))
  WHERE id=NEW.component_id;
END;
CREATE TRIGGER impact_rollup_update
AFTER UPDATE OF component_id,probe_target_id,severity,start_at,end_at ON impact
WHEN OLD.component_id IS NOT NEW.component_id OR OLD.probe_target_id IS NOT NEW.probe_target_id
 OR OLD.severity IS NOT NEW.severity OR OLD.start_at IS NOT NEW.start_at OR OLD.end_at IS NOT NEW.end_at BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),date(MIN(OLD.start_at,NEW.start_at),'unixepoch'))
  WHERE id IN (OLD.component_id,NEW.component_id);
END;
CREATE TRIGGER impact_rollup_delete AFTER DELETE ON impact BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),date(OLD.start_at,'unixepoch'))
 WHERE id=OLD.component_id;
END;

CREATE TRIGGER target_rollup_insert AFTER INSERT ON probe_target BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,
  rollup_dirty=CASE WHEN EXISTS(SELECT 1 FROM daily_uptime d WHERE d.component_id=NEW.component_id AND d.archived=0) THEN 1 ELSE rollup_dirty END,
  rollup_dirty_from=CASE WHEN EXISTS(SELECT 1 FROM daily_uptime d WHERE d.component_id=NEW.component_id AND d.archived=0) THEN '0000-01-01' ELSE rollup_dirty_from END
  WHERE id=NEW.component_id;
END;
CREATE TRIGGER target_rollup_update
AFTER UPDATE OF component_id,interval_seconds,enabled ON probe_target
WHEN OLD.component_id IS NOT NEW.component_id OR OLD.interval_seconds IS NOT NEW.interval_seconds OR OLD.enabled IS NOT NEW.enabled BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,rollup_dirty_from='0000-01-01'
  WHERE id IN (OLD.component_id,NEW.component_id);
END;
CREATE TRIGGER target_rollup_delete BEFORE DELETE ON probe_target BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,rollup_dirty_from='0000-01-01' WHERE id=OLD.component_id;
END;

-- Maintenance duration is keyed by its interval, not present-day status/title.
CREATE TRIGGER maintenance_rollup_update AFTER UPDATE OF kind,starts_at,ends_at ON change
WHEN (OLD.kind='maintenance' OR NEW.kind='maintenance')
 AND (OLD.kind IS NOT NEW.kind OR OLD.starts_at IS NOT NEW.starts_at OR OLD.ends_at IS NOT NEW.ends_at) BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),date(MIN(OLD.starts_at,NEW.starts_at),'unixepoch'))
  WHERE id IN (SELECT component_id FROM change_component WHERE change_id=NEW.id);
END;
CREATE TRIGGER maintenance_rollup_delete BEFORE DELETE ON change WHEN OLD.kind='maintenance' BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),date(OLD.starts_at,'unixepoch'))
  WHERE id IN (SELECT component_id FROM change_component WHERE change_id=OLD.id);
END;
CREATE TRIGGER maintenance_link_rollup_insert AFTER INSERT ON change_component
WHEN (SELECT kind FROM change WHERE id=NEW.change_id)='maintenance' BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),
    (SELECT date(starts_at,'unixepoch') FROM change WHERE id=NEW.change_id))
 WHERE id=NEW.component_id;
END;
CREATE TRIGGER maintenance_link_rollup_delete BEFORE DELETE ON change_component
WHEN (SELECT kind FROM change WHERE id=OLD.change_id)='maintenance' BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),
    (SELECT date(starts_at,'unixepoch') FROM change WHERE id=OLD.change_id))
 WHERE id=OLD.component_id;
END;
CREATE TRIGGER maintenance_link_rollup_update AFTER UPDATE ON change_component
WHEN OLD.change_id IS NOT NEW.change_id OR OLD.component_id IS NOT NEW.component_id BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),
    (SELECT date(MIN(starts_at),'unixepoch') FROM change WHERE id IN(OLD.change_id,NEW.change_id) AND kind='maintenance'))
 WHERE id IN (OLD.component_id,NEW.component_id)
 AND EXISTS(SELECT 1 FROM change WHERE id IN(OLD.change_id,NEW.change_id) AND kind='maintenance');
END;

-- Accepted appends are already nonce/CAS guarded. Direct imports, or a delayed
-- observation behind another target's latest sample, can change an in-flight
-- prefix or archival computation even before a checkpoint exists. Invalidate
-- those transactionally; each target MAX is an indexed seek. Include the prior
-- gap so a newly imported midnight successor also repairs the preceding day.
CREATE TRIGGER result_rollup_backfill AFTER INSERT ON probe_result
WHEN NEW.public_id IS NOT (SELECT last_result_id FROM probe_state WHERE probe_target_id=NEW.probe_target_id)
 OR NEW.observed_at < (SELECT MAX(last_at) FROM (
   SELECT (SELECT MAX(r.observed_at) FROM probe_result r WHERE r.probe_target_id=t.id AND r.id<>NEW.id) AS last_at
   FROM probe_target t WHERE t.component_id=(SELECT component_id FROM probe_target WHERE id=NEW.probe_target_id))) BEGIN
 UPDATE component SET rollup_revision=rollup_revision+1,rollup_dirty=1,
  rollup_dirty_from=MIN(COALESCE(rollup_dirty_from,'9999-12-31'),
    date(NEW.observed_at-MAX(120,2*COALESCE((SELECT MAX(interval_seconds) FROM probe_target
      WHERE component_id=component.id AND enabled=1),60)),'unixepoch'))
 WHERE id=(SELECT component_id FROM probe_target WHERE id=NEW.probe_target_id);
END;
