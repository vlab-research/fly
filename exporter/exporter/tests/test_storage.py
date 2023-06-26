import pytest
from exporter.storage import *
import unittest
from unittest.mock import Mock
from unittest import mock
import pandas as pd
from google.cloud import storage
import os

class TestStorageBackends(unittest.TestCase):

    def test_base_storage_fails_on_init(self):
        with pytest.raises(NotImplementedError):
            BaseStorageBackend()

    def test_google_storage_fails_when_env_not_set(self):
        with pytest.raises(ValueError):
            GoogleStorageBackend(file_path="test")


#    @mock.patch.object(storage, 'Client', Mock())
#    def test_google_storage_save_csv(self):
#        os.environ["GOOGLE_STORAGE_BUCKET"] = "test"
#        df = pd.DataFrame({'foo': ['1', '2'], 'bar': [1, 2]})
#        storage.Client.get_bucket.return_value = Mock()
#        storage.Client.get_bucket.blob = Mock()
#        storage.Client.get_bucket.blob.upload_from_string = Mock()
#        backend = GoogleStorageBackend(file_path="test")
#        backend.save(df)
