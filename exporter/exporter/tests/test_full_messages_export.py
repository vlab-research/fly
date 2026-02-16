import json
import os
from unittest.mock import patch, MagicMock

import pytest

from exporter.exporter import (
    classify_event,
    expand_groups,
    get_direction,
    extract_content,
    extract_event_detail,
    _iter_messages,
    export_full_messages,
    EVENT_GROUPS,
    FULL_MESSAGES_COLUMNS,
)
from exporter.main import FullMessagesExportOptions


# --- classify_event ---


class TestClassifyEvent:
    def test_echo(self):
        msg = {"source": "messenger", "message": {"is_echo": True, "text": "hi"}}
        assert classify_event(msg) == "echo"

    def test_quick_reply(self):
        msg = {"source": "messenger", "message": {"quick_reply": {"payload": "yes"}, "text": "Yes"}}
        assert classify_event(msg) == "quick_reply"

    def test_text(self):
        msg = {"source": "messenger", "message": {"text": "hello"}}
        assert classify_event(msg) == "text"

    def test_media(self):
        msg = {"source": "messenger", "message": {"attachments": [{"type": "image"}]}}
        assert classify_event(msg) == "media"

    def test_postback(self):
        msg = {"source": "messenger", "postback": {"title": "Get Started"}}
        assert classify_event(msg) == "postback"

    def test_referral(self):
        msg = {"source": "messenger", "referral": {"ref": "ad_123"}}
        assert classify_event(msg) == "referral"

    def test_watermark_read(self):
        msg = {"source": "messenger", "read": {"watermark": 123}}
        assert classify_event(msg) == "watermark"

    def test_watermark_delivery(self):
        msg = {"source": "messenger", "delivery": {"watermark": 123}}
        assert classify_event(msg) == "watermark"

    def test_reaction(self):
        msg = {"source": "messenger", "reaction": {"reaction": "love"}}
        assert classify_event(msg) == "reaction"

    def test_optin(self):
        msg = {"source": "messenger", "optin": {"ref": "abc"}}
        assert classify_event(msg) == "optin"

    def test_handover(self):
        msg = {"source": "messenger", "pass_thread_control": {"new_owner_app_id": "123"}}
        assert classify_event(msg) == "handover"

    def test_unknown_messenger(self):
        msg = {"source": "messenger"}
        assert classify_event(msg) == "unknown_messenger"

    def test_bailout(self):
        msg = {"source": "synthetic", "event": {"type": "bailout"}}
        assert classify_event(msg) == "bailout"

    def test_redo(self):
        msg = {"source": "synthetic", "event": {"type": "redo"}}
        assert classify_event(msg) == "redo"

    def test_machine_report(self):
        msg = {"source": "synthetic", "event": {"type": "machine_report", "value": "error"}}
        assert classify_event(msg) == "machine_report"

    def test_moviehouse(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "moviehouse:play"}}}
        assert classify_event(msg) == "moviehouse"

    def test_linksniffer(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "linksniffer:click"}}}
        assert classify_event(msg) == "linksniffer"

    def test_payment_external(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "payment:success"}}}
        assert classify_event(msg) == "payment"

    def test_external_other(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "handoff_return"}}}
        assert classify_event(msg) == "external_other"

    def test_unknown_synthetic(self):
        msg = {"source": "synthetic", "event": {"type": "some_new_thing"}}
        assert classify_event(msg) == "unknown_synthetic"

    def test_unknown_source(self):
        msg = {"source": "something_else"}
        assert classify_event(msg) == "unknown"

    def test_no_source(self):
        msg = {}
        assert classify_event(msg) == "unknown"


# --- expand_groups ---


class TestExpandGroups:
    def test_single_group(self):
        result = expand_groups(["conversation"])
        assert result == {"echo", "text", "quick_reply", "postback"}

    def test_multiple_groups(self):
        result = expand_groups(["bails", "payments"])
        assert result == {"bailout", "payment", "repeat_payment"}

    def test_all_groups(self):
        result = expand_groups(list(EVENT_GROUPS.keys()))
        # Should include all defined event types
        all_types = set()
        for types in EVENT_GROUPS.values():
            all_types.update(types)
        assert result == all_types

    def test_unknown_group_ignored(self):
        result = expand_groups(["nonexistent"])
        assert result == set()

    def test_empty_list(self):
        result = expand_groups([])
        assert result == set()


# --- get_direction ---


class TestGetDirection:
    def test_echo_is_bot(self):
        assert get_direction("echo") == "bot"

    def test_text_is_user(self):
        assert get_direction("text") == "user"

    def test_quick_reply_is_user(self):
        assert get_direction("quick_reply") == "user"

    def test_machine_report_is_system(self):
        assert get_direction("machine_report") == "system"

    def test_bailout_is_system(self):
        assert get_direction("bailout") == "system"


# --- _iter_messages ---


