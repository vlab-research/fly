/*
 * Add media table for tracking Facebook message_attachments uploads.
 *
 * Each row represents a file uploaded to Facebook's message_attachments API
 * via the dashboard. The attachment_id can be used in chatbot message
 * templates (via translate-typeform's translateAttachment function).
 */

CREATE TABLE IF NOT EXISTS chatroach.media(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    facebook_page_id VARCHAR NOT NULL,
    attachment_id VARCHAR NOT NULL,
    media_type VARCHAR NOT NULL,
    filename VARCHAR NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (userid, created DESC),
    INDEX (facebook_page_id, created DESC)
);

/*
 *****************
 * Permissions
 *****************
 */
GRANT SELECT ON TABLE chatroach.media TO chatreader;
GRANT INSERT, SELECT ON TABLE chatroach.media TO chatroach;
