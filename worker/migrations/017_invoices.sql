-- Invoices for clients who do not need a KRA eTIMS invoice (invoice_type = 'regular').
--
-- Each invoice keeps its own frozen copy of the seller's details, the client's details and the
-- lines, so editing a client or your own details later never changes an invoice already sent.
-- `seq` is the running number; UNIQUE so two invoices made at the same moment cannot share one.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL UNIQUE,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  seller TEXT NOT NULL,        -- JSON snapshot of invoice_settings at issue time
  bill_to TEXT NOT NULL,       -- JSON snapshot: name, business, phone, email, pin, address
  lines TEXT NOT NULL,         -- JSON: [{ description, qty, price }]
  total INTEGER NOT NULL,
  notes TEXT,
  for_kind TEXT CHECK (for_kind IN ('recurring', 'scheduled') OR for_kind IS NULL),
  for_ref TEXT,                -- the next_due it bills, or the scheduled_payments id
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);

-- Your details as they print on every invoice: name, PIN, contacts, how clients pay you.
CREATE TABLE IF NOT EXISTS invoice_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
