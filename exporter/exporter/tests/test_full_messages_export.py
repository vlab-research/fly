import json
import os
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest

from exporter.exporter import (
    parse_event,
    expand_groups,
    get_direction,
    _iter_messages,
    export_full_messages,
    EVENT_GROUPS,
    FULL_MESSAGES_COLUMNS,
)
from exporter.main import FullMessagesExportOptions
from exporter.tests.conftest import SNAPSHOT


# --- parse_event ---


class TestParseEvent:
    def test_echo(self):
        msg = {"source": "messenger", "message": {"is_echo": True, "text": "hi"}}
        assert parse_event(msg).type == "echo"

    def test_quick_reply(self):
        msg = {"source": "messenger", "message": {"quick_reply": {"payload": "yes"}, "text": "Yes"}}
        assert parse_event(msg).type == "quick_reply"

    def test_text(self):
        msg = {"source": "messenger", "message": {"text": "hello"}}
        assert parse_event(msg).type == "text"

    def test_media(self):
        msg = {"source": "messenger", "message": {"attachments": [{"type": "image"}]}}
        assert parse_event(msg).type == "media"

    def test_postback(self):
        msg = {"source": "messenger", "postback": {"title": "Get Started"}}
        assert parse_event(msg).type == "postback"

    def test_referral(self):
        msg = {"source": "messenger", "referral": {"ref": "ad_123"}}
        assert parse_event(msg).type == "referral"

    def test_watermark_read(self):
        msg = {"source": "messenger", "read": {"watermark": 123}}
        assert parse_event(msg).type == "watermark"

    def test_watermark_delivery(self):
        msg = {"source": "messenger", "delivery": {"watermark": 123}}
        assert parse_event(msg).type == "watermark"

    def test_reaction(self):
        msg = {"source": "messenger", "reaction": {"reaction": "love"}}
        assert parse_event(msg).type == "reaction"

    def test_optin(self):
        msg = {"source": "messenger", "optin": {"ref": "abc"}}
        assert parse_event(msg).type == "optin"

    def test_handover(self):
        msg = {"source": "messenger", "pass_thread_control": {"new_owner_app_id": "123"}}
        assert parse_event(msg).type == "handover"

    def test_unknown_messenger(self):
        msg = {"source": "messenger"}
        assert parse_event(msg).type == "unknown_messenger"

    def test_bailout(self):
        msg = {"source": "synthetic", "event": {"type": "bailout"}}
        assert parse_event(msg).type == "bailout"

    def test_redo(self):
        msg = {"source": "synthetic", "event": {"type": "redo"}}
        assert parse_event(msg).type == "redo"

    def test_machine_report(self):
        msg = {"source": "synthetic", "event": {"type": "machine_report", "value": "error"}}
        assert parse_event(msg).type == "machine_report"

    def test_moviehouse(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "moviehouse:play"}}}
        assert parse_event(msg).type == "moviehouse"

    def test_linksniffer(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "linksniffer:click"}}}
        assert parse_event(msg).type == "linksniffer"

    def test_payment_external(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "payment:success"}}}
        assert parse_event(msg).type == "payment"

    def test_external_other(self):
        msg = {"source": "synthetic", "event": {"type": "external", "value": {"type": "handoff_return"}}}
        assert parse_event(msg).type == "external_other"

    def test_unknown_synthetic(self):
        msg = {"source": "synthetic", "event": {"type": "some_new_thing"}}
        assert parse_event(msg).type == "unknown_synthetic"

    def test_unknown_source(self):
        msg = {"source": "something_else"}
        assert parse_event(msg).type == "unknown"

    def test_no_source(self):
        msg = {}
        assert parse_event(msg).type == "unknown"


# WhatsApp rows as Hermes publishes them: one Cloud API `messages[]` or
# `statuses[]` item, with source, phone_number_id, the identity envelope and a
# millisecond timestamp added.
def _wa(**fields):
    return {
        "source": "whatsapp",
        "platform": "whatsapp",
        "account_id": "PHONE_ID_1",
        "phone_number_id": "PHONE_ID_1",
        "timestamp": 1640995200000,
        **fields,
    }


