from unittest.mock import patch, MagicMock, call

import os
import pytest

from exporter.exporter import (
    set_export_status,
    export_chat_log,
    get_chat_log,
)
from exporter.main import ChatLogExportOptions
from exporter.tests.conftest import SNAPSHOT


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
        row = ("u1", "p1", "2025-01-01", "incoming", "hello", "q1", "sc1", "s1", "text")
        mock_query.return_value = iter([row])

        opts = ChatLogExportOptions(include_metadata=False, include_raw_payload=False)
        result = list(get_chat_log("db-url", "user@test.com", "survey1", opts, ["u1"], as_of=None))

        assert result == [row]

        # Verify SQL does not include optional columns
        sql = mock_query.call_args[0][1]
        assert "cl.metadata" not in sql
        assert "cl.raw_payload" not in sql

    @patch("exporter.exporter.query")
    def test_includes_metadata_when_enabled(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions(include_metadata=True, include_raw_payload=False)
        get_chat_log("db-url", "user@test.com", "survey1", opts, ["u1"], as_of=None)

        sql = mock_query.call_args[0][1]
        assert "cl.metadata::string" in sql
        assert "cl.raw_payload" not in sql

    @patch("exporter.exporter.query")
    def test_includes_raw_payload_when_enabled(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions(include_metadata=False, include_raw_payload=True)
        get_chat_log("db-url", "user@test.com", "survey1", opts, ["u1"], as_of=None)

        sql = mock_query.call_args[0][1]
        assert "cl.raw_payload::string" in sql
        assert "cl.metadata" not in sql

    @patch("exporter.exporter.query")
    def test_includes_both_optional_columns(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions(include_metadata=True, include_raw_payload=True)
        get_chat_log("db-url", "user@test.com", "survey1", opts, ["u1"], as_of=None)

        sql = mock_query.call_args[0][1]
        assert "cl.metadata::string" in sql
        assert "cl.raw_payload::string" in sql

    @patch("exporter.exporter.query")
    def test_joins_through_surveys_and_users(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions()
        get_chat_log("db-url", "user@test.com", "survey1", opts, ["u1"], as_of=None)

        sql = mock_query.call_args[0][1]
        assert "INNER JOIN surveys s ON cl.shortcode = s.shortcode" in sql
        assert "INNER JOIN users u ON s.userid = u.id" in sql
        assert "u.email = %s" in sql
        assert "s.survey_name = %s" in sql

    @patch("exporter.exporter.query")
    def test_passes_user_survey_and_batch_as_params(self, mock_query):
        mock_query.return_value = iter([])

        opts = ChatLogExportOptions()
        get_chat_log("db-url", "user@test.com", "my-survey", opts, ["u1", "u2"], as_of=SNAPSHOT)

        sql = mock_query.call_args[0][1]
        assert "cl.userid IN (%s,%s)" in sql
        assert mock_query.call_args[1]["vals"] == ("user@test.com", "my-survey", "u1", "u2")
        assert mock_query.call_args[1]["as_of"] == SNAPSHOT


def _backend():
    backend = MagicMock()
    backend.generate_link.return_value = "http://download-link"
    backend.uploaded = None

    def save_file(path):
        with open(path, newline="") as f:
            backend.uploaded = f.read()

    backend.save_file.side_effect = save_file
    return backend


class TestExportChatLog:
    @patch("exporter.exporter.get_chat_log")
    @patch("exporter.exporter.get_chat_log_userids")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_success_flow(self, mock_status, mock_backend_factory, mock_userids, mock_get_chat_log):
        backend = _backend()
        mock_backend_factory.return_value = backend
        mock_userids.return_value = ["u1"]
        mock_get_chat_log.return_value = iter([
            ("u1", "p1", "2025-01-01", "incoming", "hi, there", None, "sc1", "s1", "text"),
        ])

        opts = ChatLogExportOptions()
        export_chat_log("db-url", "uuid-1", "user@test.com", "survey1", opts)

        # Verify storage backend path
        mock_backend_factory.assert_called_once_with(
            file_path="exports/survey1_chat_log.csv"
        )

        # Verify status progressed through stages and ended Finished
        mock_status.assert_any_call("db-url", "uuid-1", status="Querying")
        mock_status.assert_any_call("db-url", "uuid-1", status="Writing")
        mock_status.assert_any_call("db-url", "uuid-1", status="Uploading")
        mock_status.assert_any_call("db-url", "uuid-1", "http://download-link", status="Finished")

        assert backend.uploaded == (
            "userid,pageid,timestamp,direction,content,question_ref,shortcode,surveyid,message_type\n"
            'u1,p1,2025-01-01,incoming,"hi, there",,sc1,s1,text\n'
        )

    @patch("exporter.exporter.get_chat_log")
    @patch("exporter.exporter.get_chat_log_userids")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_queries_in_user_batches(self, mock_status, mock_backend_factory, mock_userids, mock_get_chat_log):
        backend = _backend()
        mock_backend_factory.return_value = backend
        mock_userids.return_value = ["u1", "u2", "u3"]
        mock_get_chat_log.side_effect = lambda cnf, user, survey, opts, batch, as_of: iter(
            [(u, "p", "t", "d", "c", "q", "sc", "s", "m") for u in batch]
        )

        opts = ChatLogExportOptions()
        export_chat_log("db-url", "uuid-1", "user@test.com", "survey1", opts, batch_size=2)

        batches = [c[0][4] for c in mock_get_chat_log.call_args_list]
        assert batches == [["u1", "u2"], ["u3"]]
        assert mock_userids.call_args[1]["as_of"] == SNAPSHOT
        assert {c[1]["as_of"] for c in mock_get_chat_log.call_args_list} == {SNAPSHOT}
        assert [line.split(",")[0] for line in backend.uploaded.splitlines()] == [
            "userid", "u1", "u2", "u3",
        ]

    @patch("exporter.exporter.get_chat_log_userids")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_failure_is_raised_for_the_worker(self, mock_status, mock_backend_factory, mock_userids):
        mock_userids.side_effect = RuntimeError("db error")

        opts = ChatLogExportOptions()
        with pytest.raises(RuntimeError, match="db error"):
            export_chat_log("db-url", "uuid-2", "user@test.com", "survey1", opts)

        # main.run_job decides between a retry and Failed.
        assert mock_status.call_args_list == [call("db-url", "uuid-2", status="Querying")]

    @patch("exporter.exporter.get_chat_log_userids")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_empty_data_exports_header_only(self, mock_status, mock_backend_factory, mock_userids):
        backend = _backend()
        mock_backend_factory.return_value = backend
        mock_userids.return_value = []

        opts = ChatLogExportOptions(include_metadata=True, include_raw_payload=True)
        export_chat_log("db-url", "uuid-3", "user@test.com", "survey1", opts)

        assert backend.uploaded == (
            "userid,pageid,timestamp,direction,content,question_ref,shortcode,"
            "surveyid,message_type,metadata,raw_payload\n"
        )
        mock_status.assert_any_call("db-url", "uuid-3", "http://download-link", status="Finished")
        assert not os.path.exists(backend.save_file.call_args[0][0])
