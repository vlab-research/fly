import os
from datetime import timedelta
from io import BytesIO
from typing import Optional

import pandas as pd
from google.cloud import storage
from minio import Minio
from pydantic import BaseSettings, Field, ValidationError, validator

from .log import log


def get_storage_backend(file_path, **kwargs):
    """
    used to initialize the configured storage backend
    """
    backend_map = {"google": GoogleStorageBackend, "s3": S3StorageBackend}
    backend = backend_map.get(os.getenv("STORAGE_BACKEND"), BaseStorageBackend)
    return backend(file_path=file_path, **kwargs)


class BaseStorageBackend(BaseSettings):
    """
    Base Class for Storage Backend - used for development only
    """

    file_path: str

    class Config:
        env_prefix = ""
        case_sensitive = False

    def __init__(self, **data):
        super().__init__(**data)

    def save_to_csv(self, df: pd.DataFrame):
        log.info("BaseStorage only prints:")
        log.info(df)

    def generate_link(self):
        return "Base backend fake link"


class GoogleStorageBackend(BaseStorageBackend):
    """
    Storage Backend for Google Cloud Storage
    """

    bucket_name: str = Field(..., env="GOOGLE_STORAGE_BUCKET")

    def save_to_csv(self, df: pd.DataFrame):
        client = storage.Client()
        bucket = client.get_bucket(self.bucket_name)
        bucket.blob(self.file_path).upload_from_string(df.to_csv(), "text/csv")


class S3StorageBackend(BaseStorageBackend):
    bucket_name: str = Field(..., env="S3_BUCKET_NAME")
    host: str = Field(..., env="S3_HOST")
    access_key: str = Field(..., env="S3_ACCESS_KEY")
    secret_key: str = Field(..., env="S3_SECRET_KEY")
    ssl_enabled: Optional[str] = Field(..., env="S3_SSL_ENABLED")

    def get_client(self):
        return Minio(
            endpoint=self.host,
            access_key=self.access_key,
            secret_key=self.secret_key,
            secure=self.ssl_enabled,
        )

    def save_to_csv(self, df: pd.DataFrame):
        if str(self.ssl_enabled).upper() == "FALSE":
            self.ssl_enabled = False
        else:
            self.ssl_enabled = True

        client = self.get_client()

        # Check if bucket exists
        found = client.bucket_exists(self.bucket_name)
        if not found:
            client.make_bucket(self.bucket_name)

        csv = df.to_csv().encode("utf-8")
        # Put the object into bucket
        res = client.put_object(
            bucket_name=self.bucket_name,
            object_name=self.file_path,
            length=len(csv),
            data=BytesIO(csv),
            content_type="text/csv",
        )

    def generate_link(self):
        client = self.get_client()

        return client.get_presigned_url(
            "GET",
            bucket_name=self.bucket_name,
            object_name=self.file_path,
            expires=timedelta(hours=7),
        )