def _wa_inbound(**fields):
    return _wa(**{"from": "27123456789", "id": "wamid.abc", **fields})


def _wa_status(status, **fields):
    return _wa(**{"id": "wamid.abc", "status": status, "recipient_id": "27123456789", **fields})


def _bot_echo(source="whatsapp", **fields):
    return {
        "source": source,
        "account_id": "PHONE_ID_1",
        "platform": source,
        "phone_number_id": "PHONE_ID_1",
        "from": "27123456789",
        "type": "bot_echo",
        "metadata": {"ref": "q1", "type": "multiple_choice"},
        "timestamp": 1640995200000,
        **fields,
    }


class TestParseWhatsApp:
    @pytest.mark.parametrize("msg, expected", [
        (_wa_inbound(type="text", text={"body": "Hello bot!"}), ("text", "Hello bot!")),
        (_wa_inbound(type="interactive", interactive={
            "type": "button_reply", "button_reply": {"id": "r0", "title": "Red"}}),
         ("quick_reply", "Red")),
        (_wa_inbound(type="interactive", interactive={
            "type": "list_reply", "list_reply": {"id": "r3", "title": "Lagos", "description": "x"}}),
         ("quick_reply", "Lagos")),
        (_wa_inbound(type="button", button={"text": "Confirm", "payload": "p1"}),
         ("quick_reply", "Confirm")),
        (_wa_inbound(type="image", image={"id": "1234", "mime_type": "image/jpeg"}), ("media", "image")),
        (_wa_inbound(type="video", video={"id": "1234"}), ("media", "video")),
        (_wa_inbound(type="audio", audio={"id": "1234"}), ("media", "audio")),
        (_wa_inbound(type="voice", voice={"id": "1234"}), ("media", "audio")),
        (_wa_inbound(type="document", document={"id": "1234"}), ("media", "document")),
        (_wa_inbound(type="sticker", sticker={"id": "1234"}), ("media", "sticker")),
        (_wa_inbound(type="reaction", reaction={"message_id": "wamid.x", "emoji": "👍"}),
         ("reaction", "👍")),
        (_wa_status("sent"), ("watermark", "sent")),
        (_wa_status("delivered"), ("watermark", "delivered")),
        (_wa_status("read"), ("watermark", "read")),
        (_wa_inbound(type="location", location={"latitude": 1, "longitude": 2}),
         ("unknown_whatsapp", "")),
    ])
    def test_shapes(self, msg, expected):
        event = parse_event(msg)
        assert (event.type, event.content) == expected

    def test_referral_with_ref(self):
        msg = _wa_inbound(type="text", text={"body": "Hi"}, referral={"ref": "form.ABC", "ctwa_clid": "c1"})
        assert parse_event(msg) == ("referral", "form.ABC", "")

    def test_ctwa_referral_without_ref_reads_the_autofill_text(self):
        msg = _wa_inbound(type="text", text={"body": "form.ABC.creative.x"},
                          referral={"source_type": "ad", "ctwa_clid": "c1"})
        assert parse_event(msg) == ("referral", "form.ABC.creative.x", "")

    def test_bare_form_token_is_text(self):
        msg = _wa_inbound(type="text", text={"body": "form.ABC"})
        assert parse_event(msg) == ("text", "form.ABC", "")

    def test_null_text_body(self):
        assert parse_event(_wa_inbound(type="text", text=None)) == ("text", "", "")

    def test_failed_status_is_a_send_failure_not_a_watermark(self):
        msg = _wa_status("failed", errors=[{
            "code": 131047, "title": "Re-engagement message",
            "error_data": {"details": "more than 24 hours"}}])
        assert parse_event(msg) == ("send_failed", "131047: Re-engagement message", "")

    def test_failed_status_without_errors(self):
        assert parse_event(_wa_status("failed")) == ("send_failed", "", "")

    def test_send_failed_is_system(self):
        assert get_direction("send_failed") == "system"
        assert "send_failed" in EVENT_GROUPS["system"]


