-- 015_sms_payments.sql
-- Inbox for payment-confirmation SMS forwarded from Joel's phone (LOOP + M-Pesa
-- business formats). The worker parses each, dedups on the M-Pesa transaction
-- code, matches to a client by name, and either auto-records the payment (unique
-- confident match on a recurring client) or leaves it 'pending' for one-tap review.
CREATE TABLE IF NOT EXISTS sms_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw TEXT NOT NULL,               -- the forwarded SMS, verbatim
  amount INTEGER,                  -- parsed KES amount
  sender_name TEXT,                -- name as it appears in the SMS
  txn_code TEXT UNIQUE,            -- M-Pesa transaction code — dedup key
  paid_on TEXT,                    -- ISO date parsed from the SMS
  source TEXT,                     -- 'loop' | 'mpesa' | 'unknown'
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | recorded | ignored
  client_id INTEGER,               -- matched / assigned / suggested client
  payment_id INTEGER,              -- the payment row created when recorded
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sms_status ON sms_payments(status);
