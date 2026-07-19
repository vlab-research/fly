pub struct Config {
    pub event_topic: String,
    pub verify_token: String,
    pub kafka_brokers: String,
    pub kafka_connection_timeout_ms: u64,
    pub dashboard_url: Option<String>,
    pub auth0_dashboard_secret: Option<String>,
    pub port: u16,
    /// If set, enables X-Hub-Signature-256 verification on POST /webhooks.
    pub fb_app_secret: Option<String>,
    /// Verify token for the WhatsApp Cloud API webhook (GET /whatsapp handshake).
    pub whatsapp_verify_token: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Ok(Config {
            event_topic: std::env::var("BOTSERVER_EVENT_TOPIC")
                .map_err(|_| "BOTSERVER_EVENT_TOPIC not set")?,
            verify_token: std::env::var("VERIFY_TOKEN")
                .map_err(|_| "VERIFY_TOKEN not set")?,
            kafka_brokers: std::env::var("KAFKA_BROKERS")
                .map_err(|_| "KAFKA_BROKERS not set")?,
            kafka_connection_timeout_ms: std::env::var("KAFKA_CONNECTION_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30_000),
            dashboard_url: std::env::var("DASHBOARD_URL").ok(),
            auth0_dashboard_secret: std::env::var("AUTH0_DASHBOARD_SECRET").ok(),
            port: std::env::var("PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(8080),
            fb_app_secret: std::env::var("FB_APP_SECRET").ok(),
            whatsapp_verify_token: std::env::var("WHATSAPP_VERIFY_TOKEN").ok(),
        })
    }
}
