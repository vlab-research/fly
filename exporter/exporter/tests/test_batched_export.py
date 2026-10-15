"""
The batched responses export against the whole-survey export it replaces
(tests/reference_export.py), on the same data: the files must hold the same
rows, cell for cell, at any batch size.

Accepted differences: row order; pivot column order (fixed: key columns
sorted, then question columns sorted); and in a pivot, a column for each of the
survey's questions even if no exported user answered it, which is then empty.
"""
import csv
import io
import json
from collections import Counter
from unittest.mock import patch

import pandas as pd
import pytest
from vlab_prepro import PreprocessingError

from exporter.exporter import (
    ExportOptions,
    InvalidOptionsError,
    append_csv,
    batched,
    export_data,
    format_data,
    metadata_dtypes,
    metadata_keys,
)
from exporter.tests import reference_export, survey_fixture

BATCH_SIZES = [1, 2, 3, 100]

ALL_METADATA = ["startTime", "seed", "flag", "stratumid", "score"]

OPTIONS = {
    "none": {},
    "keep_final_answer": {"keep_final_answer": True},
    "drop_duplicated_users": {"drop_duplicated_users": True},
    "drop_users_without": {"metadata": ["stratumid"], "drop_users_without": "stratumid"},
    "drop_users_without_ad_id": {"drop_users_without": "ad_id_metadata"},
    "add_duration": {"add_duration": True},
    "metadata": {"metadata": ALL_METADATA},
    "metadata_ad_id_requested": {"metadata": ["ad_id", "seed"]},
    "final_answer_metadata": {"keep_final_answer": True, "metadata": ALL_METADATA},
    "everything_long": {
        "keep_final_answer": True,
        "drop_duplicated_users": True,
        "metadata": ALL_METADATA,
        "drop_users_without": "stratumid",
        "add_duration": True,
    },
    "pivot": {
        "pivot": True,
        "response_value": "response",
        "keep_final_answer": True,
        "drop_duplicated_users": True,
    },
    "pivot_translated": {
        "pivot": True,
        "response_value": "translated_response",
        "keep_final_answer": True,
        "drop_duplicated_users": True,
    },
    "pivot_metadata_duration": {
        "pivot": True,
        "response_value": "response",
        "keep_final_answer": True,
        "drop_duplicated_users": True,
        "metadata": ["stratumid", "seed", "flag"],
        "add_duration": True,
    },
    "pivot_drop_users_without": {
        "pivot": True,
        "response_value": "response",
        "keep_final_answer": True,
        "drop_duplicated_users": True,
        "metadata": ["stratumid"],
        "drop_users_without": "stratumid",
    },
}


def parse_csv(text):
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return [], []
    return rows[0], [dict(zip(rows[0], r)) for r in rows[1:]]


def assert_equivalent(old_text, new_text, pivot):
    old_header, old_rows = parse_csv(old_text)
    new_header, new_rows = parse_csv(new_text)

    if pivot:
        assert set(old_header) <= set(new_header)
        extra = set(new_header) - set(old_header)
        assert all(r[c] == "" for r in new_rows for c in extra)
    else:
        assert new_header == old_header

    def cells(rows):
        return Counter(tuple(r[c] for c in old_header) for r in rows)

    assert len(new_rows) == len(old_rows)
    assert cells(new_rows) == cells(old_rows)


def batched_csv(responses, form_data, options, batch_size):
    """What export_data writes, from frames instead of the database."""
    keys = metadata_keys(options)
    question_refs = set(responses.question_ref)
    dtypes = metadata_dtypes(
        reference_export.metadata_kinds(responses, keys, options.keep_final_answer)
    )

    out = io.StringIO()
    header = None
    userids = sorted(responses.userid.unique())
    for batch in batched(userids, batch_size):
        frame = responses[responses.userid.isin(batch)].reset_index(drop=True)
        dd = format_data(frame, form_data, options, question_refs, dtypes)
        header = append_csv(out, dd, header)
    return out.getvalue()


@pytest.fixture
def survey():
    return survey_fixture.frames()


@pytest.mark.parametrize("batch_size", BATCH_SIZES)
@pytest.mark.parametrize("name", OPTIONS)
def test_batched_export_matches_whole_survey_export(survey, name, batch_size):
    responses, form_data = survey
    options = ExportOptions(**OPTIONS[name])

    old = reference_export.export_responses_csv(responses.copy(), form_data, options)
    new = batched_csv(responses, form_data, options, batch_size)

    assert_equivalent(old, new, options.pivot)


