import json
from unittest.mock import patch, MagicMock

import pytest

from exporter.main import (
    ChatLogExportOptions,
    KafkaMessage,
    parse_message,
    process,
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


class TestKafkaMessage:
    def test_parses_response_export(self):
        msg = KafkaMessage(
            event="data-export",
            survey="my-survey",
            user="user@example.com",
            export_id="abc-123",
        )
        assert msg.source == "responses"
        assert msg.export_id == "abc-123"
        assert msg.options == ExportOptions()
        assert msg.chat_log_options == ChatLogExportOptions()

    def test_parses_chat_log_export(self):
        msg = KafkaMessage(
            event="data-export",
            survey="my-survey",
            user="user@example.com",
            export_id="def-456",
            source="chat_log",
            chat_log_options={"include_raw_payload": True, "include_metadata": False},
        )
        assert msg.source == "chat_log"
        assert msg.chat_log_options.include_raw_payload is True
        assert msg.chat_log_options.include_metadata is False

    def test_missing_export_id_raises(self):
        with pytest.raises(Exception):
            KafkaMessage(
                event="data-export",
                survey="my-survey",
                user="user@example.com",
            )

    def test_source_defaults_to_responses(self):
        msg = KafkaMessage(
            event="data-export",
            survey="my-survey",
            user="user@example.com",
            export_id="abc-123",
        )
        assert msg.source == "responses"

    def test_options_default_to_empty(self):
        msg = KafkaMessage(
            event="data-export",
            survey="my-survey",
            user="user@example.com",
            export_id="abc-123",
        )
        assert msg.options == ExportOptions()
        assert msg.chat_log_options == ChatLogExportOptions()


class TestParseMessage:
    def test_parses_kafka_message(self):
        payload = {
            "event": "data-export",
            "survey": "test-survey",
            "user": "test@example.com",
            "export_id": "uuid-here",
            "source": "chat_log",
            "chat_log_options": {"include_metadata": True},
        }
        mock_msg = MagicMock()
        mock_msg.value.return_value = json.dumps(payload).encode("utf-8")

        result = parse_message(mock_msg)

        assert isinstance(result, KafkaMessage)
        assert result.export_id == "uuid-here"
        assert result.source == "chat_log"
        assert result.chat_log_options.include_metadata is True


class TestProcess:
    @patch("exporter.main.export_data")
    def test_routes_responses_to_export_data(self, mock_export_data):
        data = KafkaMessage(
            event="data-export",
            survey="my-survey",
            user="user@example.com",
            export_id="id-1",
            source="responses",
            options={"pivot": True, "response_value": "response"},
        )

        process("db-url", data)

        mock_export_data.assert_called_once_with(
            "db-url", "id-1", "user@example.com", "my-survey", data.options
        )

    @patch("exporter.main.export_chat_log")
    def test_routes_chat_log_to_export_chat_log(self, mock_export_chat_log):
        data = KafkaMessage(
            event="data-export",
            survey="my-survey",
            user="user@example.com",
            export_id="id-2",
            source="chat_log",
            chat_log_options={"include_raw_payload": True},
        )

        process("db-url", data)

        mock_export_chat_log.assert_called_once_with(
            "db-url", "id-2", "user@example.com", "my-survey", data.chat_log_options
        )
