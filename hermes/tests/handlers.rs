use axum::{body::Body, http::{Request, StatusCode}};
use hermes::{
    config::Config,
    handlers::{AppState, handle_synthetic, handle_webhook, health, verify_token},
    producer::EventProducer,
};
use http_body_util::BodyExt;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

// --- Mock producer ---

struct MockProducer {
    calls: Mutex<Vec<(String, String, Vec<u8>)>>,
    ready: bool,
}

impl MockProducer {
    fn new() -> Self {
        MockProducer { calls: Mutex::new(vec![]), ready: true }
    }

    fn get_calls(&self) -> Vec<(String, String, Vec<u8>)> {
        self.calls.lock().unwrap().clone()
    }
}

impl EventProducer for MockProducer {
    fn produce(&self, topic: &str, key: String, payload: Vec<u8>) {
        self.calls.lock().unwrap().push((topic.to_string(), key, payload));
    }

    fn is_ready(&self) -> bool {
        self.ready
    }
}

fn make_config() -> Config {
    Config {
        event_topic: "test-events".into(),
        verify_token: "test-verify-token".into(),
        kafka_brokers: "localhost:9092".into(),
        kafka_connection_timeout_ms: 30_000,
        dashboard_url: None,
        auth0_dashboard_secret: None,
        port: 8080,
        fb_app_secret: None,
    }
}

fn make_app(producer: Arc<MockProducer>) -> axum::Router {
    use axum::routing::{get, post};
    let state = AppState {
        producer: producer as Arc<dyn EventProducer>,
        config: Arc::new(make_config()),
        http_client: reqwest::Client::new(),
    };
    axum::Router::new()
        .route("/webhooks", get(verify_token))
        .route("/webhooks", post(handle_webhook))
        .route("/synthetic", post(handle_synthetic))
        .route("/health", get(health))
        .with_state(state)
}

fn json_post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

// --- handleMessengerEvents tests (ported from handlers.test.js) ---

#[tokio::test]
async fn single_messaging_event_produces_one_record() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({
        "entry": [{
            "id": "page123",
            "messaging": [{
                "sender": { "id": "user123" },
                "recipient": { "id": "page123" },
                "timestamp": 1_640_995_200_000_i64,
                "message": { "text": "Hello bot!" }
            }]
        }]
    });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let calls = producer.get_calls();
    assert_eq!(calls.len(), 1);
    let (topic, key, data) = &calls[0];
    assert_eq!(topic, "test-events");
    assert_eq!(key, "user123");
    let event: serde_json::Value = serde_json::from_slice(data).unwrap();
    assert_eq!(event["source"], "messenger");
    assert_eq!(event["sender"]["id"], "user123");
    assert_eq!(event["message"]["text"], "Hello bot!");
}

#[tokio::test]
async fn multiple_messaging_events_produce_n_records() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({
        "entry": [{
            "messaging": [
                { "sender": { "id": "user123" }, "timestamp": 1_640_995_200_000_i64, "message": { "text": "First" } },
                { "sender": { "id": "user456" }, "timestamp": 1_640_995_201_000_i64, "message": { "text": "Second" } }
            ]
        }]
    });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let calls = producer.get_calls();
    assert_eq!(calls.len(), 2);
    let e1: serde_json::Value = serde_json::from_slice(&calls[0].2).unwrap();
    let e2: serde_json::Value = serde_json::from_slice(&calls[1].2).unwrap();
    assert_eq!(e1["message"]["text"], "First");
    assert_eq!(e2["message"]["text"], "Second");
}

#[tokio::test]
async fn single_handover_event_produces_one_record() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({
        "entry": [{
            "messaging_handovers": [{
                "sender": { "id": "user123" },
                "recipient": { "id": "page123" },
                "timestamp": 1_640_995_200_000_i64,
                "pass_thread_control": {
                    "new_owner_app_id": "our_app_id",
                    "previous_owner_app_id": "external_app_id",
                    "metadata": "{\"completion_status\":\"success\"}"
                }
            }]
        }]
    });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let calls = producer.get_calls();
    assert_eq!(calls.len(), 1);
    let (_, key, data) = &calls[0];
    assert_eq!(key, "user123");
    let event: serde_json::Value = serde_json::from_slice(data).unwrap();
    assert_eq!(event["source"], "messenger");
    assert_eq!(event["pass_thread_control"]["new_owner_app_id"], "our_app_id");
}

