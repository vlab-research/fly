/*
 * Add message_templates table for Facebook Utility Message templates.
 *
 * Utility Messages (globally available since the April 2026 and February 2026
 * deprecations of Message Tags and Recurring Notifications) require a pre-approved
 * template per Facebook Page. The identity of a template in Facebook's model is the
 * tuple (page, name, language): the same name may exist in multiple independently
 * approved language variants.
 *
 * Rows here mirror that identity. fb_template_id stores Facebook's own id so a
 * row-level delete can target exactly one language variant via the hsm_id delete
 * path (otherwise FB's name-based delete removes all languages).
 */

CREATE TABLE IF NOT EXISTS chatroach.message_templates(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    facebook_page_id VARCHAR NOT NULL,
    fb_template_id VARCHAR,
    name VARCHAR NOT NULL,
    language VARCHAR NOT NULL DEFAULT 'en_US',
    body TEXT NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'PENDING',
    rejection_reason TEXT,
    created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (facebook_page_id, name, language),
    INDEX (userid, created DESC),
    INDEX (facebook_page_id, status)
);

/*
 *****************
 * Permissions
 *****************
 */
GRANT SELECT ON TABLE chatroach.message_templates TO chatreader;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.message_templates TO chatroach;