@pytest.mark.parametrize("batch_size", BATCH_SIZES)
@pytest.mark.parametrize("opts", [
    # q2 answered twice by u03, so a user/question has two answers
    {"pivot": True, "response_value": "response"},
    # stratumid was never added as a column
    {"drop_users_without": "stratumid"},
])
def test_batched_export_fails_where_whole_survey_export_fails(survey, opts, batch_size):
    responses, form_data = survey
    options = ExportOptions(**opts)

    with pytest.raises(PreprocessingError):
        reference_export.export_responses_csv(responses.copy(), form_data, options)
    with pytest.raises(PreprocessingError):
        batched_csv(responses, form_data, options, batch_size)


def test_pivot_without_response_value_is_invalid(survey):
    responses, form_data = survey
    with pytest.raises(InvalidOptionsError):
        format_data(responses, form_data, ExportOptions(pivot=True))


# --- The cases above, spelled out ---


def column(text, name):
    _, rows = parse_csv(text)
    return [r[name] for r in rows]


def test_int_metadata_with_gaps_is_float_in_every_batch(survey):
    # u07 lacks startTime on some rows, so over the whole survey it is a float
    # column. A batch without u07 must not write its ints as ints.
    responses, form_data = survey
    text = batched_csv(responses, form_data, ExportOptions(metadata=["startTime"]), 1)
    values = [v for v in column(text, "startTime") if v]
    assert values and all(v.endswith(".0") for v in values)


def test_int_metadata_without_gaps_stays_int(survey):
    responses, form_data = survey
    text = batched_csv(responses, form_data, ExportOptions(metadata=["stratumid"]), 1)
    assert "s1" in column(text, "stratumid")
    # seed has a string on one row, so it is an object column: ints stay ints.
    text = batched_csv(responses, form_data, ExportOptions(metadata=["seed"]), 1)
    assert {"1", "x"} <= set(column(text, "seed"))


def test_form_metadata_missing_on_a_version_is_float_in_every_batch(survey):
    responses, form_data = survey
    text = batched_csv(responses, form_data, ExportOptions(), 1)
    assert set(column(text, "form_wave")) == {"1.0", "2.0", ""}
    assert set(column(text, "form_n")) == {"3", "4"}


def test_metadata_column_named_for_the_whole_survey(survey):
    # Only u06 answers a question called ad_id, so only u06's batch has it; every
    # batch must still call the metadata column ad_id_metadata.
    responses, form_data = survey
    text = batched_csv(responses, form_data, ExportOptions(), 1)
    header, _ = parse_csv(text)
    assert "ad_id_metadata" in header and "ad_id" not in header
    assert "ad-1" in column(text, "ad_id_metadata")


def test_pivot_columns_are_sorted_keys_then_sorted_questions(survey):
    responses, form_data = survey
    options = ExportOptions(**OPTIONS["pivot"])
    header, _ = parse_csv(batched_csv(responses, form_data, options, 2))
    questions = ["ad_id", "b1", "b2", "q1", "q2", "q3", "q4"]
    keys = header[: -len(questions)]
    assert header[-len(questions):] == questions
    assert keys == sorted(keys)
    assert "ad_id_metadata" in keys and "userid" in keys


def test_pivot_includes_questions_no_exported_user_answered(survey):
    responses, form_data = survey
    # u08 alone answered q4; dropping users without stratumid keeps u08, so
    # drop u08 by making it the only user without one.
    responses = responses.copy()
    responses.loc[responses.userid == "u08", "metadata"] = '{"ad_id": "ad-8"}'
    options = ExportOptions(**OPTIONS["pivot_drop_users_without"])

    old = reference_export.export_responses_csv(responses.copy(), form_data, options)
    new = batched_csv(responses, form_data, options, 2)

    assert "q4" not in parse_csv(old)[0]
    assert "q4" in parse_csv(new)[0]
    assert set(column(new, "q4")) == {""}
    assert_equivalent(old, new, pivot=True)


def test_batch_emptied_by_a_filter_is_skipped(survey):
    responses, form_data = survey
    options = ExportOptions(metadata=["stratumid"], drop_users_without="stratumid")
    only_u05 = responses[responses.userid == "u05"].reset_index(drop=True)
    assert len(format_data(only_u05, form_data, options)) == 0
    assert batched_csv(only_u05, form_data, options, 1) == ""


def test_append_csv_rejects_a_batch_with_other_columns():
    out = io.StringIO()
    header = append_csv(out, pd.DataFrame({"a": [1], "b": [2]}), None)
    header = append_csv(out, pd.DataFrame({"b": [4], "a": [3]}), header)
    assert out.getvalue() == "a,b\n1,2\n3,4\n"
    with pytest.raises(ValueError):
        append_csv(out, pd.DataFrame({"a": [5]}), header)


