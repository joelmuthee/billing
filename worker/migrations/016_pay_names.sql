-- 016_pay_names.sql
-- Learned M-Pesa sender names per client, so payments auto-match after the first
-- manual confirm. When Joel assigns an inbox SMS to a client (or one auto-records),
-- the exact name from the SMS is appended here; the matcher then treats an exact
-- match against this list as the strongest signal.
ALTER TABLE clients ADD COLUMN pay_names TEXT;  -- JSON array of captured sender names

-- Clients who pay offline (cheque / cash / bank) never generate an M-Pesa SMS, so
-- they should NOT be flagged "no payment matched yet". Default 1 = expect SMS.
ALTER TABLE clients ADD COLUMN expects_sms INTEGER DEFAULT 1;

-- St. Christopher's (5) pays by cheque.
UPDATE clients SET expects_sms = 0 WHERE id = 5;
