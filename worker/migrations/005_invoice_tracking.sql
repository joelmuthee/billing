-- Migration: track whether an invoice has been raised for each upcoming payment
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/005_invoice_tracking.sql

-- For recurring clients: stores the next_due date that an invoice has been raised
-- for. When this matches the current next_due, the invoice for this cycle is sent.
-- When the worker bumps next_due (after a payment), the field naturally goes
-- stale, automatically resetting "invoice status" to unsent for the new cycle.
ALTER TABLE clients ADD COLUMN invoice_sent_for_next_due TEXT;

-- For one-off staged payments: just a date stamp.
ALTER TABLE scheduled_payments ADD COLUMN invoice_sent_on TEXT;
