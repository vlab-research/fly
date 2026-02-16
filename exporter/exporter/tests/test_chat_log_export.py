from unittest.mock import patch, MagicMock, call

import pandas as pd
import pytest

from exporter.exporter import (
    set_export_status,
    export_chat_log,
    get_chat_log,
)
from exporter.main import ChatLogExportOptions


class TestSetExportStatus:
    @patch("exporter.exporter.execute")
    def test_updates_by_export_id(self, mock_execute):
        set_export_status("db-url", "uuid-123", url="http://link", status="Finished")

        mock_execute.assert_called_once()
        args = mock_execute.call_args
        assert args[0][0] == "db-url"
        sql = args[0][1]
        assert "UPDATE export_status" in sql
        assert "WHERE id = %s" in sql
        assert args[1]["vals"] == ("Finished", "http://link", "uuid-123")

    @patch("exporter.exporter.execute")
    def test_defaults_to_failed(self, mock_execute):
        set_export_status("db-url", "uuid-456")

        args = mock_execute.call_args
        assert args[1]["vals"] == ("Failed", "Not Found", "uuid-456")


class TestGetChatLog:
    @patch("exporter.exporter.query")
    def test_base_columns_only(self, mock_query):
        mock_query.return_value = iter([
            {
                "userid": "u1", "pageid": "p1", "timestamp": "2025-01-01",
                "direction": "incoming", "content": "hello", "question_ref": "q1",
                "shortcode": "sc1", "surveyid": "s1", "message_type": "text",
            }
        ])

        opts = ChatLogExportOptions(include_metadata=False, include_raw_payload=False)
        result = get_chat_log("db-url", "user@test.com", "survey1", opts)

        assert isinstance(result, pd.DataFrame)
        assert len(result) == 1
        assert "metadata" not in result.columns
        assert "raw_payload" not in result.columns

        # Verify SQL does not include optional columns
        sql = mock_query.call_args[0][1]
        assert "cl.metadata" not in sql
        assert "cl.raw_payload" not in sql

    @patch("exporter.exporter.query")
    def test_includes_metadata_when_enabled(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions(include_metadata=True, include_raw_payload=False)
        get_chat_log("db-url", "user@test.com", "survey1", opts)

        sql = mock_query.call_args[0][1]
        assert "cl.metadata::string" in sql
        assert "cl.raw_payload" not in sql

    @patch("exporter.exporter.query")
    def test_includes_raw_payload_when_enabled(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions(include_metadata=False, include_raw_payload=True)
        get_chat_log("db-url", "user@test.com", "survey1", opts)

        sql = mock_query.call_args[0][1]
        assert "cl.raw_payload::string" in sql
        assert "cl.metadata" not in sql

    @patch("exporter.exporter.query")
    def test_includes_both_optional_columns(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions(include_metadata=True, include_raw_payload=True)
        get_chat_log("db-url", "user@test.com", "survey1", opts)

        sql = mock_query.call_args[0][1]
        assert "cl.metadata::string" in sql
        assert "cl.raw_payload::string" in sql

    @patch("exporter.exporter.query")
    def test_joins_through_surveys_and_users(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions()
        get_chat_log("db-url", "user@test.com", "survey1", opts)

        sql = mock_query.call_args[0][1]
        assert "INNER JOIN surveys s ON cl.shortcode = s.shortcode" in sql
        assert "INNER JOIN users u ON s.userid = u.id" in sql
        assert "u.email = %s" in sql
        assert "s.survey_name = %s" in sql

    @patch("exporter.exporter.query")
    def test_passes_user_and_survey_as_params(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions()
        get_chat_log("db-url", "user@test.com", "my-survey", opts)

        assert mock_query.call_args[1]["vals"] == ("user@test.com", "my-survey")


class TestExportChatLog:
    @patch("exporter.exporter.get_chat_log")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_success_flow(self, mock_status, mock_backend_factory, mock_get_chat_log):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://download-link"
        mock_backend_factory.return_value = mock_backend
        mock_get_chat_log.return_value = pd.DataFrame({"userid": ["u1"]})

        opts = ChatLogExportOptions()
        export_chat_log("db-url", "uuid-1", "user@test.com", "survey1", opts)

        # Verify storage backend path
        mock_backend_factory.assert_called_once_with(
            file_path="exports/survey1_chat_log.csv"
        )

        # Verify status updates: Started, then Finished
        assert mock_status.call_count == 2
        mock_status.assert_any_call("db-url", "uuid-1", status="Started")
        mock_status.assert_any_call("db-url", "uuid-1", "http://download-link", status="Finished")

        # Verify data was saved
        mock_backend.save_to_csv.assert_called_once()

    @patch("exporter.exporter.get_chat_log")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_failure_sets_failed_status(self, mock_status, mock_backend_factory, mock_get_chat_log):
        mock_get_chat_log.side_effect = RuntimeError("db error")

        opts = ChatLogExportOptions()
        with pytest.raises(RuntimeError, match="db error"):
            export_chat_log("db-url", "uuid-2", "user@test.com", "survey1", opts)

        # Verify status: Started, then Failed
        assert mock_status.call_count == 2
        mock_status.assert_any_call("db-url", "uuid-2", status="Started")
        mock_status.assert_any_call("db-url", "uuid-2", status="Failed")

    @patch("exporter.exporter.get_chat_log")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_empty_data_still_exports(self, mock_status, mock_backend_factory, mock_get_chat_log):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_get_chat_log.return_value = pd.DataFrame()

        opts = ChatLogExportOptions()
        export_chat_log("db-url", "uuid-3", "user@test.com", "survey1", opts)

        # Empty data still gets saved and status set to Finished
        mock_backend.save_to_csv.assert_called_once()
        mock_status.assert_any_call("db-url", "uuid-3", "http://link", status="Finished")