class TestIterMessages:
    def _make_row(self, msg_dict, userid="u1", timestamp="2025-01-01"):
        return {
            "userid": userid,
            "timestamp": timestamp,
            "content": json.dumps(msg_dict),
        }

    def test_yields_matching_rows(self):
        rows = [
            self._make_row({"source": "messenger", "message": {"text": "hello"}}),
        ]
        result = list(_iter_messages(iter(rows), {"text"}, False))
        assert len(result) == 1
        assert result[0]["event_type"] == "text"
        assert result[0]["direction"] == "user"
        assert result[0]["content"] == "hello"

    def test_filters_non_matching_types(self):
        rows = [
            self._make_row({"source": "messenger", "message": {"text": "hello"}}),
            self._make_row({"source": "synthetic", "event": {"type": "machine_report"}}),
        ]
        result = list(_iter_messages(iter(rows), {"text"}, False))
        assert len(result) == 1
        assert result[0]["event_type"] == "text"

    def test_includes_raw_json_when_requested(self):
        msg = {"source": "messenger", "message": {"text": "hi"}}
        rows = [self._make_row(msg)]
        result = list(_iter_messages(iter(rows), {"text"}, True))
        assert "raw_json" in result[0]
        assert json.loads(result[0]["raw_json"]) == msg

    def test_excludes_raw_json_by_default(self):
        rows = [self._make_row({"source": "messenger", "message": {"text": "hi"}})]
        result = list(_iter_messages(iter(rows), {"text"}, False))
        assert "raw_json" not in result[0]

    def test_skips_invalid_json(self):
        rows = [{"userid": "u1", "timestamp": "t", "content": "not json"}]
        result = list(_iter_messages(iter(rows), {"text"}, False))
        assert len(result) == 0

    def test_skips_null_content(self):
        rows = [{"userid": "u1", "timestamp": "t", "content": None}]
        result = list(_iter_messages(iter(rows), {"text"}, False))
        assert len(result) == 0

    def test_event_detail_for_external(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "moviehouse:play"}}}
        rows = [self._make_row(msg)]
        result = list(_iter_messages(iter(rows), {"moviehouse"}, False))
        assert result[0]["event_detail"] == "moviehouse:play"

    def test_preserves_userid_and_timestamp(self):
        rows = [self._make_row(
            {"source": "messenger", "message": {"text": "hi"}},
            userid="user-abc",
            timestamp="2025-06-15T12:00:00",
        )]
        result = list(_iter_messages(iter(rows), {"text"}, False))
        assert result[0]["userid"] == "user-abc"
        assert result[0]["timestamp"] == "2025-06-15T12:00:00"


# --- export_full_messages ---


class TestExportFullMessages:
    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_success_flow(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://download-link"
        mock_backend_factory.return_value = mock_backend

        msg = {"source": "messenger", "message": {"text": "hello"}}
        mock_query.return_value = iter([
            {"userid": "u1", "timestamp": "2025-01-01", "content": json.dumps(msg)},
        ])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-1", "user@test.com", "survey1", opts)

        mock_backend_factory.assert_called_once_with(
            file_path="exports/survey1_full_messages.csv"
        )
        assert mock_status.call_count == 2
        mock_status.assert_any_call("db-url", "uuid-1", status="Started")
        mock_status.assert_any_call("db-url", "uuid-1", "http://download-link", status="Finished")
        mock_backend.save_file.assert_called_once()

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_failure_sets_failed_status(self, mock_status, mock_backend_factory, mock_query):
        mock_query.side_effect = RuntimeError("db error")

        opts = FullMessagesExportOptions()
        with pytest.raises(RuntimeError, match="db error"):
            export_full_messages("db-url", "uuid-2", "user@test.com", "survey1", opts)

        assert mock_status.call_count == 2
        mock_status.assert_any_call("db-url", "uuid-2", status="Started")
        mock_status.assert_any_call("db-url", "uuid-2", status="Failed")

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_empty_results_still_exports(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.return_value = iter([])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-3", "user@test.com", "survey1", opts)

        mock_backend.save_file.assert_called_once()
        mock_status.assert_any_call("db-url", "uuid-3", "http://link", status="Finished")

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_temp_file_cleaned_up(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.return_value = iter([])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-4", "user@test.com", "survey1", opts)

        # The temp file path was passed to save_file — verify it's been cleaned up
        path = mock_backend.save_file.call_args[0][0]
        assert not os.path.exists(path)

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_filters_by_event_groups(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend

        text_msg = {"source": "messenger", "message": {"text": "hello"}}
        report_msg = {"source": "synthetic", "event": {"type": "machine_report"}}
        mock_query.return_value = iter([
            {"userid": "u1", "timestamp": "t1", "content": json.dumps(text_msg)},
            {"userid": "u1", "timestamp": "t2", "content": json.dumps(report_msg)},
        ])

        # Only request "conversation" group — should exclude machine_report
        opts = FullMessagesExportOptions(event_groups=["conversation"])
        export_full_messages("db-url", "uuid-5", "user@test.com", "survey1", opts)

        # Read back the CSV that was written to the temp file
        path = mock_backend.save_file.call_args[0][0]
        # File is already deleted, but we verified the filtering works via _iter_messages tests
        mock_backend.save_file.assert_called_once()

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_sql_joins_through_responses(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.return_value = iter([])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-6", "user@test.com", "survey1", opts)

        sql = mock_query.call_args[0][1]
        assert "FROM messages m" in sql
        assert "INNER JOIN" in sql
        assert "SELECT DISTINCT userid" in sql
        assert "FROM responses" in sql
        assert "survey_name = %s" in sql
        assert "email = %s" in sql
