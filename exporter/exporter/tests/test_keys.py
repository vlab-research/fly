"""Export object keys must be unique per owner (VIR-23).

An export that overwrites another owner's object succeeds perfectly, so these
tests assert on the key and on what a previously issued link resolves to, never
on export success alone.
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pandas as pd
import polars as pl
import pytest

from exporter.exporter import export_chat_log, export_data, export_full_messages
from exporter.keys import (
    EXPORTS_PREFIX,
    chat_log_key,
    full_messages_key,
    owner_prefix,
    responses_key,
)
from exporter.main import ChatLogExportOptions, FullMessagesExportOptions
from exporter.exporter import ExportOptions

ALICE = "alice@example.org"
BOB = "bob@example.org"
SURVEY = "default"

START = datetime(2025, 10, 1, tzinfo=timezone.utc)
END = datetime(2025, 11, 1, tzinfo=timezone.utc)

KEY_BUILDERS = {
    "responses": responses_key,
    "chat_log": chat_log_key,
    "full_messages": full_messages_key,
    "full_messages_windowed": lambda u, s: full_messages_key(u, s, START, END),
}


class TestOwnerPrefix:
    def test_pinned_value(self):
        # dashboard-server/api/exports/exports.keys.test.js pins the same
        # values; if either side changes its digest, both tests must change.
        assert owner_prefix(ALICE) == "7a64adf28737ea90"
        assert owner_prefix(BOB) == "686b5e4cf4f963ad"

    def test_does_not_contain_the_email(self):
        assert "alice" not in owner_prefix(ALICE)
        assert "@" not in responses_key(ALICE, SURVEY)


@pytest.mark.parametrize("kind", sorted(KEY_BUILDERS))
class TestKeyProperties:
    def test_same_survey_name_different_owners_get_different_keys(self, kind):
        build = KEY_BUILDERS[kind]
        assert build(ALICE, SURVEY) != build(BOB, SURVEY)

    def test_same_owner_and_survey_is_stable(self, kind):
        build = KEY_BUILDERS[kind]
        assert build(ALICE, SURVEY) == build(ALICE, SURVEY)

    def test_stays_under_the_lifecycle_prefix(self, kind):
        # storage._ensure_lifecycle expires only keys under exports/.
        assert KEY_BUILDERS[kind](ALICE, SURVEY).startswith(EXPORTS_PREFIX)

    def test_is_namespaced_by_owner(self, kind):
        key = KEY_BUILDERS[kind](ALICE, SURVEY)
        assert key.startswith(f"{EXPORTS_PREFIX}{owner_prefix(ALICE)}/")


def test_artifact_types_do_not_collide_for_one_owner():
    keys = {build(ALICE, SURVEY) for build in KEY_BUILDERS.values()}
    assert len(keys) == len(KEY_BUILDERS)


def test_exact_key_shapes():
    p = owner_prefix(ALICE)
    assert responses_key(ALICE, SURVEY) == f"exports/{p}/default.csv"
    assert chat_log_key(ALICE, SURVEY) == f"exports/{p}/default_chat_log.csv"
    assert full_messages_key(ALICE, SURVEY) == f"exports/{p}/default_full_messages.csv"
    assert (
        full_messages_key(ALICE, SURVEY, START, None)
        == f"exports/{p}/default_full_messages_20251001T000000Z_to_open.csv"
    )


# --- end to end through the export functions, against an in-memory bucket ---


class FakeBucket:
    """Object store whose presigned link is the key itself, so resolving a link
    after a later export shows exactly what its holder would download."""

    def __init__(self):
        self.objects = {}

    def backend(self, file_path):
        bucket = self
        b = MagicMock()
        def save_file(temp_path):
            with open(temp_path, 'r') as f:
                bucket.objects[file_path] = f.read()
        b.save_file.side_effect = save_file
        b.generate_link.return_value = file_path
        return b


def _links(mock_status):
    return [
        c.args[2]
        for c in mock_status.call_args_list
        if c.kwargs.get("status") == "Finished"
    ]


@patch("exporter.exporter.set_metadata")
@patch("exporter.exporter.set_export_status")
@patch("exporter.exporter.storage.get_storage_backend")
@patch("exporter.exporter.format_data", side_effect=lambda r, f, o, q: r)
@patch("exporter.exporter.get_form_data")
@patch("exporter.exporter.get_responses")
@patch("exporter.exporter.get_survey_userids")
@patch("exporter.exporter.query")
def test_responses_later_export_cannot_overwrite_earlier_owners_link(
    mock_query, mock_userids, mock_responses, mock_form, _format, mock_factory, mock_status, _meta
):
    bucket = FakeBucket()
    mock_factory.side_effect = lambda file_path: bucket.backend(file_path)
    mock_form.return_value = pd.DataFrame()

    alice_uid = f"respondent-of-{ALICE}"
    bob_uid = f"respondent-of-{BOB}"
    mock_userids.side_effect = [
        [alice_uid],  # First export (ALICE)
        [bob_uid],    # Second export (BOB)
    ]

    mock_responses.side_effect = [
        pl.DataFrame({"userid": [alice_uid]}),
        pl.DataFrame({"userid": [bob_uid]}),
    ]

    export_data("db", "exp-a", ALICE, SURVEY, ExportOptions())
    export_data("db", "exp-b", BOB, SURVEY, ExportOptions())

    alice_link, bob_link = _links(mock_status)
    assert alice_link != bob_link
    assert alice_uid in bucket.objects[alice_link]
    assert bob_uid not in bucket.objects[alice_link]
    assert alice_uid not in bucket.objects[bob_link]


@patch("exporter.exporter.set_metadata")
@patch("exporter.exporter.set_export_status")
@patch("exporter.exporter.storage.get_storage_backend")
@patch("exporter.exporter.get_chat_log")
@patch("exporter.exporter.get_chat_log_userids")
@patch("exporter.exporter.query")
def test_chat_log_later_export_cannot_overwrite_earlier_owners_link(
    mock_query, mock_userids, mock_chat_log, mock_factory, mock_status, _meta
):
    bucket = FakeBucket()
    mock_factory.side_effect = lambda file_path: bucket.backend(file_path)

    alice_uid = f"respondent-of-{ALICE}"
    bob_uid = f"respondent-of-{BOB}"
    mock_userids.side_effect = [
        [alice_uid],
        [bob_uid],
    ]

    mock_chat_log.side_effect = [
        iter([(alice_uid, "p1", "2025-01-01", "incoming", f"message-for-{ALICE}", None, "sc1", "s1", "text")]),
        iter([(bob_uid, "p1", "2025-01-01", "incoming", f"message-for-{BOB}", None, "sc1", "s1", "text")]),
    ]

    export_chat_log("db", "exp-a", ALICE, SURVEY, ChatLogExportOptions())
    export_chat_log("db", "exp-b", BOB, SURVEY, ChatLogExportOptions())

    alice_link, bob_link = _links(mock_status)
    assert alice_link != bob_link
    assert f"message-for-{ALICE}" in bucket.objects[alice_link]
    assert f"message-for-{BOB}" not in bucket.objects[alice_link]
    assert f"message-for-{ALICE}" not in bucket.objects[bob_link]


@patch("exporter.exporter.set_metadata")
@patch("exporter.exporter.set_export_status")
@patch("exporter.exporter.query", return_value=iter([]))
@patch("exporter.exporter.storage.get_storage_backend")
def test_full_messages_uses_owner_scoped_key(mock_factory, mock_query, _status, _meta):
    mock_query.side_effect = lambda *a, **k: iter([])
    mock_factory.return_value = MagicMock()

    export_full_messages("db", "exp-a", ALICE, SURVEY, FullMessagesExportOptions())
    export_full_messages("db", "exp-b", BOB, SURVEY, FullMessagesExportOptions())

    alice_path, bob_path = [c.kwargs["file_path"] for c in mock_factory.call_args_list]
    assert alice_path == full_messages_key(ALICE, SURVEY)
    assert bob_path == full_messages_key(BOB, SURVEY)
    assert alice_path != bob_path
