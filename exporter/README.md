# Fly Exporter

A service that handles exporting fly data into CSV format for download


## Setup

There are currently various settings that you can configure on this application

## General Configuration:

**KAFKA_TOPIC:** The topic on which to listen for message
**KAFKA_SERVERS:** Comma seperated list fo kafka brokers to listen on
**KAFKA_GROUP_ID:** Kafka Group ID
**APP_NAME:** identifier of the application
**DATABASE_URLL** the full url to access the database please see [SqlAlchemy's docs][1] on the format of these urls
**STORAGE_BACKEND:** Storage backend to use, current options supported are `google` and `s3`

## Storage Specific Configurations

### Google

**GOOGLE_STORAGE_BUCKET:** Google Storage Bucket Name
**GOOGLE_APPLICATION_CREDENTIALS:** The path to the credentials to use to
upload exports

### S3

**S3_BUCKET_NAME:** Storage Bucket Name
**S3_ACCESS_KEY:** Access Key
**S3_ACCESS_KEY:** Access Key
**S3_BUCKET_NAME:** Access Key
**S3_HOST:** Access Key


## Development

**Please Note To use Python 3.9 and above for development**

### Install Dependencies

```bash
pip install -r requirements.txt
```

### Install Development Dependencies

```bash
pip install -r requirements.dev.txt
```

### Running Tests

In order to run tests please use:

```bash
pytest exporter/ -s
```


[1]: https://docs.sqlalchemy.org/en/20/core/engines.html#backend-specific-urls
