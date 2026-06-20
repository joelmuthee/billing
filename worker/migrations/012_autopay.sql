-- Migration: mark a recurring expense as autopay (charged automatically to a
-- card each cycle). The daily cron records the payment on the due day and rolls
-- next_due forward, so the owner never has to click Pay for it.
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/012_autopay.sql

ALTER TABLE expenses ADD COLUMN autopay INTEGER NOT NULL DEFAULT 0;
