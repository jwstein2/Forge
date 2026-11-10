-- Migration 0004: FORGE Intelligence storage and Builder records.
-- Content schemas (brief, scoring model, opportunity, Launch Blueprint) are owned by their workstreams as JSON Schema;
-- this database stores whole versioned documents with a content hash.

CREATE TABLE market_briefs (
  id             TEXT PRIMARY KEY,
  niche_id       TEXT NOT NULL,                       -- may name a not-yet-approved niche slug
  version        TEXT NOT NULL,                       -- semver
  schema_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('draft','approved','superseded')),
  content_json   TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  approved_by    TEXT,
  UNIQUE (niche_id, version)
);

CREATE TABLE scoring_models (
  id           TEXT PRIMARY KEY,
  version      TEXT NOT NULL UNIQUE,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at   TEXT NOT NULL
);

CREATE TABLE research_runs (
  id                       TEXT PRIMARY KEY,
  kind                     TEXT NOT NULL,             -- 'scout' | 'brief_refresh' | 'competitor_scan' ...
  started_at               TEXT NOT NULL,
  finished_at              TEXT,
  status                   TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','partial')),
  sources_unconnected_json TEXT NOT NULL DEFAULT '[]',
  job_id                   TEXT REFERENCES jobs(id),
  cost_cents               REAL
);

CREATE TABLE opportunities (
  id                    TEXT PRIMARY KEY,
  opportunity_key       TEXT NOT NULL,
  title                 TEXT NOT NULL,
  score                 REAL,
  rank                  INTEGER,
  recommended           INTEGER NOT NULL DEFAULT 0 CHECK (recommended IN (0,1)),
  scoring_model_version TEXT REFERENCES scoring_models(version),
  brief_ref             TEXT REFERENCES market_briefs(id),
  run_id                TEXT REFERENCES research_runs(id),
  status                TEXT NOT NULL CHECK (status IN ('candidate','recommended','selected','rejected','archived')),
  content_json          TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
-- at most one strongest recommendation per research run
CREATE UNIQUE INDEX uq_opportunity_recommended_per_run ON opportunities(run_id) WHERE recommended = 1;

CREATE TABLE launch_blueprints (
  id             TEXT PRIMARY KEY,
  niche_id       TEXT NOT NULL,
  version        TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('draft','approved','superseded')),
  brief_ref      TEXT REFERENCES market_briefs(id),
  content_json   TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  approved_by    TEXT,
  UNIQUE (niche_id, version)
);

CREATE TABLE builds (
  id             TEXT PRIMARY KEY,
  niche_id       TEXT,
  opportunity_id TEXT REFERENCES opportunities(id),
  title          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('draft','running','blocked','awaiting_approval','complete','cancelled')),
  blueprint_ref  TEXT REFERENCES launch_blueprints(id),
  budget_cents   INTEGER,
  approval_id    TEXT REFERENCES approvals(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE build_stages (
  build_id   TEXT NOT NULL REFERENCES builds(id),
  stage      TEXT NOT NULL CHECK (stage IN ('research','blueprint','products','brand','website','integrations','marketing','testing','launch_readiness')),
  status     TEXT NOT NULL CHECK (status IN ('not_started','running','blocked','failed','passed')),
  job_id     TEXT REFERENCES jobs(id),
  cost_cents REAL NOT NULL DEFAULT 0,
  notes      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (build_id, stage)
);
