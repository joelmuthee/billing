-- Migration: tag an expense with what it's for (the product/service it promotes).
-- Mainly for ad expenses: "Shopfront", "AI Chat", etc., so ad spend can be split
-- per product. Free text; the form suggests the service catalogue.
-- Apply: npx wrangler d1 execute clients-dashboard --remote --file=migrations/011_expense_tag.sql

ALTER TABLE expenses ADD COLUMN tag TEXT;
