-- Migration: referral program. A client can be referred by another client;
-- each referral earns the referrer one free-month credit. Credits auto-apply at
-- the referrer's next bill (the cron records a Ksh 0 "Free month (referral)"
-- payment, rolls next_due forward a month, and decrements the credit).
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/013_referrals.sql

ALTER TABLE clients ADD COLUMN referred_by INTEGER;
ALTER TABLE clients ADD COLUMN free_months INTEGER NOT NULL DEFAULT 0;
