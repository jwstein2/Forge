-- 0006: fixes from independent QA (QA-002).
-- R7: record whether each site has a funnel beacon, so a site without one shows page views as unconnected.
ALTER TABLE niches ADD COLUMN beacon TEXT NOT NULL DEFAULT 'unknown' CHECK (beacon IN ('prefix','shared_root','none','unknown'));

-- R5: the vault link must be a 1Password link (CHECK constraints cannot be altered in SQLite, so triggers enforce it).
CREATE TRIGGER accounts_pm_ref_insert BEFORE INSERT ON accounts
WHEN NEW.password_manager_ref IS NOT NULL
 AND NEW.password_manager_ref NOT LIKE 'onepassword://%'
 AND NEW.password_manager_ref NOT LIKE 'https://start.1password.com/%'
 AND NEW.password_manager_ref NOT LIKE 'https://%.1password.com/%'
BEGIN SELECT RAISE(ABORT, 'password_manager_ref must be a 1Password link'); END;
CREATE TRIGGER accounts_pm_ref_update BEFORE UPDATE OF password_manager_ref ON accounts
WHEN NEW.password_manager_ref IS NOT NULL
 AND NEW.password_manager_ref NOT LIKE 'onepassword://%'
 AND NEW.password_manager_ref NOT LIKE 'https://start.1password.com/%'
 AND NEW.password_manager_ref NOT LIKE 'https://%.1password.com/%'
BEGIN SELECT RAISE(ABORT, 'password_manager_ref must be a 1Password link'); END;
