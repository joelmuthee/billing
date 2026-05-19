-- Migration: add expenses + expense_payments tables, seed GHL + Claude
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/002_expenses.sql

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

-- Seed the two known monthly expenses
INSERT INTO expenses (name, category, amount, plan, start_date, next_due, status, notes)
VALUES
  ('GHL', 'subscription', 40650, 'monthly', date('now'), date('now'), 'active', 'Go High Level monthly renewal'),
  ('Claude', 'subscription', 15900, 'monthly', date('now'), date('now'), 'active', 'Anthropic Claude monthly subscription');
