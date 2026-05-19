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
  email TEXT,
  notes TEXT,
  start_date TEXT NOT NULL,
  next_due TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','churned','completed')),
  reminder_method TEXT NOT NULL DEFAULT 'whatsapp' CHECK (reminder_method IN ('whatsapp','email','kra_invoice','none')),
  services TEXT NOT NULL DEFAULT '[]',
  upsell_notes TEXT,
  upsell_followup_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT,
  plan TEXT NOT NULL CHECK (plan IN ('monthly', 'quarterly', 'one-off')),
  start_date TEXT NOT NULL,
  next_due TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','completed')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expense_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_expense_payments_expense ON expense_payments(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_payments_paid_on ON expense_payments(paid_on);
CREATE INDEX IF NOT EXISTS idx_expenses_next_due ON expenses(next_due);
