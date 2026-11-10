-- Migration 0005: mark alerts that genuinely need the owner (consequential decisions), so Command
-- never infers it from free text. Additive only.
ALTER TABLE alerts ADD COLUMN needs_owner INTEGER NOT NULL DEFAULT 0 CHECK (needs_owner IN (0,1));
