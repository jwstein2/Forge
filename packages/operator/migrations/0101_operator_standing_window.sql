-- Migration 0101 (FORGE Operator): a standing publishing approval must have an end date (QA-005 V3).
-- 0100 is already applied on staging, so this is enforced with triggers rather than by editing 0100's CHECK.
CREATE TRIGGER op_policy_standing_window_insert BEFORE INSERT ON op_channel_policies
WHEN NEW.mode = 'standing' AND NEW.window_end IS NULL
BEGIN SELECT RAISE(ABORT, 'standing policy requires window_end'); END;
CREATE TRIGGER op_policy_standing_window_update BEFORE UPDATE ON op_channel_policies
WHEN NEW.mode = 'standing' AND NEW.window_end IS NULL
BEGIN SELECT RAISE(ABORT, 'standing policy requires window_end'); END;
