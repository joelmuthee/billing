-- Migration: demo prospects pipeline.
-- Leads who asked for a demo but haven't committed. Separate from clients
-- (no plan, no billing) so the clients table and its KPIs stay clean.
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/009_prospects.sql

CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business TEXT,
  phone TEXT,
  email TEXT,
  demo_url TEXT,
  stage TEXT NOT NULL DEFAULT 'requested' CHECK (stage IN ('requested','demo_sent','won','lost')),
  followup_date TEXT,
  notes TEXT,
  converted_client_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);
CREATE INDEX IF NOT EXISTS idx_prospects_followup ON prospects(followup_date);
