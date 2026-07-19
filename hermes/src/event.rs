use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EventError {
    #[error("Could not get user from event")]
    NoUser,
}

/// Timestamps < Jan 1 2020 are assumed to be in seconds and converted to ms.
pub fn normalize_timestamp(t: i64) -> i64 {
    if t < 1_577_836_800_000 {
        t * 1000
    } else {
        t
    }
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

/// Injects `source`, normalizes `timestamp`, then returns (user_key, json_bytes).
pub fn stamp_event(mut event: Value, source: &str) -> Result<(String, Vec<u8>), EventError> {
    if let Some(ts) = event.get("timestamp").and_then(|t| t.as_i64()) {
        event["timestamp"] = Value::Number(normalize_timestamp(ts).into());
    }
    event["source"] = Value::String(source.to_string());

    let user = get_user_from_event(&event)?;
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
}
