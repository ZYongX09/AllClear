-- Content revisions describe public changes; live revisions describe accepted
-- probe evidence. Checkpoints intentionally lag the live summary by up to 600s.
ALTER TABLE page ADD COLUMN live_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN urgent_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE page ADD COLUMN published_urgent_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN published_content_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN next_checkpoint_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN publish_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN publish_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN publish_nonce TEXT;
ALTER TABLE page ADD COLUMN publish_lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN publish_error TEXT;

-- The result insert is guarded by the winning observation CAS. Trigger changes
-- roll back with that same batch; unaccepted samples cannot dirty a page.
CREATE TRIGGER probe_result_public_revision AFTER INSERT ON probe_result BEGIN
  UPDATE page SET
    live_revision = live_revision + 1,
    urgent_revision = urgent_revision + CASE WHEN
      NOT EXISTS (SELECT 1 FROM probe_result r WHERE r.probe_target_id=NEW.probe_target_id AND r.id<>NEW.id)
      OR NEW.ok IS NOT (SELECT r.ok FROM probe_result r WHERE r.probe_target_id=NEW.probe_target_id AND r.id<>NEW.id ORDER BY r.observed_at DESC,r.id DESC LIMIT 1)
      OR NEW.observed_at - COALESCE((SELECT MAX(r.observed_at) FROM probe_result r WHERE r.probe_target_id=NEW.probe_target_id AND r.id<>NEW.id), NEW.observed_at) > (SELECT interval_seconds*2 FROM probe_target WHERE id=NEW.probe_target_id)
      THEN 1 ELSE 0 END
  WHERE id=(SELECT c.page_id FROM component c JOIN probe_target t ON t.component_id=c.id WHERE t.id=NEW.probe_target_id);
END;

CREATE TRIGGER impact_public_open AFTER INSERT ON impact WHEN NEW.probe_target_id IS NOT NULL BEGIN
  UPDATE page SET snapshot_version=snapshot_version+1,urgent_revision=urgent_revision+1
    WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
  UPDATE probe_state SET open_impact_id=(SELECT id FROM impact WHERE probe_target_id=NEW.probe_target_id AND end_at IS NULL ORDER BY id DESC LIMIT 1) WHERE probe_target_id=NEW.probe_target_id;
END;
CREATE TRIGGER impact_public_close AFTER UPDATE OF end_at ON impact
WHEN NEW.probe_target_id IS NOT NULL AND OLD.end_at IS NOT NEW.end_at BEGIN
  UPDATE page SET snapshot_version=snapshot_version+1,urgent_revision=urgent_revision+1
    WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
  UPDATE probe_state SET open_impact_id=(SELECT id FROM impact WHERE probe_target_id=NEW.probe_target_id AND end_at IS NULL ORDER BY id DESC LIMIT 1) WHERE probe_target_id=NEW.probe_target_id;
END;

