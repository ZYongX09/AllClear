-- Persisted, leased scheduling: missed cron ticks are due work, not lost modulo slots.
CREATE TABLE maintenance_job (
  job TEXT PRIMARY KEY,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  completed_day TEXT,
  -- Candidate day survives grace deferrals, retries and missed cron ticks.
  cursor_day TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT INTO maintenance_job(job) VALUES ('today'), ('finalize'), ('retention');

-- A day is sealed in the same statement that materializes its final aggregate.
-- Retention discovers the next day from this watermark, never from the preserved
-- predecessor/accepted result. Archived rows cannot be overwritten with purged data.
ALTER TABLE daily_uptime ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));

-- Watermark lookup must not walk today's unsealed history on every day chunk.
CREATE INDEX idx_daily_uptime_archived ON daily_uptime(component_id, day) WHERE archived = 1;
-- Include disabled historical targets without scanning all targets per component.
CREATE INDEX idx_probe_target_component ON probe_target(component_id);
CREATE INDEX idx_impact_manual_time ON impact(component_id, start_at) WHERE probe_target_id IS NULL;

-- No observed_at-leading probe_result index: discovery/deletion is per target and
-- uses idx_probe_result_target_time, avoiding an extra index write on every probe.
