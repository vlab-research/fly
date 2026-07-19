use axum::{
    routing::{get, post},
    Router,
};
use hermes::{
    config::Config,
    handlers::{AppState, handle_synthetic, handle_webhook, health, verify_token},
    producer::KafkaProducer,
};
use std::sync::Arc;
use tokio::signal;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hermes=info".into()),
        )
        .init();

    let config = Config::from_env().unwrap_or_else(|e| {
        eprintln!("Config error: {}", e);
        std::process::exit(1);
    });

    let port = config.port;
    let timeout_ms = config.kafka_connection_timeout_ms;

    let producer = KafkaProducer::new(&config.kafka_brokers).unwrap_or_else(|e| {
        eprintln!("Failed to create Kafka producer: {}", e);
        std::process::exit(1);
    });

    producer.wait_ready(timeout_ms).unwrap_or_else(|e| {
        eprintln!("Kafka producer failed to become ready: {}", e);
        std::process::exit(1);
    });

    let state = AppState {
        producer: Arc::new(producer),
        config: Arc::new(config),
        http_client: reqwest::Client::new(),
    };

    let app = Router::new()
        .route("/webhooks", get(verify_token))
        .route("/webhooks", post(handle_webhook))
        .route("/synthetic", post(handle_synthetic))
        .route("/health", get(health))
        .layer(CorsLayer::permissive())
        .layer(RequestBodyLimitLayer::new(5 * 1024 * 1024))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap_or_else(|e| {
            eprintln!("Failed to bind to port {}: {}", port, e);
            std::process::exit(1);
        });

    tracing::info!("Listening on port {}", port);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Server error");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("Shutdown signal received, draining...");
}
