-- Make destination_form nullable in bails table
-- For user_list bails, destination_form is stored in the definition (per-user shortcodes)
-- The top-level destination_form is only meaningful for conditions-based bails

ALTER TABLE chatroach.bails ALTER COLUMN destination_form DROP NOT NULL;
