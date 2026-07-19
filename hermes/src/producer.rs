use rdkafka::config::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord, Producer as RdProducer};
use rdkafka::util::Timeout;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

pub trait EventProducer: Send + Sync + 'static {
    fn produce(&self, topic: &str, key: String, payload: Vec<u8>);
    fn is_ready(&self) -> bool;
}

pub struct KafkaProducer {
    inner: FutureProducer,
    ready: Arc<AtomicBool>,
}

impl KafkaProducer {
    pub fn new(brokers: &str) -> Result<Self, rdkafka::error::KafkaError> {
        // Config values ported verbatim from botserver/server/producer.js
        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("retry.backoff.ms", "200")
            .set("message.send.max.retries", "10")
            .set("socket.keepalive.enable", "true")
            .set("queue.buffering.max.messages", "100000")
            .set("queue.buffering.max.ms", "1000")
            .set("batch.num.messages", "1000000")
            // Explicit murmur2_random to match librdkafka/Java default and node-rdkafka behavior
            .set("partitioner", "murmur2_random")
            .create()?;
        Ok(KafkaProducer {
            inner: producer,
            ready: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Fetches broker metadata as a readiness probe; flips the ready flag on success.
    pub fn wait_ready(&self, timeout_ms: u64) -> Result<(), rdkafka::error::KafkaError> {
        self.inner
            .client()
            .fetch_metadata(None, Duration::from_millis(timeout_ms))?;
        self.ready.store(true, Ordering::Relaxed);
        info!("producer ready");
        Ok(())
    }
}

impl EventProducer for KafkaProducer {
    fn produce(&self, topic: &str, key: String, payload: Vec<u8>) {
        let producer = self.inner.clone();
        let topic = topic.to_string();
        // Create record inside the spawned task so all references are to owned data
        // with no lifetime escaping the method. Timeout::After(Duration::ZERO) is
        // non-blocking: if the queue is full it fails immediately rather than retrying.
        tokio::spawn(async move {
            let record = FutureRecord::to(&topic).key(&key).payload(&payload);
            if let Err((e, _)) = producer.send(record, Timeout::After(Duration::ZERO)).await {
                warn!(key = %key, "Kafka delivery failed: {}", e);
            }
        });
    }

    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }
}
