-- Migration 0100 (FORGE Operator, workstream E). Applies after the platform migrations 0001-00xx.
-- Owned by packages/operator. All tables are prefixed op_ so they never collide with platform tables.
-- Nothing here writes to the live sales ledger or to any external system.

-- Declarative recurring schedules. The cron tick asks "which slots are due?" and enqueues one job per
-- (schedule, slot) with an idempotency key, so a missed tick never double-runs and never back-fills a storm.
CREATE TABLE op_schedules (
  id                 TEXT PRIMARY KEY,                -- 'OPS-SITE-HEALTH' etc. (also its registry id)
  kind               TEXT NOT NULL,                   -- job handler kind
  registry_id        TEXT REFERENCES registry_entries(id),
  niche_id           TEXT REFERENCES niches(id),
  spec_json          TEXT NOT NULL,                   -- {"every":60} | {"daily":"13:00"} | {"weekly":{"day":1,"at":"13:00"}} | {"monthly":{"day":1,"at":"14:00"}}
  input_json         TEXT NOT NULL DEFAULT '{}',
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  max_attempts       INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  cost_cap_cents     INTEGER,
  last_slot          TEXT,                            -- last slot enqueued (ISO minute)
  last_job_id        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- Results of deterministic checks (site health, SEO). One row per target per run.
CREATE TABLE op_checks (
  id           TEXT PRIMARY KEY,
  check_kind   TEXT NOT NULL CHECK (check_kind IN ('site_health','seo_page','seo_site','pin_queue','publication_verify')),
  niche_id     TEXT REFERENCES niches(id),
  target       TEXT NOT NULL,                         -- URL checked
  ok           INTEGER NOT NULL CHECK (ok IN (0,1)),
  status_code  INTEGER,
  latency_ms   INTEGER,
  findings_json TEXT NOT NULL DEFAULT '[]',           -- [{code, severity, message}]
  job_id       TEXT,
  checked_at   TEXT NOT NULL
);
CREATE INDEX idx_op_checks_kind_time ON op_checks(check_kind, checked_at DESC);
CREATE INDEX idx_op_checks_target ON op_checks(target, checked_at DESC);

-- Channel publishing policy. Default is draft_only: FORGE prepares content but never publishes.
-- 'standing' means routine publishing inside an owner-approved boundary (approval row required),
-- which is how the constitution's "documented owner-approved boundaries" is enforced in code.
CREATE TABLE op_channel_policies (
  channel_id     TEXT PRIMARY KEY REFERENCES channels(id),
  mode           TEXT NOT NULL CHECK (mode IN ('off','draft_only','approval_each','standing')),
  publisher      TEXT NOT NULL DEFAULT 'dry_run',     -- adapter id; live adapters are not built until approved
  daily_cap      INTEGER NOT NULL DEFAULT 1 CHECK (daily_cap BETWEEN 0 AND 50),
  approval_id    TEXT REFERENCES approvals(id),       -- required for 'standing'
  window_end     TEXT,                                -- standing authority expires here (ISO); null = until revoked
  notes          TEXT,
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (mode <> 'standing' OR approval_id IS NOT NULL)
);

-- Content pipeline: planned → drafted → approved → published → verified.
-- 'verified' requires a receipt URL and time from the platform itself (never self-reported).
CREATE TABLE op_content_items (
  id             TEXT PRIMARY KEY,
  niche_id       TEXT NOT NULL REFERENCES niches(id),
  channel_id     TEXT REFERENCES channels(id),
  platform       TEXT NOT NULL,                       -- 'pinterest' | 'email' | 'seo' | 'instagram' | ...
  plan_key       TEXT NOT NULL UNIQUE,                -- idempotency: niche|event|asset|platform|year
  title          TEXT NOT NULL,
  season_event   TEXT,
  brief_ref      TEXT,                                -- brief_id@version the item was planned from
  evidence_label TEXT NOT NULL CHECK (evidence_label IN ('VERIFIED','ESTIMATED','INFERRED','UNKNOWN')),
  publish_by     TEXT,                                -- ISO date
  window_start   TEXT,
  window_end     TEXT,
  late           INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0,1)),
  status         TEXT NOT NULL CHECK (status IN ('planned','drafted','needs_revision','approved','published','verified','failed','rejected','expired')),
  body_json      TEXT,                                -- drafted copy {headline, body, cta, link}
  lint_json      TEXT NOT NULL DEFAULT '[]',          -- claims-lint findings
  approval_id    TEXT REFERENCES approvals(id),
  publisher      TEXT,
  external_url   TEXT,                                -- receipt from the platform
  published_at   TEXT,
  verified_at    TEXT,
  note           TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (status <> 'verified' OR (external_url IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (status NOT IN ('published','verified') OR published_at IS NOT NULL)
);
CREATE INDEX idx_op_content_status ON op_content_items(status, publish_by);

-- Observed publications (receipts), e.g. items seen in a platform RSS feed. Source of channel verification.
CREATE TABLE op_publications (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels(id),
  niche_id     TEXT REFERENCES niches(id),
  external_url TEXT NOT NULL,
  title        TEXT,
  published_at TEXT,
  observed_at  TEXT NOT NULL,
  source       TEXT NOT NULL,                         -- 'site_feed' (our feed, not proof of platform post) | 'platform_feed' | 'platform_api'
  content_id   TEXT REFERENCES op_content_items(id),
  UNIQUE (channel_id, external_url)
);

-- Bounded model calls (FORGE's LLM steps). Every attempt is recorded with its cost.
CREATE TABLE op_llm_calls (
  id            TEXT PRIMARY KEY,
  job_id        TEXT,
  purpose       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT,
  attempt       INTEGER NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_cents    REAL NOT NULL DEFAULT 0,
  valid         INTEGER NOT NULL CHECK (valid IN (0,1)),
  error         TEXT,
  at            TEXT NOT NULL
);

-- Weekly in-app operational summaries (never emailed).
CREATE TABLE op_summaries (
  id            TEXT PRIMARY KEY,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  body_json     TEXT NOT NULL,
  job_id        TEXT,
  UNIQUE (period_start, period_end)
);
