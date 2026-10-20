"""
Responses and chat_log exports end to end against a live CockroachDB, compared
with the whole-survey exports they replace (tests/reference_export.py).

Run `make test-db` in devops/ first, then:
    DATABASE_URL=postgresql://root@localhost:5433/chatroach python -m pytest -m integration
"""
import json
import uuid
from unittest.mock import patch

import pytest

from exporter.db import execute, query, snapshot_timestamp
from exporter.exporter import (
    FORM_SCHEMA,
    RESPONSE_SCHEMA,
    ExportOptions,
    export_chat_log,
    export_data,
    get_form_data,
    get_responses,
    metadata_keys,
)
from exporter.main import ChatLogExportOptions, claim_job, run_job
from exporter.tests import reference_export, survey_fixture
from exporter.tests.conftest import DB_URL, wait_for_follower_reads
from exporter.tests.test_batched_export import (
    EDGE_OPTIONS,
    OPTIONS,
    FakeBackend,
    assert_equivalent,
    parse_csv,
)

pytestmark = pytest.mark.integration

FIXTURE_USERIDS = [f"u{n:02d}" for n in range(1, 11)]
EDGE_USERIDS = list(survey_fixture.EDGE_METADATA)
OTHER_USERIDS = ["x01"]
CHAT_USERIDS = ["c01", "c02", "c03", "u01"]


def _insert_user(cnf, email):
    # list(), not next(): the insert commits when the query generator finishes.
    return list(query(cnf, "INSERT INTO users (email) VALUES (%s) RETURNING id", vals=(email,)))[0][0]


def _insert_form(cnf, owner_id, survey_name, shortcode, created, metadata):
    return str(list(query(cnf, """
        INSERT INTO surveys
            (created, formid, form, shortcode, title, userid, metadata, survey_name)
        VALUES (%s, 'formid', '{}', %s, 'title', %s, %s::jsonb, %s)
        RETURNING id
    """, vals=(created, shortcode, owner_id, metadata, survey_name)))[0][0])


def _insert_responses(cnf, rows):
    for r in rows:
        execute(cnf, """
            INSERT INTO responses
                (parent_surveyid, parent_shortcode, surveyid, shortcode, flowid,
                 userid, question_ref, question_idx, question_text, response,
                 seed, pageid, timestamp, metadata, translated_response)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s::jsonb, %s)
        """, vals=(
            r["parent_surveyid"], r["parent_shortcode"], r["surveyid"], r["shortcode"],
            r["flowid"], r["userid"], r["question_ref"], r["question_idx"],
            r["question_text"], r["response"], r["pageid"], r["timestamp"],
            r["metadata"], r["translated_response"],
        ))


def _insert_chat_log(cnf, rows):
    for r in rows:
        execute(cnf, """
            INSERT INTO chat_log
                (userid, pageid, timestamp, direction, content, question_ref,
                 shortcode, surveyid, message_type, raw_payload, metadata)
            VALUES (%s, 'page-1', %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
        """, vals=r)


def _delete_rows(cnf, userids):
    placeholders = ",".join(["%s"] * len(userids))
    execute(cnf, f"DELETE FROM responses WHERE userid IN ({placeholders})", vals=tuple(userids))
    execute(cnf, f"DELETE FROM chat_log WHERE userid IN ({placeholders})", vals=tuple(userids))


