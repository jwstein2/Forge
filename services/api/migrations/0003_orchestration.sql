-- Migration 0003: durable jobs, steps, checkpoints and events (orchestration model).
-- A job survives the session that created it: state lives here, workers claim jobs with a lease,
-- every step checkpoints, retries are bounded, and a global/niche/registry pause is checked before work.

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,                     -- handler name, e.g. 'ledger.sync', 'heartbeat.watchdog'
  niche_id         TEXT REFERENCES niches(id),
  registry_id      TEXT REFERENCES registry_entries(id),
  status           TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled','paused')),
  priority         INTEGER NOT NULL DEFAULT 100,
  idempotency_key  TEXT UNIQUE,
  input_json       TEXT NOT NULL DEFAULT '{}',
  output_json      TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_run_at      TEXT NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  cost_cap_cents   INTEGER,
  cost_cents       REAL NOT NULL DEFAULT 0,
  approval_id      TEXT REFERENCES approvals(id),
  parent_id        TEXT REFERENCES jobs(id),
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON jobs(status, next_run_at, priority);

CREATE TABLE job_steps (
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  seq             INTEGER NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  checkpoint_json TEXT,                               -- output of a succeeded step; replayed, not re-executed, on resume
  error           TEXT,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE job_dependencies (
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  depends_on_id TEXT NOT NULL REFERENCES jobs(id),
  PRIMARY KEY (job_id, depends_on_id),
  CHECK (job_id <> depends_on_id)
);

CREATE TABLE job_events (
  id       TEXT PRIMARY KEY,
  job_id   TEXT NOT NULL REFERENCES jobs(id),
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,                             -- 'enqueued','claimed','step_succeeded','retry_scheduled','failed','succeeded','paused','lease_expired'
  detail   TEXT
);
CREATE INDEX idx_job_events_job ON job_events(job_id, at);
