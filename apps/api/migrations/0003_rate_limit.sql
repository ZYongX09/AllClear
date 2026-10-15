-- allclear — M5: rate limiting counters.
--
-- Kept in D1 rather than KV for one reason that decides it: a rate limit is a
-- counter, and KV has no atomic increment. Read-modify-write against KV would let
-- two concurrent requests both read `n` and both write `n + 1`, so the limit would
-- be bypassable by exactly the concurrency it exists to stop.
--
-- `ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count` is a single
-- statement, so the increment is atomic in the same way the probe transition's
-- compare-and-swap is.
--
-- Windows are fixed rather than sliding, and that is a stated trade rather than
-- an oversight: a fixed window allows a burst of up to 2x the limit across a
-- boundary. For an anti-abuse limit on a subscribe form that is acceptable, and
-- the alternative — a sliding window — needs either a row per request or a
-- probabilistic sketch, which is more machinery than this limit justifies.

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket       TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit(window_start);
