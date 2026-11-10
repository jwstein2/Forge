-- FORGE platform database, migration 0001: core portfolio, registry, evidence, alerts.
-- Target: Cloudflare D1 (SQLite). Applied to LOCAL and STAGING only until the owner approves production.
-- This database is separate from the live sales ledger (D1 "quiltplankit-sales"), which FORGE reads, never writes.
-- Conventions: text ids, ISO 8601 UTC timestamps, money in integer cents, tenant_id reserved for future SaaS.

PRAGMA foreign_keys = ON;

CREATE TABLE niches (
  id            TEXT PRIMARY KEY,                    -- 'bidline' | 'quilt-plan-kit' | 'loaf-ledger'
  tenant_id     TEXT NOT NULL DEFAULT 'owner',
  name          TEXT NOT NULL,
  tagline       TEXT,
  positioning   TEXT,
  lifecycle     TEXT NOT NULL CHECK (lifecycle IN ('proposed','building','live','paused','retired')),
  site_url      TEXT,
  pages_project TEXT,
  ledger_vertical TEXT,                              -- value of sales.vertical in the live ledger
  event_path_prefix TEXT,                            -- events.path prefix used by this site's beacon (null = root / ambiguous)
  paused        INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE products (
  id                   TEXT PRIMARY KEY,
  niche_id             TEXT NOT NULL REFERENCES niches(id),
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('spreadsheet','pdf','calculator','guide','book','template','software','other')),
  tier                 TEXT NOT NULL CHECK (tier IN ('free','paid')),
  site_price_cents     INTEGER,
  checkout_price_cents INTEGER,
  ledger_product_name  TEXT,
  status               TEXT NOT NULL CHECK (status IN ('PROPOSED','BUILT','TESTED','LIVE','FAILED','UNVERIFIED')),
  checkout_status      TEXT NOT NULL CHECK (checkout_status IN ('none','test_mode','live','unknown')),
  delivery_status      TEXT NOT NULL CHECK (delivery_status IN ('verified','unverified','failed','n/a')),
  file_sha256          TEXT,
  notes                TEXT,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_products_niche ON products(niche_id);

-- Registry of every agent, workflow, scheduled task and worker FORGE knows about.
CREATE TABLE registry_entries (
  id               TEXT PRIMARY KEY,                 -- 'N8N-02', 'AG-03', 'CF-02' ...
  kind             TEXT NOT NULL CHECK (kind IN ('agent','workflow','scheduled_task','worker','skill','manual_tool')),
  name             TEXT NOT NULL,
  niche_id         TEXT REFERENCES niches(id),
  department       TEXT,
  owner            TEXT,
  runner           TEXT NOT NULL CHECK (runner IN ('n8n','claude','cloudflare','github_actions','forge','manual')),
  external_ref     TEXT,
  trigger_desc     TEXT,
  cadence          TEXT,
  interval_minutes INTEGER,
  model            TEXT,
  cost_cap_cents   INTEGER,
  retry_budget     INTEGER,
  permissions_json TEXT,
  status           TEXT NOT NULL CHECK (status IN ('PROPOSED','BUILT','TESTED','LIVE','FAILED','UNVERIFIED')),
  paused           INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  pausable         INTEGER NOT NULL DEFAULT 0 CHECK (pausable IN (0,1)),
  defects_json     TEXT NOT NULL DEFAULT '[]',
  defined_in       TEXT,
  notes            TEXT,
  updated_at       TEXT NOT NULL
);

-- Observed executions (heartbeats). Only written from real evidence: platform execution records or signed heartbeats.
CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  registry_id      TEXT NOT NULL REFERENCES registry_entries(id),
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('success','failed','running','timeout','skipped')),
  evidence_url     TEXT,
  model_cost_cents INTEGER,
  error            TEXT,
  source           TEXT NOT NULL,                    -- 'n8n.snapshot' | 'n8n.live' | 'heartbeat' | 'forge'
  external_id      TEXT,
  UNIQUE (source, external_id)
);
CREATE INDEX idx_runs_registry_started ON runs(registry_id, started_at DESC);

