-- Migration 0002: financial events, costs and budgets (per-niche P&L, constitution §11).

CREATE TABLE financial_events (
  id           TEXT PRIMARY KEY,
  niche_id     TEXT REFERENCES niches(id),           -- null only when the ledger could not attribute it ('unknown' vertical)
  kind         TEXT NOT NULL CHECK (kind IN ('sale','refund','discount','payment_fee','tax','payout','adjustment')),
  amount_cents INTEGER NOT NULL,                      -- positive numbers; kind gives direction
  currency     TEXT NOT NULL DEFAULT 'USD',
  occurred_at  TEXT NOT NULL,
  product_name TEXT,
  order_ref    TEXT,
  test_mode    INTEGER NOT NULL CHECK (test_mode IN (0,1)),
  owner_test   INTEGER NOT NULL DEFAULT 0 CHECK (owner_test IN (0,1)), -- owner's own verification purchase: excluded from revenue
  source       TEXT NOT NULL,                         -- 'ledger.d1' | 'lemonsqueezy' | 'kdp' | 'manual'
  source_ref   TEXT NOT NULL,
  utm_source   TEXT,
  utm_campaign TEXT,
  imported_at  TEXT NOT NULL,
  UNIQUE (source, source_ref)
);
CREATE INDEX idx_fin_niche_time ON financial_events(niche_id, occurred_at);

CREATE TABLE cost_items (
  id              TEXT PRIMARY KEY,
  niche_id        TEXT REFERENCES niches(id),         -- null = shared cost
  category        TEXT NOT NULL CHECK (category IN ('hosting_software','ai_usage','marketing','product','payment','domain','other')),
  vendor          TEXT NOT NULL,
  item            TEXT NOT NULL,
  amount_cents    INTEGER,                             -- null = unknown (shown as a missing line, never as $0)
  cadence         TEXT NOT NULL CHECK (cadence IN ('monthly','annual','one_time','usage')),
  evidence        TEXT NOT NULL CHECK (evidence IN ('VERIFIED','ESTIMATED','INFERRED','UNKNOWN')),
  allocation_rule TEXT,
  starts_on       TEXT,
  ends_on         TEXT,
  notes           TEXT,
  updated_at      TEXT NOT NULL,
  CHECK (amount_cents IS NOT NULL OR evidence = 'UNKNOWN')
);

CREATE TABLE budgets (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  ceiling_cents  INTEGER NOT NULL,
  approved_cents INTEGER NOT NULL,
  spent_cents    INTEGER NOT NULL,
  evidence       TEXT NOT NULL CHECK (evidence IN ('VERIFIED','ESTIMATED','INFERRED','UNKNOWN')),
  notes          TEXT,
  updated_at     TEXT NOT NULL,
  CHECK (approved_cents <= ceiling_cents)
);

-- Funnel counters imported from the ledger's anonymous daily events table.
CREATE TABLE funnel_daily (
  day        TEXT NOT NULL,
  niche_id   TEXT REFERENCES niches(id),             -- null = could not attribute (root '/' paths are shared by sites today)
  event      TEXT NOT NULL,
  path       TEXT NOT NULL,
  source     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  is_test    INTEGER NOT NULL CHECK (is_test IN (0,1)),
  imported_at TEXT NOT NULL,
  PRIMARY KEY (day, event, path, source)
);

-- Usage and spend telemetry for model calls and external APIs (Milestone 3 fills this from real runs).
CREATE TABLE usage_records (
  id          TEXT PRIMARY KEY,
  niche_id    TEXT REFERENCES niches(id),
  job_id      TEXT,
  run_id      TEXT,
  provider    TEXT NOT NULL,
  model       TEXT,
  units       REAL NOT NULL,
  unit_kind   TEXT NOT NULL,                          -- 'input_tokens' | 'output_tokens' | 'requests' | 'executions'
  cost_cents  REAL,
  evidence    TEXT NOT NULL CHECK (evidence IN ('VERIFIED','ESTIMATED','INFERRED','UNKNOWN')),
  at          TEXT NOT NULL
);
