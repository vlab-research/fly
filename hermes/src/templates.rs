use crate::config::Config;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

#[derive(Serialize)]
struct Claims {
    iat: u64,
    exp: u64,
}

/// Fire-and-forget PATCH to the dashboard for `message_template_status_update` changes.
/// Mirrors handleTemplateStatusUpdate in botserver/server/handlers.js.
pub async fn handle_template_status_update(
    client: &reqwest::Client,
    config: &Config,
    page_id: &str,
    value: &Value,
) -> Result<(), String> {
    let dashboard_url = match &config.dashboard_url {
        Some(url) => url,
        None => {
            warn!("DASHBOARD_URL not set — cannot forward template status update");
            return Ok(());
        }
    };

    let secret = match &config.auth0_dashboard_secret {
        Some(s) => s,
        None => {
            warn!("AUTH0_DASHBOARD_SECRET not set — cannot sign JWT for template status update");
            return Ok(());
        }
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Node's jsonwebtoken with `expiresIn: '60s'` auto-adds iat and sets exp = iat + 60.
    // We set both explicitly so the shape is identical.
    let token = encode(
        &Header::new(Algorithm::HS256),
        &Claims { iat: now, exp: now + 60 },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("JWT encode failed: {}", e))?;

    let body = serde_json::json!({
        "pageId": page_id,
        "name": value.get("message_template_name").and_then(|v| v.as_str()).unwrap_or(""),
        "language": value.get("message_template_language").and_then(|v| v.as_str()).unwrap_or(""),
        "status": value.get("event").and_then(|v| v.as_str()).unwrap_or(""),
        "reason": value.get("reason").cloned().unwrap_or(Value::Null),
    });

    let resp = client
        .patch(format!("{}/api/v1/message-templates", dashboard_url))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    Ok(())
}