class TestParseBotEcho:
    def test_whatsapp_echo_is_bot_text(self):
        assert parse_event(_bot_echo(text="What is your favourite colour?")) == (
            "echo", "What is your favourite colour?", "")

    def test_echo_without_text_is_still_a_bot_row(self):
        # Echoes published before message-worker added `text`.
        assert parse_event(_bot_echo()) == ("echo", "", "")

    def test_matched_before_the_source_dispatch(self):
        # A messenger-sourced bot_echo would otherwise be unknown_messenger.
        assert parse_event(_bot_echo(source="messenger", text="hi")) == ("echo", "hi", "")


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

    def test_mixed_platform_conversation_exports_both_sides_of_both(self):
        rows = [
            self._make_row({"source": "messenger", "message": {"is_echo": True, "text": "Q1?"}}, "fb"),
            self._make_row({"source": "messenger", "message": {"quick_reply": {"payload": "y"}, "text": "Yes"}}, "fb"),
            self._make_row(_bot_echo(text="Q1?"), "wa"),
            self._make_row(_wa_inbound(type="interactive", interactive={
                "type": "button_reply", "button_reply": {"id": "r0", "title": "Yes"}}), "wa"),
            self._make_row(_wa_status("read"), "wa"),
        ]
        result = list(_iter_messages(iter(rows), expand_groups(["conversation"]), False))
        assert [(r["userid"], r["source"], r["direction"], r["content"]) for r in result] == [
            ("fb", "messenger", "bot", "Q1?"),
            ("fb", "messenger", "user", "Yes"),
            ("wa", "whatsapp", "bot", "Q1?"),
            ("wa", "whatsapp", "user", "Yes"),
        ]

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


def _mock_query_two_step(userids, message_rows):
    """Helper: mock query() for the two-step batched approach.

    First call returns userids (as tuples), subsequent calls return message rows.
    """
    userid_results = [(uid,) for uid in userids]
    calls = [iter(userid_results)] + [iter(rows) for rows in message_rows]
    return calls


