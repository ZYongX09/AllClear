-- allclear — M0 minimal schema.
--
-- This is deliberately the smallest schema that lets M0 prove the deployment
-- and data-path claims (KV snapshot served without touching D1; D1 as fallback;
-- last-good snapshot as final fallback). The full model described in
-- docs/spec/data-model.md (sections, changes, updates, impacts, probe targets
-- and results, subscribers) lands in M1.
--
-- ID roles (per the plan): externally visible entities carry both an internal
-- INTEGER PRIMARY KEY (used for foreign keys and indexes) and a `public_id`
-- ULID which is the only identifier exposed through the API.

CREATE TABLE IF NOT EXISTS page (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id        TEXT    NOT NULL UNIQUE,
  slug             TEXT    NOT NULL UNIQUE,
  name             TEXT    NOT NULL,
  -- Bumped by every change that affects public output. The snapshot staleness
  -- check compares this against the version embedded in the KV payload, rather
  -- than comparing a generic `updated_at` timestamp.
  snapshot_version INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS component (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT    NOT NULL UNIQUE,
  page_id         INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  -- M0 stores the effective status directly. M1 replaces this with a derived
  -- value computed from active impacts (worst-of), because a stored status
  -- cannot represent "resolving incident A must not clear a component that
  -- incident B is still affecting".
  status          TEXT    NOT NULL DEFAULT 'unknown',
  available_since INTEGER NOT NULL,
  order_id        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_component_page ON component(page_id, order_id);

-- Seed: the four example surfaces this project is first used to monitor.
-- Statuses are seeded as 'unknown' on purpose — with no probe coverage yet,
-- claiming 'operational' would be exactly the "absence of evidence reported as
-- uptime" failure this project exists to avoid.
INSERT OR IGNORE INTO page (public_id, slug, name, snapshot_version, created_at, updated_at)
VALUES ('01K7M0ALLCCLEARPAGE000000', 'example', 'Example Service', 1, 1760000000, 1760000000);

INSERT OR IGNORE INTO component (public_id, page_id, name, status, available_since, order_id, created_at, updated_at)
SELECT '01K7M0ALLCCLEARCOMPAPI000', id, 'API',             'unknown', 1760000000, 1, 1760000000, 1760000000 FROM page WHERE slug = 'example';
INSERT OR IGNORE INTO component (public_id, page_id, name, status, available_since, order_id, created_at, updated_at)
SELECT '01K7M0ALLCCLEARCOMPWEB000', id, 'Website',         'unknown', 1760000000, 2, 1760000000, 1760000000 FROM page WHERE slug = 'example';
INSERT OR IGNORE INTO component (public_id, page_id, name, status, available_since, order_id, created_at, updated_at)
SELECT '01K7M0ALLCCLEARCOMPMOB000', id, 'Mobile web',      'unknown', 1760000000, 3, 1760000000, 1760000000 FROM page WHERE slug = 'example';
INSERT OR IGNORE INTO component (public_id, page_id, name, status, available_since, order_id, created_at, updated_at)
SELECT '01K7M0ALLCCLEARCOMPDL0000', id, 'Download server', 'unknown', 1760000000, 4, 1760000000, 1760000000 FROM page WHERE slug = 'example';
