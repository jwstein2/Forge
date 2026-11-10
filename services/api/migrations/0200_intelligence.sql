-- FORGE Intelligence (workstream B). Copied into services/api/migrations by the platform workstream.
-- Evidence packs submitted to the Opportunity Scout, and the result of re-fetching every cited source.

CREATE TABLE IF NOT EXISTS research_packs (
  id           TEXT PRIMARY KEY,                 -- pack_...
  label        TEXT NOT NULL,
  content_json TEXT NOT NULL,                    -- the whole evidence pack (candidates, claims, sources, briefs)
  content_hash TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_source_checks (
  id                  TEXT PRIMARY KEY,          -- rsc_...
  run_id              TEXT NOT NULL,             -- research_runs.id
  source_id           TEXT NOT NULL,             -- src_... as cited in the pack
  url                 TEXT NOT NULL,
  checked_at          TEXT NOT NULL,
  http_status         INTEGER,
  outcome             TEXT NOT NULL CHECK (outcome IN ('confirmed','reachable','mismatch','dead','unreachable','skipped')),
  matched_expectation INTEGER,                   -- 1 every expected string found, 0 some missing, NULL no expectation given
  missing_json        TEXT NOT NULL DEFAULT '[]',
  job_id              TEXT,
  UNIQUE (run_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_rsc_run ON research_source_checks(run_id);

CREATE TABLE IF NOT EXISTS research_signals (
  id           TEXT PRIMARY KEY,                 -- sig_...
  run_id       TEXT NOT NULL,
  candidate    TEXT NOT NULL,                    -- opportunity_key
  connector    TEXT NOT NULL,                    -- e.g. wikimedia_pageviews
  subject      TEXT NOT NULL,                    -- e.g. article title
  status       TEXT NOT NULL CHECK (status IN ('collected','unavailable','unconnected')),
  points_json  TEXT NOT NULL DEFAULT '[]',       -- [{period, value}]
  summary_json TEXT NOT NULL DEFAULT '{}',
  collected_at TEXT NOT NULL,
  UNIQUE (run_id, candidate, connector, subject)
);

CREATE TABLE IF NOT EXISTS research_run_reports (
  run_id      TEXT PRIMARY KEY,                  -- research_runs.id
  pack_id     TEXT,
  report_json TEXT NOT NULL,                     -- downgrades, source outcomes, signal status, ranking, stored ids
  created_at  TEXT NOT NULL
);
