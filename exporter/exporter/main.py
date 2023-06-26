import os
import json
from .log import log
from dotenv import load_dotenv
from .db import setup_database_connection
from pydantic import BaseModel
from kafka import KafkaConsumer, admin,TopicPartition
from .exporter import export_data, ExportOptions

# load the env file into the environment
load_dotenv()

# Settings
KAFKA_TOPIC=os.getenv('KAFKA_TOPIC', 'vlab-exports')
KAFKA_SERVERS=os.getenv('KAFKA_SERVERS', '').split(',')
KAFKA_GROUP_ID=os.getenv('KAFKA_GROUP_ID', 'exporter')
DATABASE_URL=os.getenv("DATABASE_URL")

class KafkaMessage(BaseModel):
    event: str
    survey: str
    user: str
    options: ExportOptions

def app():
    """
    the entrypoint to the application
    """

    # Setup consumer
    consumer = setup_kafka_consumer()


    log.info("ready to start receiving messages")
    for message in consumer:
        try:
            if not message.value:
                continue
            # setup database connection
            conn = setup_database_connection(DATABASE_URL)
            process(conn, message.value)
            conn.close()
        # catch all uncaught exceptions and
        # print out error
        except Exception as e:
            log.error(e)

def deserializer(data):
    """
    try to deserialize message from json if it
    fails we ignore message and return None
    """
    try:
        return KafkaMessage(**json.loads(data))
    except Exception as e:
        log.error(f'serilizer - {e}')

def process(conn, data: KafkaMessage):
    """
    The main message processor
    """
    log.info(f'processing export for study {data.survey}')
    export_data(conn, data.user, data.survey, data.options)

def setup_kafka_consumer():
    """
    setting up the Kafka consumer to subscriber to the KAFKA_TOPIC
    """
    consumer = KafkaConsumer(
        bootstrap_servers=KAFKA_SERVERS,
        group_id=KAFKA_GROUP_ID,
        value_deserializer=deserializer
    )
    log.info("connecting to kafka")
    consumer.subscribe(KAFKA_TOPIC)
    consumer.poll(timeout_ms=10000)
    return consumer

if __name__=="__main__":
    app()
