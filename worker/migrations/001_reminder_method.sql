-- Migration: add reminder_method + email to clients
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/001_reminder_method.sql

ALTER TABLE clients ADD COLUMN reminder_method TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE clients ADD COLUMN email TEXT;
