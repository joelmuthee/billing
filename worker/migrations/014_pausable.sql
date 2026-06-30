-- 014_pausable.sql
-- Per-client toggle for the Pause/Resume button on the overdue card. Default 1
-- (show). Set to 0 to hide it for clients there's nothing to pause for — e.g.
-- retainer/SEO clients with no GHL subaccount kill-switch and no catalog site.
-- (Services like "crm" alone can't distinguish these, so it's a manual flag.)
ALTER TABLE clients ADD COLUMN pausable INTEGER DEFAULT 1;

-- Hide it for Opiyo (3, Opentech Global) and St. Christopher's (5).
UPDATE clients SET pausable = 0 WHERE id IN (3, 5);
