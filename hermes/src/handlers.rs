use axum::{
    body::Body,
    extract::{Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tracing::{error, warn};

use crate::config::Config;
use crate::event::{stamp_event, stamp_whatsapp_event};
use crate::producer::EventProducer;
use crate::signature::verify_sha256;
use crate::templates::handle_template_status_update;

/// Must match main.rs's RequestBodyLimitLayer so the middleware's body
/// buffering can never be the effective request-size limit.
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub producer: Arc<dyn EventProducer>,
    pub config: Arc<Config>,
    pub http_client: reqwest::Client,
}

/// Meta webhook signature enforcement (X-Hub-Signature-256, HMAC-SHA256 of the
/// raw body with the app secret). Applied to the POST webhook routes only —
/// Meta does not sign the GET verification handshake, and /synthetic is an
/// internal injection endpoint.
///
/// No-op when FB_APP_SECRET is unset (local dev, testrunner e2e), so unsigned
/// payloads keep working there. When set, requests with a missing or invalid
/// signature are rejected 401 before any parsing or Kafka produce.
pub async fn require_meta_signature(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let secret = match state.config.fb_app_secret.as_deref() {
        Some(s) => s.to_string(),
        None => return Ok(next.run(req).await),
    };

    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let valid = parts
        .headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .map(|sig| verify_sha256(&secret, sig, &bytes))
        .unwrap_or(false);

    if !valid {
        error!("[ERR] webhook signature verification failed for {}", parts.uri.path());
        return Err(StatusCode::UNAUTHORIZED);
    }

    let req = Request::from_parts(parts, Body::from(bytes));
    Ok(next.run(req).await)
}

/// Builds the full hermes router. Used by main.rs and integration tests so
/// tests exercise the production routing (including signature middleware).
pub fn build_router(state: AppState) -> Router {
    let signed = middleware::from_fn_with_state(state.clone(), require_meta_signature);

    Router::new()
        .route("/webhooks", get(verify_token))
        .route("/webhooks", post(handle_webhook).layer(signed.clone()))
        .route("/whatsapp", get(verify_token_whatsapp))
        .route("/whatsapp", post(handle_whatsapp).layer(signed))
        .route("/synthetic", post(handle_synthetic))
        .route("/health", get(health))
        .with_state(state)
}

#[derive(Deserialize)]
pub struct VerifyQuery {
    #[serde(rename = "hub.verify_token")]
    pub hub_verify_token: Option<String>,
    #[serde(rename = "hub.challenge")]
    pub hub_challenge: Option<String>,
}

pub async fn verify_token(
    State(state): State<AppState>,
    Query(query): Query<VerifyQuery>,
) -> impl IntoResponse {
    if query.hub_verify_token.as_deref() == Some(state.config.verify_token.as_str()) {
        (StatusCode::OK, query.hub_challenge.unwrap_or_default())
    } else {
        (StatusCode::UNAUTHORIZED, "invalid verify token".to_string())
    }
}

/// WhatsApp Cloud API webhook verification (GET /whatsapp). Uses a dedicated
/// WHATSAPP_VERIFY_TOKEN so it can be provisioned independently of Messenger.
pub async fn verify_token_whatsapp(
    State(state): State<AppState>,
    Query(query): Query<VerifyQuery>,
) -> impl IntoResponse {
    if query.hub_verify_token.is_some()
        && query.hub_verify_token.as_deref() == state.config.whatsapp_verify_token.as_deref()
    {
        (StatusCode::OK, query.hub_challenge.unwrap_or_default())
    } else {
        (StatusCode::UNAUTHORIZED, "invalid verify token".to_string())
    }
}

/// Handles WhatsApp Cloud API webhooks (POST /whatsapp). Mirrors handle_webhook
/// for source='whatsapp': walks entry[].changes[].value.{messages,statuses}[],
/// stamps each with source + phone_number_id, and publishes one raw event per
/// item. Always returns 200 so Meta does not retry on per-item errors.
pub async fn handle_whatsapp(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let entries = match body.get("entry").and_then(|e| e.as_array()) {
        Some(e) => e.clone(),
        None => {
            warn!("[DROP] whatsapp POST with no entry array: {}", body);
            return StatusCode::OK;
        }
    };

    for entry in &entries {
        if let Err(e) = process_whatsapp_entry(&state, entry).await {
            error!("[ERR] handleWhatsAppEvents: {}", e);
        }
    }

    StatusCode::OK
}

async fn process_whatsapp_entry(state: &AppState, entry: &Value) -> Result<(), String> {
    let changes = match entry.get("changes").and_then(|c| c.as_array()) {
        Some(c) => c,
        None => {
            warn!("[DROP] whatsapp entry with no changes array: {}", entry);
            return Ok(());
        }
    };

    for change in changes {
        let value = match change.get("value") {
            Some(v) => v,
            None => {
                warn!("[DROP] whatsapp change with no value: {}", change);
                continue;
            }
        };

        let phone_number_id = value
            .get("metadata")
            .and_then(|m| m.get("phone_number_id"))
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();

        if value.get("messages").is_none() && value.get("statuses").is_none() {
            warn!("[DROP] whatsapp change with no messages/statuses: {}", change);
        }

        for key in &["messages", "statuses"] {
            if let Some(items) = value.get(key).and_then(|m| m.as_array()) {
                for item in items {
                    match stamp_whatsapp_event(item.clone(), &phone_number_id) {
                        Ok((user, bytes)) => {
                            state.producer.produce(&state.config.event_topic, user, bytes);
                        }
                        Err(e) => {
                            error!("[ERR] stamp_whatsapp_event: {}", e);
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Returns 200 once Kafka producer is ready, 503 before.
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    if state.producer.is_ready() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

/// Mirrors handleMessengerEvents. Processes entry.messaging[], entry.messaging_handovers[],
/// and entry.changes[field=message_template_status_update]. Always returns 200.
pub async fn handle_webhook(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let entries = match body.get("entry").and_then(|e| e.as_array()) {
        Some(e) => e.clone(),
        None => {
            warn!("[DROP] webhook POST with no entry array: {}", body);
            return StatusCode::OK;
        }
    };

    for entry in &entries {
        // Per-entry error boundary: log and continue, matching JS try/catch behavior.
        if let Err(e) = process_entry(&state, entry).await {
            error!("[ERR] handleEvents: {}", e);
        }
    }

    StatusCode::OK
}

async fn process_entry(state: &AppState, entry: &Value) -> Result<(), String> {
    let mut handled = false;

    for event_type in &["messaging", "messaging_handovers"] {
        if let Some(events) = entry.get(event_type).and_then(|e| e.as_array()) {
            handled = true;
            for event_data in events {
                match stamp_event(event_data.clone(), "messenger") {
                    Ok((user, bytes)) => {
                        state.producer.produce(&state.config.event_topic, user, bytes);
                    }
                    Err(e) => {
                        error!("[ERR] stamp_event: {}", e);
                    }
                }
            }
        }
    }

    // Handover Protocol: when another app (e.g. the Page Inbox) holds thread
    // control, Meta delivers that thread's events in entry.standby instead of
    // entry.messaging. We deliberately don't process them — the state machine
    // must not advance on a thread we don't own — but dropping them silently
    // makes per-user webhook silence undiagnosable, so log each one.
    if let Some(events) = entry.get("standby").and_then(|e| e.as_array()) {
        handled = true;
        for event_data in events {
            warn!(
                "[STANDBY] dropped event for thread owned by another app: {}",
                event_data
            );
        }
    }

    if let Some(changes) = entry.get("changes").and_then(|c| c.as_array()) {
        handled = true;
        for change in changes {
            if change.get("field").and_then(|f| f.as_str())
                == Some("message_template_status_update")
            {
                if let Some(value) = change.get("value").cloned() {
                    let page_id = entry
                        .get("id")
                        .and_then(|id| id.as_str())
                        .unwrap_or("")
                        .to_string();
                    let client = state.http_client.clone();
                    let config = state.config.clone();
                    tokio::spawn(async move {
                        if let Err(e) =
                            handle_template_status_update(&client, &config, &page_id, &value).await
                        {
                            error!("[ERR] handleTemplateStatusUpdate: {}", e);
                        }
                    });
                }
            } else {
                warn!("[DROP] unhandled webhook change: {}", change);
            }
        }
    }

    if !handled {
        warn!("[DROP] webhook entry with no processable payload: {}", entry);
    }

    Ok(())
}

/// Mirrors handleSyntheticEvents. Stamps source='synthetic' and timestamp=now_ms.
/// Returns 500 on any error, 200 on success.
pub async fn handle_synthetic(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let user = match body.get("user").and_then(|u| u.as_str()) {
        Some(u) => u.to_string(),
        None => {
            error!("No user!");
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let mut message = body;
    message["source"] = Value::String("synthetic".to_string());
    message["timestamp"] = Value::Number(now_ms.into());

    let bytes = serde_json::to_vec(&message).expect("serialization is infallible");
    state.producer.produce(&state.config.event_topic, user, bytes);

    StatusCode::OK
}