CREATE TABLE channels (
  id                TEXT PRIMARY KEY,
  niche_id          TEXT NOT NULL REFERENCES niches(id),
  platform          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('configured','running','verified','failing','unconnected')),
  cadence           TEXT,
  account_url       TEXT,
  last_verified_at  TEXT,
  last_verified_url TEXT,
  registry_id       TEXT REFERENCES registry_entries(id),
  notes             TEXT,
  updated_at        TEXT NOT NULL,
  -- a channel may only be 'verified' when there is a verified publication on record
  CHECK (status <> 'verified' OR (last_verified_at IS NOT NULL AND last_verified_url IS NOT NULL))
);

CREATE TABLE integrations (
  id              TEXT PRIMARY KEY,
  service         TEXT NOT NULL,
  niche_id        TEXT REFERENCES niches(id),
  purpose         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('connected','unconnected','degraded','failed','unknown')),
  access_mode     TEXT NOT NULL CHECK (access_mode IN ('read_only','test','write','none')),
  last_checked_at TEXT,
  last_ok_at      TEXT,
  detail          TEXT,
  blocker         TEXT,
  updated_at      TEXT NOT NULL
);

-- Account directory. Deliberately has NO password / secret column. passwords live in the password manager.
CREATE TABLE accounts (
  id                   TEXT PRIMARY KEY,
  service              TEXT NOT NULL,
  niche_id             TEXT REFERENCES niches(id),
  identifier           TEXT,
  status               TEXT NOT NULL CHECK (status IN ('active','pending','test_mode','unknown','not_created')),
  url                  TEXT,
  password_manager_ref TEXT CHECK (password_manager_ref IS NULL OR password_manager_ref LIKE '%://%'),
  owner                TEXT NOT NULL DEFAULT 'James',
  notes                TEXT,
  updated_at           TEXT NOT NULL
);

CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  claim        TEXT NOT NULL,
  label        TEXT NOT NULL CHECK (label IN ('PROPOSED','BUILT','TESTED','LIVE','FAILED','UNVERIFIED','VERIFIED','ESTIMATED','INFERRED','UNKNOWN')),
  source       TEXT NOT NULL,
  url          TEXT,
  observed_at  TEXT NOT NULL,
  collected_by TEXT NOT NULL,
  content_hash TEXT
);
CREATE INDEX idx_evidence_subject ON evidence(subject_type, subject_id);

-- Every status change is recorded. Promotions to TESTED or LIVE must cite evidence (enforced below and in the API).
CREATE TABLE status_history (
  id           TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  evidence_id  TEXT REFERENCES evidence(id),
  changed_by   TEXT NOT NULL,
  changed_at   TEXT NOT NULL,
  CHECK (to_status NOT IN ('TESTED','LIVE') OR evidence_id IS NOT NULL)
);

CREATE TABLE alerts (
  id           TEXT PRIMARY KEY,
  severity     TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  niche_id     TEXT REFERENCES niches(id),
  source       TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  state        TEXT NOT NULL CHECK (state IN ('open','acknowledged','resolved')),
  dedupe_key   TEXT NOT NULL UNIQUE,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  next_action  TEXT,
  evidence_url TEXT
);
CREATE INDEX idx_alerts_state ON alerts(state, severity);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  action        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  requested_by  TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT,
  boundary_json TEXT,
  source_ref    TEXT,
  expires_at    TEXT,
  created_at    TEXT NOT NULL,
  -- only the owner decides consequential approvals
  CHECK (status = 'pending' OR status = 'expired' OR decided_by = 'owner')
);

CREATE TABLE gate_receipts (
  id            TEXT PRIMARY KEY,
  release_id    TEXT NOT NULL,
  gate          TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('PASS','FAIL','NOT_RUN','BLOCKED')),
  reviewer      TEXT NOT NULL,
  producer      TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  rollback      TEXT,
  created_at    TEXT NOT NULL,
  CHECK (reviewer <> producer)                       -- no self-certification
);

CREATE TABLE system_controls (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id       TEXT PRIMARY KEY,
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  subject  TEXT,
  detail   TEXT,
  at       TEXT NOT NULL
);
