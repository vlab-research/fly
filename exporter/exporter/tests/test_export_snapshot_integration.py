"""
Exports of a survey that is being written to while it is exported, against a
live CockroachDB.

Run `make test-db` in devops/ first, then:
    DATABASE_URL=postgresql://root@localhost:5433/chatroach python -m pytest -m integration
"""
import json
import uuid
from itertools import count
from unittest.mock import patch

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from exporter.db import execute, query
from exporter.exporter import (
    ExportOptions,
    export_chat_log,
    export_data,
    export_full_messages,
    set_metadata,
)
from exporter.main import (
    ChatLogExportOptions,
    FullMessagesExportOptions,
    claim_job,
    run_job,
)
from exporter.tests.conftest import DB_URL, wait_for_follower_reads
from exporter.tests.test_batched_export import FakeBackend, parse_csv

pytestmark = pytest.mark.integration

USERS = [f"s{n:03d}" for n in range(40)]
QUESTIONS = 5
ROWS = len(USERS) * QUESTIONS


def _insert_many(cnf, q, rows):
    with psycopg.connect(cnf) as conn, conn.cursor() as cur:
        cur.executemany(q, rows)


def _insert_responses(cnf, sid, shortcode, rows):
    _insert_many(cnf, """
        INSERT INTO responses
            (parent_surveyid, parent_shortcode, surveyid, shortcode, flowid,
             userid, question_ref, question_idx, question_text, response,
             seed, pageid, timestamp, metadata)
        VALUES (%s, %s, %s, %s, 1, %s, %s, %s, 'question', %s, 0, 'page-1', %s, '{}')
    """, [(sid, shortcode, sid, shortcode, *r) for r in rows])


def _insert_chat_log(cnf, sid, shortcode, rows):
    _insert_many(cnf, """
        INSERT INTO chat_log
            (userid, pageid, timestamp, direction, content, question_ref,
             shortcode, surveyid, message_type)
        VALUES (%s, 'page-1', %s, 'user', %s, %s, %s, %s, 'text')
    """, [(u, ts, text, ref, shortcode, sid) for u, ref, _, text, ts in rows])


def _insert_messages(cnf, rows):
    _insert_many(cnf, """
        INSERT INTO messages (userid, timestamp, content) VALUES (%s, %s, %s)
    """, [
        (u, ts, json.dumps({"source": "messenger", "message": {"text": text}}))
        for u, _, _, text, ts in rows
    ])


def _rows(userids, questions, text, minute):
    return [
        (u, f"q{j}", j, f"{text} {minute} {u} {j} " + "x" * 100, f"2021-01-01 00:{minute:02d}:{j:02d}+00")
        for u in userids for j in range(questions)
    ]


@pytest.fixture(scope="module")
def live_survey():
    """
    A survey of USERS, each with QUESTIONS responses, chat_log rows and
    messages, all readable at follower_read_timestamp(). `fault_cnf` connects
    with a results buffer of 1 KiB and `responses` replaced by a view that
    raises a retry error (40001) on the rows of every user from s010 on,
    when read at a timestamp less than a second old: a stand-in for the
    uncertainty restarts a read at the present gets from concurrent writes,
    which a single node can't produce.
    """
    if not DB_URL:
        pytest.skip("DATABASE_URL not set — run 'make test-db' in devops/ first")
    cnf = DB_URL
    tag = uuid.uuid4().hex[:8]
    owner = f"live-{tag}@test.example"
    survey = f"live-{tag}"
    shortcode = f"live{tag}"
    fault_schema = f"fault_{tag}"

    owner_id = list(query(cnf, "INSERT INTO users (email) VALUES (%s) RETURNING id", vals=(owner,)))[0][0]
    sid = str(list(query(cnf, """
        INSERT INTO surveys (created, formid, form, shortcode, title, userid, metadata, survey_name)
        VALUES ('2021-01-01', 'formid', '{}', %s, 'title', %s, '{}', %s)
        RETURNING id
    """, vals=(shortcode, owner_id, survey)))[0][0])

    rows = _rows(USERS, QUESTIONS, "seeded", 0)
    _insert_responses(cnf, sid, shortcode, rows)
    _insert_chat_log(cnf, sid, shortcode, rows)
    _insert_messages(cnf, rows)

    # force_retry() raises while the transaction is younger than its argument.
    # The first users' rows pass and overflow the 1 KiB buffer, so the error
    # comes after rows have reached the client, where CockroachDB can't retry
    # it even for an autocommit read.
    execute(cnf, f"CREATE SCHEMA {fault_schema}")
    execute(cnf, f"""
        CREATE VIEW {fault_schema}.responses AS
        SELECT * FROM public.responses
        WHERE crdb_internal.force_retry(IF(userid >= 's010', '1s', '0s')::INTERVAL) = 0
    """)
    fault_cnf = make_conninfo(
        cnf, options=f"-c results_buffer_size=1024 -c search_path={fault_schema},public"
    )
    wait_for_follower_reads(cnf)

    yield {
        "cnf": cnf, "fault_cnf": fault_cnf, "owner": owner, "survey": survey,
        "sid": sid, "shortcode": shortcode,
    }

    execute(cnf, f"DROP SCHEMA {fault_schema} CASCADE")
    placeholders = ",".join(["%s"] * len(USERS))
    execute(cnf, "DELETE FROM responses WHERE surveyid = %s", vals=(sid,))
    execute(cnf, f"DELETE FROM chat_log WHERE userid IN ({placeholders})", vals=tuple(USERS))
    execute(cnf, f"DELETE FROM messages WHERE userid IN ({placeholders})", vals=tuple(USERS))
    execute(cnf, "DELETE FROM surveys WHERE id = %s", vals=(sid,))
    execute(cnf, "DELETE FROM users WHERE id = %s", vals=(owner_id,))