@pytest.fixture(scope="module")
def seeded():
    """
    The survey_fixture survey, owned by a fresh researcher, plus another
    researcher's survey of the same name and shortcode answered by one of the
    same users, an empty survey, the survey_fixture edge survey, and chat log
    rows.
    """
    if not DB_URL:
        pytest.skip("DATABASE_URL not set — run 'make test-db' in devops/ first")
    cnf = DB_URL
    all_userids = FIXTURE_USERIDS + OTHER_USERIDS + CHAT_USERIDS + EDGE_USERIDS
    _delete_rows(cnf, all_userids)

    tag = uuid.uuid4().hex[:8]
    owner = f"owner-{tag}@test.example"
    other = f"other-{tag}@test.example"
    survey = f"survey-{tag}"
    empty_survey = f"empty-{tag}"
    edge_survey = f"edge-{tag}"

    owner_id = _insert_user(cnf, owner)
    other_id = _insert_user(cnf, other)

    surveyids = {
        key: _insert_form(cnf, owner_id, survey, shortcode, created, metadata)
        for key, shortcode, created, metadata in survey_fixture.FORMS
    }
    _, responses = survey_fixture.build(survey, surveyids)
    _insert_responses(cnf, responses)

    other_sid = _insert_form(cnf, other_id, survey, "foo", "2020-01-01 00:00:00+00", "{}")
    foreign = [dict(r, surveyid=other_sid, parent_surveyid=other_sid, userid=u,
                    timestamp="2021-06-01 00:00:00+00")
               for r, u in [(responses[0], "u01"), (responses[0], "x01")]]
    _insert_responses(cnf, foreign)

    _insert_form(cnf, owner_id, empty_survey, "empty", "2020-01-01 00:00:00+00", '{"wave": 1}')

    edge_ids = {
        key: _insert_form(cnf, owner_id, edge_survey, shortcode, created, metadata)
        for key, shortcode, created, metadata in survey_fixture.EDGE_FORMS
    }
    _, edge_responses = survey_fixture.build(
        edge_survey, edge_ids, forms=survey_fixture.EDGE_FORMS, rows=survey_fixture.edge_rows
    )
    _insert_responses(cnf, edge_responses)

    chat = []
    for i, userid in enumerate(CHAT_USERIDS):
        for j, (direction, shortcode) in enumerate(
            [("bot", "foo"), ("user", "foo"), ("user", "bar"), ("user", "zzz")]
        ):
            chat.append((
                userid, f"2020-01-01 12:{i:02d}:{j:02d}.25+00", direction,
                f'says "hi", {userid}\nnext line' if j == 1 else f"msg {j}",
                None if j == 0 else f"q{j}", shortcode, surveyids["foo_v1"], "text",
                json.dumps({"raw": j}), json.dumps({"seq": j}),
            ))
    _insert_chat_log(cnf, chat)
    wait_for_follower_reads(cnf)

    yield {
        "cnf": cnf, "owner": owner, "survey": survey, "empty_survey": empty_survey,
        "edge_survey": edge_survey,
        "surveyids": set(surveyids.values()), "responses": responses,
    }

    _delete_rows(cnf, all_userids)
    execute(cnf, "DELETE FROM surveys WHERE userid IN (%s, %s)", vals=(owner_id, other_id))
    execute(cnf, "DELETE FROM users WHERE id IN (%s, %s)", vals=(owner_id, other_id))


def _export(s, export_fn, *args, **kwargs):
    backend = FakeBackend()
    with patch("exporter.exporter.storage.get_storage_backend", return_value=backend):
        export_fn(s["cnf"], *args, **kwargs)
    return backend.uploaded


def _export_row(cnf, export_id):
    return list(query(cnf, """
        SELECT status, metadata, retry_count FROM export_status WHERE id = %s
    """, vals=(export_id,), as_dict=True))[0]


def _reference_responses(s, survey, options):
    responses = reference_export.get_responses(s["cnf"], s["owner"], survey)
    form_data = reference_export.get_form_data(s["cnf"], s["owner"], survey)
    return reference_export.export_responses_csv(responses, form_data, options)


