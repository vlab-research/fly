import os
import unittest
from unittest import mock
from unittest.mock import Mock

import pandas as pd
import pytest
from google.cloud import storage

from exporter.storage import *


class TestStorageBackends(unittest.TestCase):
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
