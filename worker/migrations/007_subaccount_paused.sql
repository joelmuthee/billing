-- Migration: track GHL subaccount pause separately from billing status
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/007_subaccount_paused.sql

-- The date the client's GHL subaccount was paused for non-payment, or null.
-- This is independent of `status` — a paused-subaccount client stays
-- status='active' so they remain in the overdue list (they still owe).
-- Cleared automatically when a payment is recorded (service resumes).
ALTER TABLE clients ADD COLUMN subaccount_paused TEXT;