CREATE TABLE snapshot_summary (
  page_id INTEGER PRIMARY KEY REFERENCES page(id) ON DELETE CASCADE,
  content_revision INTEGER NOT NULL,
  live_revision INTEGER NOT NULL,
  urgent_revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

-- Reserve both possible puts before touching KV, including retries/partial writes.
CREATE TABLE snapshot_publish_budget (
  day TEXT PRIMARY KEY,
  puts INTEGER NOT NULL DEFAULT 0,
  periodic_puts INTEGER NOT NULL DEFAULT 0
);

-- Admin evidence dirties a page in the mutation's own transaction, including
-- the crash window before the service's explicit content-version bump/build.
-- Target scheduler cursor updates are deliberately excluded.
CREATE TRIGGER page_public_name AFTER UPDATE OF name ON page BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=NEW.id;
END;
CREATE TRIGGER section_dirty_insert AFTER INSERT ON section BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=NEW.page_id;
END;
CREATE TRIGGER section_dirty_update AFTER UPDATE ON section BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=NEW.page_id;
END;
CREATE TRIGGER section_dirty_delete AFTER DELETE ON section BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=OLD.page_id;
END;
CREATE TRIGGER component_dirty_insert AFTER INSERT ON component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=NEW.page_id;
END;
CREATE TRIGGER component_dirty_update AFTER UPDATE ON component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=NEW.page_id;
END;
CREATE TRIGGER component_dirty_delete AFTER DELETE ON component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=OLD.page_id;
END;
CREATE TRIGGER change_dirty_insert AFTER INSERT ON change BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=NEW.page_id;
END;
CREATE TRIGGER change_dirty_update AFTER UPDATE ON change BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=NEW.page_id;
END;
CREATE TRIGGER change_dirty_delete AFTER DELETE ON change BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=OLD.page_id;
END;
CREATE TRIGGER probe_target_dirty_insert AFTER INSERT ON probe_target BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
END;
CREATE TRIGGER probe_target_dirty_update AFTER UPDATE OF component_id,url,method,severity,expected_status,timeout_ms,interval_seconds,failure_threshold,recovery_threshold,enabled ON probe_target BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
END;
CREATE TRIGGER probe_target_dirty_delete AFTER DELETE ON probe_target BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=OLD.component_id);
END;
CREATE TRIGGER change_component_dirty_insert AFTER INSERT ON change_component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM change WHERE id=NEW.change_id);
END;
CREATE TRIGGER change_component_dirty_update AFTER UPDATE ON change_component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM change WHERE id=NEW.change_id);
END;
CREATE TRIGGER change_component_dirty_delete AFTER DELETE ON change_component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM change WHERE id=OLD.change_id);
END;
CREATE TRIGGER change_update_dirty_insert AFTER INSERT ON change_update BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM change WHERE id=NEW.change_id);
END;
CREATE TRIGGER change_update_dirty_update AFTER UPDATE ON change_update BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM change WHERE id=NEW.change_id);
END;
CREATE TRIGGER change_update_dirty_delete AFTER DELETE ON change_update BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM change WHERE id=OLD.change_id);
END;
CREATE TRIGGER change_update_component_dirty_insert AFTER INSERT ON change_update_component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT ch.page_id FROM change ch JOIN change_update u ON u.change_id=ch.id WHERE u.id=NEW.change_update_id);
END;
CREATE TRIGGER change_update_component_dirty_update AFTER UPDATE ON change_update_component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT ch.page_id FROM change ch JOIN change_update u ON u.change_id=ch.id WHERE u.id=NEW.change_update_id);
END;
CREATE TRIGGER change_update_component_dirty_delete AFTER DELETE ON change_update_component BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT ch.page_id FROM change ch JOIN change_update u ON u.change_id=ch.id WHERE u.id=OLD.change_update_id);
END;
CREATE TRIGGER impact_admin_dirty_insert AFTER INSERT ON impact WHEN NEW.probe_target_id IS NULL BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
END;
CREATE TRIGGER impact_admin_dirty_update AFTER UPDATE ON impact WHEN NEW.probe_target_id IS NULL BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
END;
CREATE TRIGGER impact_admin_dirty_delete AFTER DELETE ON impact WHEN OLD.probe_target_id IS NULL BEGIN
  UPDATE page SET live_revision=live_revision+1,urgent_revision=urgent_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=OLD.component_id);
END;

-- Rollup repair is durable but never an urgent checkpoint event.
CREATE TRIGGER daily_uptime_live_insert AFTER INSERT ON daily_uptime BEGIN
  UPDATE page SET live_revision=live_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
END;
CREATE TRIGGER daily_uptime_live_update AFTER UPDATE ON daily_uptime BEGIN
  UPDATE page SET live_revision=live_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=NEW.component_id);
END;
CREATE TRIGGER daily_uptime_live_delete AFTER DELETE ON daily_uptime BEGIN
  UPDATE page SET live_revision=live_revision+1 WHERE id=(SELECT page_id FROM component WHERE id=OLD.component_id);
END;
