import json
import os

from confluent_kafka import Consumer
from dotenv import load_dotenv
from pydantic import BaseModel

from .exporter import ExportOptions, export_data, export_chat_log
from .log import log

# load the env file into the environment
load_dotenv()

# Settings
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "vlab-exports")
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "")
KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "exporter")
KAFKA_MAX_POLL_INTERVAL = os.getenv("KAFKA_MAX_POLL_INTERVAL", "1200000")
DATABASE_URL = os.getenv("DATABASE_URL")


class ChatLogExportOptions(BaseModel):
    include_raw_payload: bool = False
    include_metadata: bool = False


class KafkaMessage(BaseModel):
    event: str
    survey: str
    user: str
    export_id: str
    source: str = "responses"
    options: ExportOptions = ExportOptions()
    chat_log_options: ChatLogExportOptions = ChatLogExportOptions()


def app():
    """
    the entrypoint to the application
    """

    # Setup consumer
    consumer = setup_kafka_consumer()

    log.info("ready to start receiving messages")

    try:

        while True:
            msg = consumer.poll(1.0)

            if msg is None:
                continue

            if msg.error():
                log.error("Consumer error: {}".format(msg.error()))
                continue

            try:
                value = parse_message(msg)
                process(DATABASE_URL, value)
                consumer.commit(asynchronous=False)

            except BaseException as e:
                log.error(e)

    finally:
        consumer.close()


def parse_message(msg):
    data = msg.value().decode("utf-8")
    return KafkaMessage(**json.loads(data))


def process(cnf, data: KafkaMessage):
    """
    The main message processor
    """
    log.info(f"processing {data.source} export for study {data.survey} (id={data.export_id})")
    if data.source == "chat_log":
        export_chat_log(cnf, data.export_id, data.user, data.survey, data.chat_log_options)
    else:
        export_data(cnf, data.export_id, data.user, data.survey, data.options)


def setup_kafka_consumer():
    """
    setting up the Kafka consumer to subscriber to the KAFKA_TOPIC
    """

    consumer = Consumer(
        {
            "bootstrap.servers": KAFKA_BROKERS,
            "group.id": KAFKA_GROUP_ID,
            "auto.offset.reset": "latest",
            "enable.auto.commit": "false",
            "max.poll.interval.ms": KAFKA_MAX_POLL_INTERVAL,
            "session.timeout.ms": "30000",  # 30s heartbeat
        }
    )

    consumer.subscribe([KAFKA_TOPIC])

    return consumer


if __name__ == "__main__":
    app()
