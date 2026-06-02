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
  invoice_type TEXT NOT NULL DEFAULT 'regular' CHECK (invoice_type IN ('kra','regular','none')),
  invoice_sent_for_next_due TEXT,
  invoice_sent_date TEXT,
  subaccount_paused TEXT,
  catalog_api_base TEXT,
  ended_date TEXT,
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
  invoice_sent_on TEXT,
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
  ended_date TEXT,
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

-- Demo prospects: leads who asked for a demo but haven't committed. Tracked so
-- they don't fall through the cracks. Separate from clients (no plan, no billing).
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
