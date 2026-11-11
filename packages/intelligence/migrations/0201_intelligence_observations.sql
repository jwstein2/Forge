-- FORGE Intelligence round 2. Copied into services/api/migrations by the platform workstream.
-- Source observations made outside the Worker's own HTTP re-check:
--   assisted_fetch  an analyst session re-read the page at human volume (e.g. Etsy listings, which return 403 to the Worker)
--   etsy_open_api   the official Etsy Open API (only once the owner approves a free developer key)
--   owner_check     the owner looked at the page
-- The Scout uses the latest observation no older than 45 days in place of an unreachable or skipped check.
CREATE TABLE IF NOT EXISTS research_source_observations (
  id            TEXT PRIMARY KEY,                -- rso_...
  url           TEXT NOT NULL,
  observed_at   TEXT NOT NULL,                   -- ISO UTC
  observed_by   TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('assisted_fetch','etsy_open_api','owner_check')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('confirmed','reachable','mismatch','dead')),
  figures_json  TEXT NOT NULL DEFAULT '{}',      -- what was read, e.g. {"price":"7.05","item_reviews":27}
  missing_json  TEXT NOT NULL DEFAULT '[]',
  note          TEXT,
  content_hash  TEXT NOT NULL UNIQUE,            -- dedupes re-seeding from git
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rso_url ON research_source_observations(url, observed_at);
