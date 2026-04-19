/*
 * Add optional quick-reply buttons to utility message templates.
 *
 * Facebook's utility template component model lets us declare up to 3
 * QUICK_REPLY buttons at template-approval time. Labels are locked on
 * approval; payloads are filled per-send by the survey layer.
 *
 * Buttons live as JSONB here because:
 * - the shape is tiny (array of {label} objects, max 3)
 * - we never query by button content
 * - future button sub-types (URL, phone) can extend the shape without DDL
 */

ALTER TABLE chatroach.message_templates
  ADD COLUMN IF NOT EXISTS buttons JSONB NOT NULL DEFAULT '[]'::JSONB;