def test_metadata_dtypes_match_pandas_inference():
    examples = [
        [1, 2], [1, None], [1, 1.5], [None, 2.5], [True, False], [True, None],
        ["a", None], [None, None], [1, "a"], [True, 1], [{}, None], [[], 1],
        [2**63, 1], [2**64, 1], [-1, 2**63],
    ]
    for values in examples:
        expected = pd.Series(values, dtype=object).map(lambda v: v).dtype
        frame = pd.DataFrame({"metadata": [json.dumps({"k": v}) for v in values]})
        kinds = reference_export.metadata_kinds(frame, ["k"], False)
        assert metadata_dtypes(kinds)["k"] == expected, values


# --- export_data, with the database mocked out ---


class FakeBackend:
    def __init__(self):
        self.uploaded = None

    def save_file(self, path):
        with open(path, newline="") as f:
            self.uploaded = f.read()

    def generate_link(self):
        return "http://link"


def _run_export(responses, form_data, options, batch_size):
    """
    Runs export_data against frames instead of the database. Returns the
    backend and the set_export_status and set_metadata mocks, and the error
    export_data raised, if any.
    """
    backend = FakeBackend()
    db = {
        "get_survey_userids": lambda cnf, user, survey: sorted(responses.userid.unique()),
        "get_form_data": lambda cnf, user, survey: form_data,
        "get_question_refs": lambda cnf, user, survey: sorted(responses.question_ref.unique()),
        "get_metadata_kinds": lambda cnf, user, survey, keys, final:
            reference_export.metadata_kinds(responses, keys, final),
        "get_responses": lambda cnf, user, survey, userids:
            responses[responses.userid.isin(userids)].reset_index(drop=True),
    }
    error = None
    with patch.multiple("exporter.exporter", **db), \
            patch("exporter.exporter.storage.get_storage_backend", return_value=backend), \
            patch("exporter.exporter.set_export_status") as status, \
            patch("exporter.exporter.set_metadata") as metadata:
        try:
            export_data("db", "id", "owner", "survey", options, batch_size=batch_size)
        except BaseException as e:
            error = e
    return backend, status, metadata, error


@pytest.mark.parametrize("batch_size", [1, 4, 100])
def test_export_data_uploads_the_batched_csv(survey, batch_size):
    responses, form_data = survey
    options = ExportOptions(**OPTIONS["everything_long"])
    backend, status, metadata, error = _run_export(responses, form_data, options, batch_size)
    assert error is None

    old = reference_export.export_responses_csv(responses.copy(), form_data, options)
    assert_equivalent(old, backend.uploaded, pivot=False)

    statuses = [c.kwargs["status"] for c in status.call_args_list]
    assert statuses == ["Querying", "Writing", "Uploading", "Finished"]

    batches = -(-10 // batch_size)
    first = metadata.call_args_list[0].kwargs
    assert first == {
        "users": 10, "responses": 0, "rows": 0, "batches_done": 0, "batches": batches,
    }
    last = metadata.call_args_list[-1].kwargs
    assert last["batches_done"] == batches
    assert last["responses"] == len(responses)
    assert last["rows"] == len(parse_csv(old)[1])


@pytest.mark.parametrize("opts", [{}, {"pivot": True, "response_value": "response"}])
def test_export_data_of_empty_survey_finishes(survey, opts):
    responses, form_data = survey
    empty = responses.iloc[0:0]
    backend, status, metadata, error = _run_export(empty, form_data, ExportOptions(**opts), 10)
    assert error is None
    assert backend.uploaded == ""
    assert status.call_args_list[-1].kwargs["status"] == "Finished"
    assert metadata.call_args_list[0].kwargs["users"] == 0


@pytest.mark.parametrize("opts, error_type, message", [
    ({"pivot": True, "response_value": "response"}, PreprocessingError, "Could not pivot"),
    ({"pivot": True}, InvalidOptionsError, "response_value"),
])
def test_export_data_marks_option_errors_failed(survey, opts, error_type, message):
    responses, form_data = survey
    backend, status, metadata, error = _run_export(
        responses, form_data, ExportOptions(**opts), 3
    )
    assert isinstance(error, error_type)
    assert status.call_args_list[-1].kwargs["status"] == "Failed"
    assert message in metadata.call_args_list[-1].kwargs["error"]
    assert backend.uploaded is None
