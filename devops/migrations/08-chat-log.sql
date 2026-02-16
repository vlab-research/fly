/*
 *****************
 * Chat Log Table
 *****************
 *
 * Records every message exchanged between the chatbot and users --
 * both what the bot sent (captured via Facebook echo events) and
 * what the user said. Provides conversation replay for debugging
 * and transparency, separate from the structured responses table.
 *
 * Key design decisions:
 * - Self-contained: both bot AND user messages in one table
 * - Raw data philosophy: stores message text and full payloads,
 *   no derived values (those live in the responses table)
 * - Echo-based capture: bot messages recorded when Facebook echoes
 *   them back, reflecting what was actually delivered
 */
CREATE TABLE IF NOT EXISTS chatroach.chat_log (
    userid        VARCHAR NOT NULL,
    pageid        VARCHAR,
    timestamp     TIMESTAMPTZ NOT NULL,
    direction     VARCHAR NOT NULL,
    content       VARCHAR NOT NULL,
    question_ref  VARCHAR,
    shortcode     VARCHAR,
    surveyid      UUID,
    message_type  VARCHAR,
    raw_payload   JSONB,
    metadata      JSONB,
    PRIMARY KEY (userid, timestamp, direction),
    INDEX (userid, timestamp ASC) STORING (content, question_ref),
    INDEX (shortcode, userid, timestamp ASC),
    INVERTED INDEX (metadata)
);

/*
 *****************
 * chatroach user permissions
 *****************
 */
GRANT INSERT, SELECT ON TABLE chatroach.chat_log TO chatroach;

/*
 *****************
 * chatreader user permissions
 *****************
 */
GRANT SELECT ON TABLE chatroach.chat_log TO chatreader;
