-- Internal history materialization. Live summaries retain the public Snapshot shape.
ALTER TABLE page ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshot_summary ADD COLUMN history_revision INTEGER NOT NULL DEFAULT -1;
ALTER TABLE snapshot_summary ADD COLUMN history_valid_until INTEGER NOT NULL DEFAULT 0;

CREATE TABLE snapshot_history (
  page_id INTEGER PRIMARY KEY REFERENCES page(id) ON DELETE CASCADE,
  history_revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  computed_at INTEGER,
  valid_until INTEGER NOT NULL
);

-- Sparse invalidation, including deletion tombstones. Internal component ids are
-- deliberately not foreign keys: a queued deletion must survive its component.
CREATE TABLE snapshot_history_dirty (
  page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (page_id, component_id, day)
) WITHOUT ROWID;

-- Replace, rather than duplicate, the existing live-summary dirtiness triggers.
DROP TRIGGER daily_uptime_live_insert;
DROP TRIGGER daily_uptime_live_update;
DROP TRIGGER daily_uptime_live_delete;
CREATE TRIGGER daily_uptime_live_insert AFTER INSERT ON daily_uptime BEGIN
  UPDATE page SET live_revision=live_revision+1,history_revision=history_revision+1
    WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
  INSERT INTO snapshot_history_dirty(page_id,component_id,day,revision)
    SELECT c.page_id,NEW.component_id,NEW.day,p.history_revision
    FROM component c JOIN page p ON p.id=c.page_id WHERE c.id=NEW.component_id
    ON CONFLICT(page_id,component_id,day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER daily_uptime_live_update AFTER UPDATE OF component_id,day,covered_seconds,unknown_seconds,downtime_weighted,uptime,worst_status,computed_at,archived ON daily_uptime BEGIN
  UPDATE page SET live_revision=live_revision+1,history_revision=history_revision+1
    WHERE id IN (SELECT page_id FROM component WHERE id IN (OLD.component_id,NEW.component_id));
  INSERT INTO snapshot_history_dirty(page_id,component_id,day,revision)
    SELECT c.page_id,OLD.component_id,OLD.day,p.history_revision
    FROM component c JOIN page p ON p.id=c.page_id WHERE c.id=OLD.component_id
      AND (OLD.component_id IS NOT NEW.component_id OR OLD.day IS NOT NEW.day)
    ON CONFLICT(page_id,component_id,day) DO UPDATE SET revision=excluded.revision;
  INSERT INTO snapshot_history_dirty(page_id,component_id,day,revision)
    SELECT c.page_id,NEW.component_id,NEW.day,p.history_revision
    FROM component c JOIN page p ON p.id=c.page_id WHERE c.id=NEW.component_id
    ON CONFLICT(page_id,component_id,day) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER daily_uptime_live_delete AFTER DELETE ON daily_uptime BEGIN
  UPDATE page SET live_revision=live_revision+1,history_revision=history_revision+1
    WHERE id=(SELECT page_id FROM component WHERE id=OLD.component_id);
  INSERT INTO snapshot_history_dirty(page_id,component_id,day,revision)
    SELECT c.page_id,OLD.component_id,OLD.day,p.history_revision
    FROM component c JOIN page p ON p.id=c.page_id WHERE c.id=OLD.component_id
    ON CONFLICT(page_id,component_id,day) DO UPDATE SET revision=excluded.revision;
END;

-- Cascades may remove the parent before daily-row DELETE triggers can find its
-- page. Invalidate before deletion; the next writer does one bounded cold build.
CREATE TRIGGER component_history_delete BEFORE DELETE ON component BEGIN
  UPDATE page SET history_revision=history_revision+1 WHERE id=OLD.page_id;
  DELETE FROM snapshot_history WHERE page_id=OLD.page_id;
END;
CREATE TRIGGER component_history_move BEFORE UPDATE OF page_id ON component
WHEN OLD.page_id IS NOT NEW.page_id BEGIN
  UPDATE page SET history_revision=history_revision+1,live_revision=live_revision+1
    WHERE id IN (OLD.page_id,NEW.page_id);
  DELETE FROM snapshot_history WHERE page_id IN (OLD.page_id,NEW.page_id);
END;
