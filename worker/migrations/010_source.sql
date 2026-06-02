-- Migration: lead source + acquisition date on clients and prospects.
-- "How did I find them" (Instagram / WhatsApp / Referral / ...) plus the date
-- they first came in. Free text so "Referral from Betty" works.
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/010_source.sql

ALTER TABLE clients ADD COLUMN source TEXT;
ALTER TABLE clients ADD COLUMN source_date TEXT;
ALTER TABLE prospects ADD COLUMN source TEXT;
ALTER TABLE prospects ADD COLUMN source_date TEXT;
