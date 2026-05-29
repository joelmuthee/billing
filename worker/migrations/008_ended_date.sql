-- Migration: track when a client/expense ended, so churn/cancel doesn't erase
-- their historical accrual contribution.
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/008_ended_date.sql

-- The date a client churned (or an expense was cancelled). When set, the entity
-- counts as active in accrual from start_date THROUGH ended_date, then stops.
-- Null = still running (use status for current state).
ALTER TABLE clients ADD COLUMN ended_date TEXT;
ALTER TABLE expenses ADD COLUMN ended_date TEXT;
