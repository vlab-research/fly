use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EventError {
    #[error("Could not get user from event")]
    NoUser,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingConversationFields {
    pub user: bool,
    pub account_id: bool,
    pub platform: bool,
}

impl std::fmt::Display for MissingConversationFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut parts = vec![];
        if self.user {
            parts.push("user");
        }
        if self.account_id {
            parts.push("account_id");
        }
        if self.platform {
            parts.push("platform");
        }
        write!(f, "[{}]", parts.join(", "))
    }
}

/// Timestamps < Jan 1 2020 are assumed to be in seconds and converted to ms.
pub fn normalize_timestamp(t: i64) -> i64 {
    if t < 1_577_836_800_000 {
        t * 1000
    } else {
        t
    }
}

/// Reads a top-level field as a non-empty string, returning None if absent or empty.
fn get_non_empty_field(event: &Value, field: &str) -> Option<String> {
    event
        .get(field)
        .and_then(|v| v.as_str())
        .and_then(|s| if s.is_empty() { None } else { Some(s.to_string()) })
}

/// The account for a Messenger event: sender.id when message.is_echo is boolean
/// true (the account sent it), else recipient.id.
/// Returns None if the account_id is not derivable or is empty.
/// This function never panics on any input shape.
pub fn messenger_account_id(event: &Value) -> Option<String> {
    let is_echo = event
        .get("message")
        .and_then(|m| m.get("is_echo"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false);

    if is_echo {
        // Echo: page sent the message, so sender.id is the account
        event
            .get("sender")
            .and_then(|s| s.get("id"))
            .and_then(|id| id.as_str())
            .and_then(|s| if s.is_empty() { None } else { Some(s.to_string()) })
    } else {
        // Normal inbound or other event: recipient.id is the account
        event
            .get("recipient")
            .and_then(|r| r.get("id"))
            .and_then(|id| id.as_str())
            .and_then(|s| if s.is_empty() { None } else { Some(s.to_string()) })
    }
}

/// The account for a synthetic event.
/// Prefers top-level "account_id", falls back to deprecated "page" alias.
/// Returns None if neither is present or both are empty.
pub fn synthetic_account_id(event: &Value) -> Option<String> {
    get_non_empty_field(event, "account_id").or_else(|| get_non_empty_field(event, "page"))
}

/// The platform for a synthetic event.
/// Returns the top-level "platform" field if present and non-empty.
pub fn synthetic_platform(event: &Value) -> Option<String> {
    get_non_empty_field(event, "platform")
}

/// The user a synthetic event belongs to — the top-level "user" field, non-empty.
///
/// Exists so the handler can obtain the user through the same total function the
/// validation uses, rather than re-reading the field and asserting it must be
/// there. An `expect` on a re-read is a panic reachable from an HTTP request the
/// moment the two readers disagree, and hermes is the single ingester: a panic
/// here drops webhooks.
pub fn synthetic_user(event: &Value) -> Option<String> {
    get_non_empty_field(event, "user")
}

/// Validates a synthetic event request, checking which conversation fields are missing.
/// Returns a struct indicating which of {user, account_id, platform} are missing or empty.
/// This is a pure function for testing the validation logic independently.
pub fn validate_synthetic_request(event: &Value) -> MissingConversationFields {
    let user = synthetic_user(event).is_none();
    let account_id = synthetic_account_id(event).is_none();
    let platform = synthetic_platform(event).is_none();

    MissingConversationFields { user, account_id, platform }
}

/// Mirrors getUserFromEvent from @vlab-research/utils:
/// - synthetic: event.user
/// - echo:      event.recipient.id (when event.message.is_echo)
/// - normal:    event.sender.id
pub fn get_user_from_event(event: &Value) -> Result<String, EventError> {
    if event.get("source").and_then(|s| s.as_str()) == Some("synthetic") {
        if let Some(user) = event.get("user").and_then(|u| u.as_str()) {
            return Ok(user.to_string());
        }
    }

    if event
        .get("message")
        .and_then(|m| m.get("is_echo"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
    {
        if let Some(id) = event
            .get("recipient")
            .and_then(|r| r.get("id"))
            .and_then(|id| id.as_str())
        {
            return Ok(id.to_string());
        }
    }

    if let Some(id) = event
        .get("sender")
        .and_then(|s| s.get("id"))
        .and_then(|id| id.as_str())
    {
        return Ok(id.to_string());
    }

    Err(EventError::NoUser)
}

/// Injects `source`, `platform`, `account_id` (when derivable), normalizes
/// `timestamp`, then returns (user_key, json_bytes).
/// For Messenger (source="messenger"), always stamps platform="messenger" and
/// account_id when derivable via the echo rule.
pub fn stamp_event(mut event: Value, source: &str) -> Result<(String, Vec<u8>), EventError> {
    if let Some(ts) = event.get("timestamp").and_then(|t| t.as_i64()) {
        event["timestamp"] = Value::Number(normalize_timestamp(ts).into());
    }
    event["source"] = Value::String(source.to_string());

    // Stamp platform and account_id for Messenger
    if source == "messenger" {
        event["platform"] = Value::String("messenger".to_string());
        if let Some(account_id) = messenger_account_id(&event) {
            event["account_id"] = Value::String(account_id);
        }
    }

    let user = get_user_from_event(&event)?;
    let bytes = serde_json::to_vec(&event).expect("serialization is infallible");
    Ok((user, bytes))
}

/// Stamps a single WhatsApp `messages[]` or `statuses[]` element with
/// `source: "whatsapp"`, `platform: "whatsapp"`, the business `phone_number_id`,
/// and `account_id` (when phone_number_id is non-empty), normalizes the
/// timestamp (WhatsApp sends it as a seconds string), and returns
/// (user_key, json_bytes). The Kafka key is the message sender `from`, or the
/// `recipient_id` for status events (both partition to the same user).
pub fn stamp_whatsapp_event(
    mut event: Value,
    phone_number_id: &str,
) -> Result<(String, Vec<u8>), EventError> {
    if let Some(ts) = event.get("timestamp") {
        let secs = ts
            .as_i64()
            .or_else(|| ts.as_str().and_then(|s| s.parse::<i64>().ok()));
        if let Some(secs) = secs {
            event["timestamp"] = Value::Number(normalize_timestamp(secs).into());
        }
    }
    event["source"] = Value::String("whatsapp".to_string());
    event["platform"] = Value::String("whatsapp".to_string());
    event["phone_number_id"] = Value::String(phone_number_id.to_string());

    // Stamp account_id when phone_number_id is non-empty
    if !phone_number_id.is_empty() {
        event["account_id"] = Value::String(phone_number_id.to_string());
    }

    let user = event
        .get("from")
        .and_then(|f| f.as_str())
        .or_else(|| event.get("recipient_id").and_then(|r| r.as_str()))
        .map(|s| s.to_string())
        .ok_or(EventError::NoUser)?;

    let bytes = serde_json::to_vec(&event).expect("serialization is infallible");
    Ok((user, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_converts_seconds_to_ms() {
        assert_eq!(normalize_timestamp(1_577_836_800), 1_577_836_800_000);
    }

    #[test]
    fn normalize_leaves_ms_unchanged() {
        assert_eq!(normalize_timestamp(1_640_995_200_000), 1_640_995_200_000);
    }

    #[test]
    fn get_user_from_sender() {
        let event = json!({ "sender": { "id": "user123" } });
        assert_eq!(get_user_from_event(&event).unwrap(), "user123");
    }

    #[test]
    fn get_user_from_echo() {
        let event = json!({
            "message": { "is_echo": true },
            "recipient": { "id": "page123" }
        });
        assert_eq!(get_user_from_event(&event).unwrap(), "page123");
    }

    #[test]
    fn get_user_from_synthetic() {
        let event = json!({ "source": "synthetic", "user": "synth_user" });
        assert_eq!(get_user_from_event(&event).unwrap(), "synth_user");
    }

    #[test]
    fn get_user_error_when_missing() {
        let event = json!({ "no_sender": true });
        assert!(get_user_from_event(&event).is_err());
    }

    #[test]
    fn stamp_whatsapp_message_tags_source_and_phone_id() {
        let msg = json!({
            "from": "27123456789",
            "id": "wamid.abc",
            "timestamp": "1640995200",
            "type": "text",
            "text": { "body": "hi" }
        });
        let (user, bytes) = stamp_whatsapp_event(msg, "PHONE_ID_1").unwrap();
        assert_eq!(user, "27123456789");
        let out: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out["source"], "whatsapp");
        assert_eq!(out["phone_number_id"], "PHONE_ID_1");
        assert_eq!(out["account_id"], "PHONE_ID_1");
        assert_eq!(out["platform"], "whatsapp");
        // seconds string normalized to ms number
        assert_eq!(out["timestamp"], json!(1_640_995_200_000_i64));
    }

    #[test]
    fn stamp_whatsapp_status_keys_on_recipient() {
        let status = json!({
            "id": "wamid.abc",
            "status": "delivered",
            "timestamp": "1640995200",
            "recipient_id": "27123456789"
        });
        let (user, bytes) = stamp_whatsapp_event(status, "PHONE_ID_1").unwrap();
        assert_eq!(user, "27123456789");
        let out: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out["source"], "whatsapp");
        assert_eq!(out["status"], "delivered");
        assert_eq!(out["platform"], "whatsapp");
        assert_eq!(out["account_id"], "PHONE_ID_1");
    }

    #[test]
    fn stamp_whatsapp_errors_without_from_or_recipient() {
        let msg = json!({ "type": "text", "text": { "body": "hi" } });
        assert!(stamp_whatsapp_event(msg, "PHONE_ID_1").is_err());
    }

    #[test]
    fn stamp_whatsapp_no_account_id_when_phone_number_id_empty() {
        let msg = json!({
            "from": "27123456789",
            "timestamp": "1640995200",
            "type": "text",
            "text": { "body": "hi" }
        });
        let (_, bytes) = stamp_whatsapp_event(msg, "").unwrap();
        let out: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out["source"], "whatsapp");
        assert_eq!(out["platform"], "whatsapp");
        assert_eq!(out["phone_number_id"], "");
        assert_eq!(out.get("account_id"), None);
    }

    // --- Messenger account_id: the shared derivation vectors ---
    //
    // testdata/event-envelope/messenger-account-derivation.json is the single
    // specification for "which id is the account, and which is the participant".
    // scribble (Go) and replybot (JS) assert the same file, so the three
    // implementations cannot drift apart.
    //
    // One test per vector, named for the rule it pins. `every_vector_is_covered`
    // fails if a vector is added to the fixture without a test here.

    const FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../testdata/event-envelope/messenger-account-derivation.json"
    ));

    const COVERED: &[&str] = &[
        "inbound_text",
        "echo_of_bot_message",
        "explicit_is_echo_false",
        "quick_reply",
        "postback_no_message_key",
        "referral_entry",
        "optin_one_time_notif",
        "delivery_receipt",
        "handover_pass_thread_control",
        "echo_with_attachment",
        "missing_recipient",
        "echo_missing_sender",
    ];

    struct Vector {
        event: Value,
        account_id: Option<String>,
        user_id: Option<String>,
    }

    fn vector(name: &str) -> Vector {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
        let found = fixture["vectors"]
            .as_array()
            .expect("fixture has a vectors array")
            .iter()
            .find(|v| v["name"] == name)
            .unwrap_or_else(|| panic!("no vector named '{name}' in the fixture"))
            .clone();

        Vector {
            event: found["event"].clone(),
            account_id: found["expected"]["account_id"].as_str().map(String::from),
            user_id: found["expected"]["user_id"].as_str().map(String::from),
        }
    }

    // Every vector asserts the same three things: the account we derive, the
    // participant we derive, and that stamping puts the account on the envelope.
    fn check(name: &str) {
        let v = vector(name);

        assert_eq!(messenger_account_id(&v.event), v.account_id, "account_id");
        assert_eq!(get_user_from_event(&v.event).ok(), v.user_id, "user_id");

        let (_, bytes) = stamp_event(v.event.clone(), "messenger").expect("event stamps");
        let stamped: Value = serde_json::from_slice(&bytes).expect("stamped event is valid JSON");

        assert_eq!(stamped["platform"], "messenger");
        assert_eq!(stamped["source"], "messenger");

        match v.account_id {
            Some(account) => assert_eq!(stamped["account_id"], json!(account)),
            // Not derivable: the field must be absent, not present-and-null.
            None => assert!(
                stamped.get("account_id").is_none(),
                "account_id must be absent when it cannot be derived"
            ),
        }
    }

    // The account is the recipient: the participant sent this to us.

    #[test]
    fn inbound_text_takes_the_recipient_as_the_account() {
        check("inbound_text")
    }

    #[test]
    fn quick_reply_takes_the_recipient_as_the_account() {
        check("quick_reply")
    }

    #[test]
    fn postback_without_a_message_key_takes_the_recipient_as_the_account() {
        check("postback_no_message_key")
    }

    #[test]
    fn referral_entry_takes_the_recipient_as_the_account() {
        check("referral_entry")
    }

    #[test]
    fn optin_takes_the_recipient_as_the_account() {
        check("optin_one_time_notif")
    }

    #[test]
    fn delivery_receipt_takes_the_recipient_as_the_account() {
        check("delivery_receipt")
    }

    #[test]
    fn handover_takes_the_recipient_as_the_account() {
        check("handover_pass_thread_control")
    }

    // The echo inversion: an echo is a message the ACCOUNT sent, so the roles
    // swap and the account is the sender. 28.8% of the archived table.

    #[test]
    fn echo_takes_the_sender_as_the_account() {
        check("echo_of_bot_message")
    }

    #[test]
    fn echo_with_an_attachment_takes_the_sender_as_the_account() {
        check("echo_with_attachment")
    }

    // Only a boolean true inverts. An explicit false is an ordinary inbound
    // message and must take the recipient.

    #[test]
    fn is_echo_false_does_not_invert() {
        check("explicit_is_echo_false")
    }

    // Not derivable. The participant is still known, but the account is absent
    // rather than guessed.

    #[test]
    fn a_missing_recipient_yields_no_account() {
        check("missing_recipient")
    }

    #[test]
    fn an_echo_with_no_sender_yields_no_account() {
        check("echo_missing_sender")
    }

    #[test]
    fn every_vector_is_covered() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
        let mut in_fixture: Vec<String> = fixture["vectors"]
            .as_array()
            .expect("fixture has a vectors array")
            .iter()
            .map(|v| v["name"].as_str().expect("vector has a name").to_string())
            .collect();
        in_fixture.sort();

        let mut covered: Vec<String> = COVERED.iter().map(|s| s.to_string()).collect();
        covered.sort();

        assert_eq!(
            in_fixture, covered,
            "the fixture and the tests above have diverged: add a #[test] for each new vector"
        );
    }

    // --- Synthetic account_id and platform derivation tests ---

    #[test]
    fn synthetic_account_id_prefers_account_id_over_page() {
        let event = json!({
            "account_id": "acct_preferred",
            "page": "page_fallback"
        });
        assert_eq!(synthetic_account_id(&event), Some("acct_preferred".to_string()));
    }

    #[test]
    fn synthetic_account_id_falls_back_to_page() {
        let event = json!({ "page": "page_only" });
        assert_eq!(synthetic_account_id(&event), Some("page_only".to_string()));
    }

    #[test]
    fn synthetic_account_id_returns_none_when_both_missing() {
        let event = json!({ "user": "u1", "platform": "messenger" });
        assert_eq!(synthetic_account_id(&event), None);
    }

    #[test]
    fn synthetic_account_id_ignores_empty_strings() {
        let event = json!({
            "account_id": "",
            "page": "page_fallback"
        });
        assert_eq!(synthetic_account_id(&event), Some("page_fallback".to_string()));
    }

    #[test]
    fn synthetic_account_id_returns_none_when_both_empty() {
        let event = json!({
            "account_id": "",
            "page": ""
        });
        assert_eq!(synthetic_account_id(&event), None);
    }

    #[test]
    fn synthetic_platform_reads_platform_field() {
        let event = json!({ "platform": "whatsapp" });
        assert_eq!(synthetic_platform(&event), Some("whatsapp".to_string()));
    }

    #[test]
    fn synthetic_platform_returns_none_when_missing() {
        let event = json!({ "account_id": "a1" });
        assert_eq!(synthetic_platform(&event), None);
    }

    #[test]
    fn synthetic_platform_ignores_empty_string() {
        let event = json!({ "platform": "" });
        assert_eq!(synthetic_platform(&event), None);
    }

    // --- Validation helper tests ---

    #[test]
    fn validate_synthetic_request_missing_components() {
        let event = json!({ "account_id": "a1" }); // missing user and platform
        let missing = validate_synthetic_request(&event);
        assert_eq!(missing.user, true);
        assert_eq!(missing.account_id, false);
        assert_eq!(missing.platform, true);
    }

    #[test]
    fn validate_synthetic_request_all_present() {
        let event = json!({
            "user": "u1",
            "account_id": "a1",
            "platform": "messenger"
        });
        let missing = validate_synthetic_request(&event);
        assert_eq!(missing.user, false);
        assert_eq!(missing.account_id, false);
        assert_eq!(missing.platform, false);
    }

    #[test]
    fn validate_synthetic_request_empty_user() {
        let event = json!({
            "user": "",
            "account_id": "a1",
            "platform": "messenger"
        });
        let missing = validate_synthetic_request(&event);
        assert_eq!(missing.user, true);
    }

    #[test]
    fn validate_synthetic_request_page_alias_for_account_id() {
        let event = json!({
            "user": "u1",
            "page": "page_id",
            "platform": "whatsapp"
        });
        let missing = validate_synthetic_request(&event);
        assert_eq!(missing.account_id, false);
    }
}