class TestExportFullMessages:
    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_success_flow(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://download-link"
        mock_backend_factory.return_value = mock_backend

        msg = {"source": "messenger", "message": {"text": "hello"}}
        message_rows = [
            {"userid": "u1", "timestamp": "2025-01-01", "content": json.dumps(msg)},
        ]
        mock_query.side_effect = _mock_query_two_step(["u1"], [message_rows])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-1", "user@test.com", "survey1", opts)

        mock_backend_factory.assert_called_once_with(
            file_path="exports/f02f61d33aac1c8d/survey1_full_messages.csv"
        )
        mock_status.assert_any_call("db-url", "uuid-1", status="Querying")
        mock_status.assert_any_call("db-url", "uuid-1", status="Writing")
        mock_status.assert_any_call("db-url", "uuid-1", status="Uploading")
        mock_status.assert_any_call("db-url", "uuid-1", "http://download-link", status="Finished")
        mock_backend.save_file.assert_called_once()
        assert {c.kwargs["as_of"] for c in mock_query.call_args_list} == {SNAPSHOT}

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_failure_is_raised_for_the_worker(self, mock_status, mock_backend_factory, mock_query):
        mock_query.side_effect = RuntimeError("db error")

        opts = FullMessagesExportOptions()
        with pytest.raises(RuntimeError, match="db error"):
            export_full_messages("db-url", "uuid-2", "user@test.com", "survey1", opts)

        # main.run_job decides between a retry and Failed.
        assert [c.kwargs["status"] for c in mock_status.call_args_list] == ["Querying"]

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_empty_results_still_exports(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.side_effect = _mock_query_two_step([], [])

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
        mock_query.side_effect = _mock_query_two_step([], [])

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
        message_rows = [
            {"userid": "u1", "timestamp": "t1", "content": json.dumps(text_msg)},
            {"userid": "u1", "timestamp": "t2", "content": json.dumps(report_msg)},
        ]
        mock_query.side_effect = _mock_query_two_step(["u1"], [message_rows])

        # Only request "conversation" group — should exclude machine_report
        opts = FullMessagesExportOptions(event_groups=["conversation"])
        export_full_messages("db-url", "uuid-5", "user@test.com", "survey1", opts)

        mock_backend.save_file.assert_called_once()

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_two_step_query_structure(self, mock_status, mock_backend_factory, mock_query):
        """Verify the batched two-step approach: first userids, then messages per batch."""
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.side_effect = _mock_query_two_step(["u1", "u2"], [[]])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-6", "user@test.com", "survey1", opts)

        # First call: userid query — joins through surveyid (not shortcode) so
        # foreign owners' surveys sharing a shortcode aren't pulled in.
        first_sql = mock_query.call_args_list[0][0][1]
        assert "SELECT DISTINCT r.userid" in first_sql
        assert "FROM responses r" in first_sql
        assert "JOIN surveys s ON r.surveyid = s.id" in first_sql
        assert "survey_name = %s" in first_sql
        assert "email = %s" in first_sql

        # Second call: messages query with IN clause
        second_sql = mock_query.call_args_list[1][0][1]
        assert "FROM messages m" in second_sql
        assert "WHERE m.userid IN" in second_sql

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_batches_large_user_sets(self, mock_status, mock_backend_factory, mock_query):
        """Verify that >500 users are split into multiple batches."""
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend

        userids = [f"u{i}" for i in range(750)]
        # First call returns userids, next two calls return empty message batches
        mock_query.side_effect = _mock_query_two_step(userids, [[], []])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-7", "user@test.com", "survey1", opts)

        # Should be 3 calls: 1 userid query + 2 message batches (500 + 250)
        assert mock_query.call_count == 3

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_no_time_bounds_omits_predicates(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.side_effect = _mock_query_two_step(["u1"], [[]])

        opts = FullMessagesExportOptions()
        export_full_messages("db-url", "uuid-8", "user@test.com", "survey1", opts)

        # Unbounded run keeps the original filename
        mock_backend_factory.assert_called_once_with(
            file_path="exports/f02f61d33aac1c8d/survey1_full_messages.csv"
        )

        # Messages query should not mention timestamp filters
        msg_sql = mock_query.call_args_list[1][0][1]
        msg_vals = mock_query.call_args_list[1][1]["vals"]
        assert "m.timestamp >=" not in msg_sql
        assert "m.timestamp <" not in msg_sql
        assert msg_vals == ("u1",)

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_both_time_bounds_appended(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.side_effect = _mock_query_two_step(["u1"], [[]])

        start = datetime(2025, 10, 1, tzinfo=timezone.utc)
        end = datetime(2025, 11, 1, tzinfo=timezone.utc)
        opts = FullMessagesExportOptions(start_time=start, end_time=end)
        export_full_messages("db-url", "uuid-9", "user@test.com", "survey1", opts)

        # Filename suffix encodes the window
        mock_backend_factory.assert_called_once_with(
            file_path="exports/f02f61d33aac1c8d/survey1_full_messages_20251001T000000Z_to_20251101T000000Z.csv"
        )

        msg_sql = mock_query.call_args_list[1][0][1]
        msg_vals = mock_query.call_args_list[1][1]["vals"]
        assert "m.timestamp >= %s" in msg_sql
        assert "m.timestamp < %s" in msg_sql
        # batch userid + start + end
        assert msg_vals == ("u1", start, end)

    @patch("exporter.exporter.query")
    @patch("exporter.exporter.storage.get_storage_backend")
    @patch("exporter.exporter.set_export_status")
    def test_start_only_bound(self, mock_status, mock_backend_factory, mock_query):
        mock_backend = MagicMock()
        mock_backend.generate_link.return_value = "http://link"
        mock_backend_factory.return_value = mock_backend
        mock_query.side_effect = _mock_query_two_step(["u1"], [[]])

        start = datetime(2025, 10, 1, tzinfo=timezone.utc)
        opts = FullMessagesExportOptions(start_time=start)
        export_full_messages("db-url", "uuid-10", "user@test.com", "survey1", opts)

        mock_backend_factory.assert_called_once_with(
            file_path="exports/f02f61d33aac1c8d/survey1_full_messages_20251001T000000Z_to_open.csv"
        )

        msg_sql = mock_query.call_args_list[1][0][1]
        msg_vals = mock_query.call_args_list[1][1]["vals"]
        assert "m.timestamp >= %s" in msg_sql
        assert "m.timestamp <" not in msg_sql
        assert msg_vals == ("u1", start)
