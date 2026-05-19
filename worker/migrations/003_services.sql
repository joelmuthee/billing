-- Migration: add services column to clients
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/003_services.sql

ALTER TABLE clients ADD COLUMN services TEXT NOT NULL DEFAULT '[]';