def _export_row(cnf, export_id):
    return list(query(cnf, """
        SELECT status, metadata, retry_count FROM export_status WHERE id = %s
    """, vals=(export_id,), as_dict=True))[0]


def test_streamed_export_survives_retry_errors_after_rows_are_sent(
    live_survey, insert_export, export_id
):
    s = live_survey
    insert_export(export_id, user_id=s["owner"], survey_id=s["survey"])
    job = claim_job(s["cnf"], max_retries=3, stuck_timeout_minutes=120)
    assert str(job["id"]) == export_id

    backend = FakeBackend()
    with patch("exporter.exporter.storage.get_storage_backend", return_value=backend):
        run_job(s["fault_cnf"], job, max_retries=3)

    row = _export_row(s["cnf"], export_id)
    assert (row["status"], row["metadata"].get("error")) == ("Finished", None)
    assert row["retry_count"] == 1
    assert len(parse_csv(backend.uploaded)[1]) == ROWS


LATE_WRITERS = {
    "responses": lambda s, rows: _insert_responses(s["cnf"], s["sid"], s["shortcode"], rows),
    "chat_log": lambda s, rows: _insert_chat_log(s["cnf"], s["sid"], s["shortcode"], rows),
    "full_messages": lambda s, rows: _insert_messages(s["cnf"], rows),
}

EXPORTS = {
    "responses": (export_data, ExportOptions(), "response"),
    "chat_log": (export_chat_log, ChatLogExportOptions(), "content"),
    "full_messages": (export_full_messages, FullMessagesExportOptions(), "content"),
}


@pytest.mark.parametrize("source", EXPORTS)
def test_export_is_one_snapshot_while_the_survey_is_written(
    live_survey, insert_export, export_id, source
):
    """
    Each time the export reports progress, a new answer by the last user lands.
    None of them is in the file: every read is of the survey as it was when the
    export started.
    """
    s = live_survey
    export_fn, options, text_column = EXPORTS[source]
    insert_export(export_id, status="Processing", source=source)
    minutes = count(10)

    def report_then_write(*args, **kwargs):
        set_metadata(*args, **kwargs)
        LATE_WRITERS[source](s, _rows(USERS[-1:], 1, "late", next(minutes)))

    backend = FakeBackend()
    with patch("exporter.exporter.storage.get_storage_backend", return_value=backend), \
            patch("exporter.exporter.set_metadata", side_effect=report_then_write):
        kwargs = {} if source == "full_messages" else {"batch_size": 10}
        export_fn(s["cnf"], export_id, s["owner"], s["survey"], options, **kwargs)

    _, rows = parse_csv(backend.uploaded)
    late = [r[text_column] for r in rows if r[text_column].startswith("late")]
    assert late == []
    assert len(rows) == ROWS
    assert _export_row(s["cnf"], export_id)["status"] == "Finished"
