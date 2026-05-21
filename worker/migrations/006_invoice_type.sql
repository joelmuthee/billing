-- Migration: decouple invoice type from reminder method + track send date
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/006_invoice_type.sql

-- How this client is invoiced, independent of how they're reminded.
-- 'kra'     = raised through the KRA eTIMS portal
-- 'regular' = standard invoice (emailed / handed over)
-- 'none'    = no invoice needed (cash, informal)
ALTER TABLE clients ADD COLUMN invoice_type TEXT NOT NULL DEFAULT 'regular';

-- The actual date the invoice was raised (for display). Distinct from
-- invoice_sent_for_next_due, which stores the next_due value for staleness.
ALTER TABLE clients ADD COLUMN invoice_sent_date TEXT;

-- Backfill the known KRA-invoiced clients
UPDATE clients SET invoice_type = 'kra'
WHERE name IN ('OnePlumbing', 'Rajshyn Jewellers', 'St. Christopher''s');
