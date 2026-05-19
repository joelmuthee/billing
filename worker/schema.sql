-- Clients Dashboard — D1 schema
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business TEXT,
  plan TEXT NOT NULL CHECK (plan IN ('monthly', 'quarterly', 'one-off')),
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT,
  phone TEXT,
  notes TEXT,
  start_date TEXT NOT NULL,
  next_due TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','churned','completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on);
CREATE INDEX IF NOT EXISTS idx_clients_next_due ON clients(next_due);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