@pytest.mark.parametrize("batch_size", [1, 2, 100])
@pytest.mark.parametrize("name", OPTIONS)
def test_export_matches_whole_survey_export(seeded, insert_export, export_id, name, batch_size):
    s = seeded
    options = ExportOptions(**OPTIONS[name])
    insert_export(export_id, status="Processing")

    new = _export(s, export_data, export_id, s["owner"], s["survey"], options, batch_size=batch_size)
    old = _reference_responses(s, s["survey"], options)

    assert_equivalent(old, new, options.pivot, metadata_keys(options))

    row = _export_row(s["cnf"], export_id)
    batches = -(-10 // batch_size)
    assert row["status"] == "Finished"
    assert row["metadata"]["users"] == 10
    assert row["metadata"]["responses"] == len(s["responses"])
    assert row["metadata"]["rows"] == len(parse_csv(old)[1])
    assert row["metadata"]["batches"] == batches
    assert row["metadata"]["batches_done"] == batches


def test_export_excludes_other_researchers_survey_of_same_name(seeded, export_id):
    s = seeded
    new = _export(s, export_data, export_id, s["owner"], s["survey"], ExportOptions(), batch_size=2)
    _, rows = parse_csv(new)
    assert {r["userid"] for r in rows} == set(FIXTURE_USERIDS)
    assert {r["surveyid"] for r in rows} <= s["surveyids"]
    assert len(rows) == len(s["responses"])


@pytest.mark.parametrize("batch_size", [1, 2, 100])
@pytest.mark.parametrize("name", EDGE_OPTIONS)
def test_edge_values_match_whole_survey_export(seeded, export_id, name, batch_size):
    # The metadata is what CockroachDB's jsonb::string makes of the fixture's
    # JSON, so the pivot's user metadata is read back from the database.
    s = seeded
    options = ExportOptions(**EDGE_OPTIONS[name])
    new = _export(s, export_data, export_id, s["owner"], s["edge_survey"], options, batch_size=batch_size)
    old = _reference_responses(s, s["edge_survey"], options)
    responses = reference_export.get_responses(s["cnf"], s["owner"], s["edge_survey"])
    user_metadata = {r.userid: json.loads(r.metadata) for r in responses.itertuples()}
    assert_equivalent(old, new, options.pivot, metadata_keys(options), user_metadata)


def test_queries_return_their_schemas(seeded):
    s = seeded
    as_of = snapshot_timestamp(s["cnf"])
    form_data = get_form_data(s["cnf"], s["owner"], s["survey"], as_of=as_of)
    responses = get_responses(s["cnf"], s["owner"], s["survey"], ["u01", "u02"], as_of=as_of)
    assert form_data.schema == FORM_SCHEMA and form_data.height == 3
    assert responses.schema == RESPONSE_SCHEMA
    assert set(responses["userid"]) == {"u01", "u02"}
    assert responses["surveyid"].is_in(s["surveyids"]).all()


@pytest.mark.parametrize("opts", [{}, {"pivot": True, "response_value": "response"}])
def test_empty_survey_finishes(seeded, insert_export, export_id, opts):
    s = seeded
    insert_export(export_id, status="Processing")
    new = _export(s, export_data, export_id, s["owner"], s["empty_survey"], ExportOptions(**opts))
    assert new == ""
    row = _export_row(s["cnf"], export_id)
    assert row["status"] == "Finished"
    assert row["metadata"]["users"] == 0


@pytest.mark.parametrize("batch_size", [1, 2, 100])
@pytest.mark.parametrize("opts", [
    {},
    {"include_metadata": True, "include_raw_payload": True},
])
def test_chat_log_matches_whole_survey_export(seeded, insert_export, export_id, opts, batch_size):
    s = seeded
    options = ChatLogExportOptions(**opts)
    insert_export(export_id, status="Processing", source="chat_log")

    new = _export(s, export_chat_log, export_id, s["owner"], s["survey"], options, batch_size=batch_size)
    old = reference_export.get_chat_log(s["cnf"], s["owner"], s["survey"], options).to_csv(index=False)

    assert new == old
    _, rows = parse_csv(new)
    assert {r["userid"] for r in rows} == set(CHAT_USERIDS)
    row = _export_row(s["cnf"], export_id)
    assert row["status"] == "Finished"
    assert row["metadata"]["rows"] == len(rows)
    assert row["metadata"]["users"] == len(CHAT_USERIDS)


def test_chat_log_of_empty_survey_is_header_only(seeded, export_id):
    s = seeded
    new = _export(s, export_chat_log, export_id, s["owner"], s["empty_survey"], ChatLogExportOptions())
    assert new == "userid,pageid,timestamp,direction,content,question_ref,shortcode,surveyid,message_type\n"


def test_pivot_failure_is_failed_without_retry(seeded, insert_export, export_id):
    s = seeded
    # u03 answered q2 twice, so pivoting without keep_final_answer fails.
    insert_export(
        export_id, options={"pivot": True, "response_value": "response"},
        user_id=s["owner"], survey_id=s["survey"],
    )

    job = claim_job(s["cnf"], max_retries=3, stuck_timeout_minutes=120)
    assert str(job["id"]) == export_id
    with patch("exporter.exporter.storage.get_storage_backend", return_value=FakeBackend()):
        run_job(s["cnf"], job, max_retries=3)

    row = _export_row(s["cnf"], export_id)
    assert row["status"] == "Failed"
    assert row["retry_count"] == 1
    assert "Could not pivot" in row["metadata"]["error"]
    assert claim_job(s["cnf"], max_retries=3, stuck_timeout_minutes=120) is None
