use hermes::event::{get_user_from_event, normalize_timestamp, stamp_event};
use serde_json::json;

#[test]
fn normalize_seconds_to_ms() {
    assert_eq!(normalize_timestamp(1_577_836_800), 1_577_836_800_000);
}

#[test]
fn normalize_ms_unchanged() {
    assert_eq!(normalize_timestamp(1_640_995_200_000), 1_640_995_200_000);
}

#[test]
fn get_user_normal_sender() {
    let event = json!({ "sender": { "id": "user123" } });
    assert_eq!(get_user_from_event(&event).unwrap(), "user123");
}

#[test]
fn get_user_echo() {
    let event = json!({
        "message": { "is_echo": true },
        "recipient": { "id": "page123" }
    });
    assert_eq!(get_user_from_event(&event).unwrap(), "page123");
}

#[test]
fn get_user_synthetic() {
    let event = json!({ "source": "synthetic", "user": "synth_user" });
    assert_eq!(get_user_from_event(&event).unwrap(), "synth_user");
}

#[test]
fn get_user_error_on_missing() {
    let event = json!({ "unrelated": "field" });
    assert!(get_user_from_event(&event).is_err());
}

#[test]
fn stamp_event_injects_source_and_normalizes_ts() {
    let raw = json!({
        "sender": { "id": "u1" },
        "timestamp": 1_640_995_200
    });
    let (key, bytes) = stamp_event(raw, "messenger").unwrap();
    assert_eq!(key, "u1");
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["source"], "messenger");
    assert_eq!(parsed["timestamp"], 1_640_995_200_000_i64);
}
