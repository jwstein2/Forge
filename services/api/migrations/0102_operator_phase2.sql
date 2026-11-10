-- FORGE Operator phase 2 (workstream E).
-- 1. op_checks.ok may be NULL = UNKNOWN: FORGE could not run the check (e.g. Worker subrequest limit), so the
--    target's state is unknown, never "down" (QA-008 ST1). Adds check kinds for lifecycle and heartbeats.
-- 2. Lifecycle snapshots (MailerLite groups, forms, automations), read-only.
-- 3. Optimization recommendations: proposals only, never applied automatically.

CREATE TABLE op_checks_v2 (
  id           TEXT PRIMARY KEY,
  check_kind   TEXT NOT NULL CHECK (check_kind IN ('site_health','seo_page','seo_site','pin_queue','publication_verify','lifecycle')),
  niche_id     TEXT REFERENCES niches(id),
  target       TEXT NOT NULL,
  ok           INTEGER CHECK (ok IS NULL OR ok IN (0,1)),   -- NULL = unknown (checker could not run)
  status_code  INTEGER,
  latency_ms   INTEGER,
  findings_json TEXT NOT NULL DEFAULT '[]',
  job_id       TEXT,
  checked_at   TEXT NOT NULL
);
INSERT INTO op_checks_v2 (id,check_kind,niche_id,target,ok,status_code,latency_ms,findings_json,job_id,checked_at)
  SELECT id,check_kind,niche_id,target,ok,status_code,latency_ms,findings_json,job_id,checked_at FROM op_checks;
DROP INDEX IF EXISTS idx_op_checks_kind_time;
DROP INDEX IF EXISTS idx_op_checks_target;
DROP TABLE op_checks;
ALTER TABLE op_checks_v2 RENAME TO op_checks;
CREATE INDEX idx_op_checks_kind_time ON op_checks(check_kind, checked_at DESC);
CREATE INDEX idx_op_checks_target ON op_checks(target, checked_at DESC);
CREATE INDEX idx_op_checks_job ON op_checks(job_id);

-- One row per lifecycle watch run. state: live (read from MailerLite) | unconnected (no API key).
CREATE TABLE op_lifecycle_snapshots (
  id            TEXT PRIMARY KEY,
  taken_at      TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('live','unconnected','error')),
  source        TEXT NOT NULL,                 -- 'mailerlite.api' | 'none'
  groups_json   TEXT NOT NULL DEFAULT '[]',    -- [{id,name,nicheId,active,unconfirmed,unsubscribed,bounced,junk}]
  forms_json    TEXT NOT NULL DEFAULT '[]',    -- [{id,name,nicheId,active,opens,conversions}]
  automations_json TEXT NOT NULL DEFAULT '[]', -- [{id,name,nicheId,sequence,status,sent}]
  error         TEXT,
  job_id        TEXT
);
CREATE INDEX idx_op_lifecycle_time ON op_lifecycle_snapshots(taken_at DESC);

-- Weekly optimization loop output. FORGE proposes; the owner (or an approved policy) decides.
CREATE TABLE op_recommendations (
  id            TEXT PRIMARY KEY,
  niche_id      TEXT REFERENCES niches(id),
  rule          TEXT NOT NULL,                 -- stable rule id, e.g. 'welcome_not_live'
  dedupe_key    TEXT NOT NULL UNIQUE,          -- rule + niche + ISO week
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  action        TEXT NOT NULL,                 -- what would change, in plain words
  evidence_json TEXT NOT NULL,                 -- the numbers the rule used, with their source and period
  evidence_label TEXT NOT NULL CHECK (evidence_label IN ('VERIFIED','INFERRED','UNKNOWN')),
  impact        TEXT NOT NULL CHECK (impact IN ('high','medium','low')),
  status        TEXT NOT NULL CHECK (status IN ('proposed','accepted','dismissed','done','expired')) DEFAULT 'proposed',
  needs_owner   INTEGER NOT NULL DEFAULT 0 CHECK (needs_owner IN (0,1)),
  job_id        TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT
);
CREATE INDEX idx_op_reco_status ON op_recommendations(status, created_at DESC);