#[tokio::test]
async fn multiple_handover_events_produce_n_records() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({
        "entry": [{
            "messaging_handovers": [
                { "sender": { "id": "user123" }, "timestamp": 1_640_995_200_000_i64,
                  "pass_thread_control": { "new_owner_app_id": "our_app_id", "previous_owner_app_id": "app1" } },
                { "sender": { "id": "user456" }, "timestamp": 1_640_995_201_000_i64,
                  "pass_thread_control": { "new_owner_app_id": "our_app_id", "previous_owner_app_id": "app2" } }
            ]
        }]
    });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let calls = producer.get_calls();
    assert_eq!(calls.len(), 2);
    let e1: serde_json::Value = serde_json::from_slice(&calls[0].2).unwrap();
    let e2: serde_json::Value = serde_json::from_slice(&calls[1].2).unwrap();
    assert_eq!(e1["pass_thread_control"]["previous_owner_app_id"], "app1");
    assert_eq!(e2["pass_thread_control"]["previous_owner_app_id"], "app2");
}

#[tokio::test]
async fn mixed_messaging_and_handover_produce_both() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({
        "entry": [{
            "messaging": [{ "sender": { "id": "user123" }, "timestamp": 1_640_995_200_000_i64,
                             "message": { "text": "Hello" } }],
            "messaging_handovers": [{ "sender": { "id": "user123" }, "timestamp": 1_640_995_201_000_i64,
                                       "pass_thread_control": { "new_owner_app_id": "our_app_id", "previous_owner_app_id": "ext" } }]
        }]
    });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(producer.get_calls().len(), 2);
}

#[tokio::test]
async fn missing_event_arrays_returns_200_no_produce() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({ "entry": [{ "id": "page123" }] });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(producer.get_calls().len(), 0);
}

#[tokio::test]
async fn empty_event_arrays_returns_200_no_produce() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({ "entry": [{ "messaging": [], "messaging_handovers": [] }] });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(producer.get_calls().len(), 0);
}

#[tokio::test]
async fn event_missing_sender_logs_and_returns_200() {
    // An event with no sender/recipient/user can't be stamped → error logged, 200 returned.
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({
        "entry": [{
            "messaging": [{ "timestamp": 1_640_995_200_000_i64, "message": { "text": "no sender" } }]
        }]
    });

    let resp = app.oneshot(json_post("/webhooks", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(producer.get_calls().len(), 0);
}

// --- verify token ---

#[tokio::test]
async fn verify_token_valid() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer);

    let req = Request::builder()
        .method("GET")
        .uri("/webhooks?hub.verify_token=test-verify-token&hub.challenge=mychallenge")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], b"mychallenge");
}

#[tokio::test]
async fn verify_token_invalid() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer);

    let req = Request::builder()
        .method("GET")
        .uri("/webhooks?hub.verify_token=wrong&hub.challenge=mychallenge")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// --- synthetic ---

#[tokio::test]
async fn synthetic_event_produces_with_correct_key_and_source() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({ "user": "synth_user", "some_field": "val" });

    let resp = app.oneshot(json_post("/synthetic", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let calls = producer.get_calls();
    assert_eq!(calls.len(), 1);
    let (_, key, data) = &calls[0];
    assert_eq!(key, "synth_user");
    let event: serde_json::Value = serde_json::from_slice(data).unwrap();
    assert_eq!(event["source"], "synthetic");
    assert_eq!(event["some_field"], "val");
    assert!(event["timestamp"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn synthetic_event_missing_user_returns_500() {
    let producer = Arc::new(MockProducer::new());
    let app = make_app(producer.clone());

    let payload = json!({ "some_field": "val" });

    let resp = app.oneshot(json_post("/synthetic", payload)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(producer.get_calls().len(), 0);
}

// --- health ---

#[tokio::test]
async fn health_returns_200_when_ready() {
    let producer = Arc::new(MockProducer::new()); // ready = true
    let app = make_app(producer);

    let req = Request::builder().method("GET").uri("/health").body(Body::empty()).unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}
