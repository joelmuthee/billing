-- Migration: upsell tracking + scheduled payments
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/004_upsell_and_scheduled.sql

ALTER TABLE clients ADD COLUMN upsell_notes TEXT;
ALTER TABLE clients ADD COLUMN upsell_followup_date TEXT;

CREATE TABLE IF NOT EXISTS scheduled_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  description TEXT,
  paid_on TEXT,
  payment_id INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_client ON scheduled_payments(client_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_payments(due_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_paid ON scheduled_payments(paid_on);
