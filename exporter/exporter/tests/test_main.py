from unittest.mock import patch, MagicMock, call

import pytest

from exporter.main import (
    ChatLogExportOptions,
    FullMessagesExportOptions,
    claim_job,
    reset_for_retry,
    process_job,
)
from exporter.exporter import ExportOptions


class TestChatLogExportOptions:
    def test_defaults(self):
        opts = ChatLogExportOptions()
        assert opts.include_raw_payload is False
        assert opts.include_metadata is False

    def test_custom_values(self):
        opts = ChatLogExportOptions(include_raw_payload=True, include_metadata=True)
        assert opts.include_raw_payload is True
        assert opts.include_metadata is True


class TestFullMessagesExportOptions:
    def test_defaults(self):
        opts = FullMessagesExportOptions()
        assert len(opts.event_groups) == 8
        assert "conversation" in opts.event_groups
        assert opts.include_raw_json is False

    def test_custom_values(self):
        opts = FullMessagesExportOptions(
            event_groups=["conversation", "bails"],
            include_raw_json=True,
        )
        assert opts.event_groups == ["conversation", "bails"]
        assert opts.include_raw_json is True


class TestProcessJob:
    @patch("exporter.main.export_data")
    def test_routes_responses(self, mock_export_data):
        job = {
            "id": "id-1", "user_id": "user@example.com", "survey_id": "my-survey",
            "source": "responses", "options": {"pivot": False}, "retry_count": 1,
        }
        process_job("db-url", job)
        mock_export_data.assert_called_once()
        args = mock_export_data.call_args[0]
        assert args[0] == "db-url"
        assert args[1] == "id-1"
        assert args[2] == "user@example.com"
        assert args[3] == "my-survey"
        assert isinstance(args[4], ExportOptions)

    @patch("exporter.main.export_chat_log")
    def test_routes_chat_log(self, mock_export_chat_log):
        job = {
            "id": "id-2", "user_id": "user@example.com", "survey_id": "my-survey",
            "source": "chat_log",
            "options": {"include_raw_payload": True, "include_metadata": False},
            "retry_count": 1,
        }
        process_job("db-url", job)
        mock_export_chat_log.assert_called_once()
        opts = mock_export_chat_log.call_args[0][4]
        assert isinstance(opts, ChatLogExportOptions)
        assert opts.include_raw_payload is True

    @patch("exporter.main.export_full_messages")
    def test_routes_full_messages(self, mock_export_full_messages):
        job = {
            "id": "id-3", "user_id": "user@example.com", "survey_id": "my-survey",
            "source": "full_messages",
            "options": {"event_groups": ["conversation"], "include_raw_json": True},
            "retry_count": 1,
        }
        process_job("db-url", job)
        mock_export_full_messages.assert_called_once()
        opts = mock_export_full_messages.call_args[0][4]
        assert isinstance(opts, FullMessagesExportOptions)
        assert opts.event_groups == ["conversation"]
        assert opts.include_raw_json is True

    @patch("exporter.main.export_data")
    def test_null_options_uses_defaults(self, mock_export_data):
        job = {
            "id": "id-4", "user_id": "u@e.com", "survey_id": "s",
            "source": "responses", "options": None, "retry_count": 1,
        }
        process_job("db-url", job)
        opts = mock_export_data.call_args[0][4]
        assert opts == ExportOptions()


class TestClaimJob:
    @patch("exporter.main.query")
    @patch("exporter.main.execute")
    def test_returns_none_when_no_requested_jobs(self, mock_execute, mock_query):
        mock_query.return_value = iter([])
        result = claim_job("db-url", max_retries=3, stuck_timeout_minutes=120)
        assert result is None

    @patch("exporter.main.query")
    @patch("exporter.main.execute")
    def test_returns_none_when_claim_lost_to_race(self, mock_execute, mock_query):
        # SELECT returns a candidate but UPDATE returns nothing (another worker claimed it)
        mock_query.side_effect = [iter([("job-id-1",)]), iter([])]
        result = claim_job("db-url", max_retries=3, stuck_timeout_minutes=120)
        assert result is None

    @patch("exporter.main.query")
    @patch("exporter.main.execute")
    def test_returns_claimed_job(self, mock_execute, mock_query):
        job_row = {
            "id": "job-1", "user_id": "u@e.com", "survey_id": "s",
            "source": "responses", "options": {}, "retry_count": 1,
        }
        mock_query.side_effect = [iter([("job-1",)]), iter([job_row])]
        result = claim_job("db-url", max_retries=3, stuck_timeout_minutes=120)
        assert result == job_row

    @patch("exporter.main.query")
    @patch("exporter.main.execute")
    def test_marks_failed_when_max_retries_exceeded(self, mock_execute, mock_query):
        job_row = {
            "id": "job-1", "user_id": "u@e.com", "survey_id": "s",
            "source": "responses", "options": {}, "retry_count": 4,  # > max_retries=3
        }
        mock_query.side_effect = [iter([("job-1",)]), iter([job_row])]
        result = claim_job("db-url", max_retries=3, stuck_timeout_minutes=120)
        assert result is None
        # Should have called execute to mark it Failed
        failed_calls = [c for c in mock_execute.call_args_list if "Failed" in str(c)]
        assert len(failed_calls) == 1

    @patch("exporter.main.query")
    @patch("exporter.main.execute")
    def test_resets_stale_processing_jobs(self, mock_execute, mock_query):
        mock_query.return_value = iter([])
        claim_job("db-url", max_retries=3, stuck_timeout_minutes=60)
        # First execute call should reset stale jobs
        first_call_sql = mock_execute.call_args_list[0][0][1]
        assert "Requested" in first_call_sql
        assert "Processing" in first_call_sql


class TestResetForRetry:
    @patch("exporter.main.execute")
    def test_resets_to_requested(self, mock_execute):
        reset_for_retry("db-url", "job-123")
        sql = mock_execute.call_args[0][1]
        vals = mock_execute.call_args[1]["vals"]
        assert "Requested" in sql
        assert vals == ("job-123",)
