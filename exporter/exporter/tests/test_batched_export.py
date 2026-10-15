"""
The batched Polars responses export against the whole-survey pandas export it
replaces (tests/reference_export.py), on the same data: the files must hold
the same rows, cell for cell, at any batch size.

Accepted differences, each normalised explicitly in assert_equivalent:

- Row order.
- Pivot column order (fixed: key columns sorted, then question columns
  sorted), and in a pivot a column for each of the survey's questions even if
  no exported user answered it, which is then empty.
- A metadata value is written as the JSON value's own text, the same in every
  batch, where pandas inferred one type for the whole column:
  - an int in a column pandas made float (an int key missing on some rows, or
    mixed with floats) is written `1`, not `1.0`;
  - an object or array is JSON (`{"a":1}`), not a Python repr (`{'a': 1}`);
  - a float below 1e-4 is in Polars' notation (`0.000025`), not repr's
    (`2.5e-05`).
"""
import csv
import io
import json
from collections import Counter
from datetime import datetime, timezone
from unittest.mock import patch

import pandas as pd
import polars as pl
import pytest
from vlab_prepro import PreprocessingError

from exporter.exporter import (
    RESPONSE_SCHEMA,
    FORM_SCHEMA,
    ExportOptions,
    InvalidOptionsError,
    append_csv,
    batched,
    csv_frame,
    export_data,
    format_data,
    metadata_keys,
    metadata_value,
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

EDGE_KEYS = ["b", "obj", "f", "gi", "s", "u", "c", "e"]

# add_duration and pivot group by the metadata columns, which the old export
# could not do for a column holding objects (they are unhashable).
EDGE_SCALAR_KEYS = [k for k in EDGE_KEYS if k != "obj"]

EDGE_OPTIONS = {
    "metadata": {"metadata": EDGE_KEYS},
    "metadata_duration": {
        "metadata": EDGE_SCALAR_KEYS, "add_duration": True, "keep_final_answer": True,
    },
    "drop_users_without_gi": {"metadata": EDGE_KEYS, "drop_users_without": "gi"},
    "pivot": {
        "pivot": True,
        "response_value": "response",
        "metadata": EDGE_SCALAR_KEYS,
        "add_duration": True,
    },
    "pivot_translated": {
        "pivot": True,
        "response_value": "translated_response",
        "metadata": ["b", "s", "u", "c", "e"],
    },
}


def parse_csv(text):
    rows = list(csv.reader(io.StringIO(text, newline="")))
    if not rows:
        return [], []
    return rows[0], [dict(zip(rows[0], r)) for r in rows[1:]]


def _accepted(old, value):
    """
    What the new export writes for a metadata cell that the old export wrote
    as `old`, where the JSON value was `value`: `old` itself except in the
    accepted differences listed at the top of this module.
    """
    if type(value) is int and old == repr(float(value)):
        return str(value)
    if isinstance(value, (dict, list)) and old == str(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if type(value) is float and 0 < abs(value) < 1e-4 and old == repr(value):
        return pl.Series([value]).cast(pl.String)[0]
    return old


def assert_quoted_as_pandas_quotes(text):
    """
    Each record is written byte for byte as pandas' to_csv writes its cells
    (csv.writer, minimal quoting, "\n" line ends). Comparing parsed cells
    alone would not see an empty field written as "".
    """
    out = io.StringIO(newline="")
    csv.writer(out, lineterminator="\n").writerows(csv.reader(io.StringIO(text, newline="")))
    assert out.getvalue() == text


def assert_equivalent(old_text, new_text, pivot, keys=(), user_metadata=None):
    """
    The old and new export files hold the same rows, apart from the accepted
    differences. `keys` are the export's metadata keys; their cells are read
    against each row's metadata JSON, or for a pivot (which has no metadata
    column) against `user_metadata`, a userid -> metadata dict; a pivot
    without it is compared strictly.
    """
    assert_quoted_as_pandas_quotes(old_text)
    assert_quoted_as_pandas_quotes(new_text)
    old_header, old_rows = parse_csv(old_text)
    new_header, new_rows = parse_csv(new_text)

    if pivot:
        assert set(old_header) <= set(new_header)
        extra = set(new_header) - set(old_header)
        assert all(r[c] == "" for r in new_rows for c in extra)
    else:
        assert new_header == old_header

    columns = {}
    for key in keys:
        for name in (f"{key}_metadata", key):
            if name in old_header:
                columns[name] = key
                break

    def normalised(row):
        if not columns or ("metadata" not in row and user_metadata is None):
            return row
        md = json.loads(row["metadata"]) if "metadata" in row else user_metadata[row["userid"]]
        return {c: _accepted(v, md.get(columns[c])) if c in columns else v for c, v in row.items()}

    def cells(rows):
        return Counter(tuple(r[c] for c in old_header) for r in rows)

    assert len(new_rows) == len(old_rows)
    assert cells(new_rows) == cells([normalised(r) for r in old_rows])


def to_polars(responses, form_data):
    """The pandas fixture frames as get_responses and get_form_data return them."""
    return (
        pl.DataFrame(responses.to_dict("records"), schema=RESPONSE_SCHEMA),
        pl.DataFrame(form_data.to_dict("records"), schema=FORM_SCHEMA),
    )


def batched_csv(responses, form_data, options, batch_size):
    """What export_data writes, from frames instead of the database."""
    question_refs = set(responses["question_ref"])
    out = io.BytesIO()
    header = None
    for batch in batched(sorted(responses["userid"].unique()), batch_size):
        frame = responses.filter(pl.col("userid").is_in(batch))
        dd = format_data(frame, form_data, options, question_refs)
        header = append_csv(out, dd, header)
    return out.getvalue().decode()


def compare(responses, form_data, options, batch_size, user_metadata=None):
    """Runs both exports on the pandas fixture frames and compares them."""
    old = reference_export.export_responses_csv(responses.copy(), form_data, options)
    new = batched_csv(*to_polars(responses, form_data), options, batch_size)
    assert_equivalent(old, new, options.pivot, metadata_keys(options), user_metadata)
    return old, new


@pytest.fixture
def survey():
    return survey_fixture.frames()


@pytest.fixture
def edge_survey():
    return survey_fixture.frames(
        "edge-survey", forms=survey_fixture.EDGE_FORMS, rows=survey_fixture.edge_rows
    )


@pytest.mark.parametrize("batch_size", BATCH_SIZES)
@pytest.mark.parametrize("name", OPTIONS)
def test_batched_export_matches_whole_survey_export(survey, name, batch_size):
    compare(*survey, ExportOptions(**OPTIONS[name]), batch_size)


@pytest.mark.parametrize("batch_size", BATCH_SIZES)
@pytest.mark.parametrize("name", EDGE_OPTIONS)
def test_edge_values_match_whole_survey_export(edge_survey, name, batch_size):
    edge_metadata = {
        u: {"ad_id": f"ad-{u}", **md} for u, md in survey_fixture.EDGE_METADATA.items()
    }
    compare(*edge_survey, ExportOptions(**EDGE_OPTIONS[name]), batch_size, edge_metadata)


def test_edge_survey_hits_every_accepted_difference(edge_survey):
    responses, form_data = edge_survey
    options = ExportOptions(metadata=EDGE_KEYS)
    old = reference_export.export_responses_csv(responses.copy(), form_data, options)
    new = batched_csv(*to_polars(responses, form_data), options, 100)
    assert "1.0" in column(old, "gi") and "1" in column(new, "gi")
    assert "{'z': 1, 'a': [1, 2.5, 'x']}" in column(old, "obj")
    assert '{"z":1,"a":[1,2.5,"x"]}' in column(new, "obj")
    assert "2.5e-05" in column(old, "f") and "0.000025" in column(new, "f")


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

    with pytest.raises(reference_export.PreprocessingError):
        reference_export.export_responses_csv(responses.copy(), form_data, options)
    with pytest.raises(PreprocessingError):
        batched_csv(*to_polars(responses, form_data), options, batch_size)


def test_pivot_without_response_value_is_invalid(survey):
    with pytest.raises(InvalidOptionsError):
        format_data(*to_polars(*survey), ExportOptions(pivot=True))


def test_metadata_key_with_backslash_is_invalid(survey):
    with pytest.raises(InvalidOptionsError):
        format_data(*to_polars(*survey), ExportOptions(metadata=["a\\b"]))


# --- The cases above, spelled out ---


def column(text, name):
    _, rows = parse_csv(text)
    return [r[name] for r in rows]


def test_int_metadata_is_written_as_an_int_in_every_batch(survey):
    # u07 lacks startTime on some rows, which made it a float column in the
    # whole-survey export; each value is now written as the JSON has it.
    responses, form_data = to_polars(*survey)
    text = batched_csv(responses, form_data, ExportOptions(metadata=["startTime"]), 1)
    values = [v for v in column(text, "startTime") if v]
    assert values and all(v.isdigit() for v in values)
    assert "" in column(text, "startTime")


def test_metadata_strings_and_mixed_keys(survey):
    responses, form_data = to_polars(*survey)
    text = batched_csv(responses, form_data, ExportOptions(metadata=["stratumid"]), 1)
    assert "s1" in column(text, "stratumid")
    text = batched_csv(responses, form_data, ExportOptions(metadata=["seed"]), 1)
    assert {"1", "x"} <= set(column(text, "seed"))


def test_form_metadata_missing_on_a_version_is_float_in_every_batch(survey):
    responses, form_data = to_polars(*survey)
    text = batched_csv(responses, form_data, ExportOptions(), 1)
    assert set(column(text, "form_wave")) == {"1.0", "2.0", ""}
    assert set(column(text, "form_n")) == {"3", "4"}


def test_metadata_column_named_for_the_whole_survey(survey):
    # Only u06 answers a question called ad_id, so only u06's batch has it; every
    # batch must still call the metadata column ad_id_metadata.
    responses, form_data = to_polars(*survey)
    text = batched_csv(responses, form_data, ExportOptions(), 1)
    header, _ = parse_csv(text)
    assert "ad_id_metadata" in header and "ad_id" not in header
    assert "ad-1" in column(text, "ad_id_metadata")


def test_pivot_columns_are_sorted_keys_then_sorted_questions(survey):
    responses, form_data = to_polars(*survey)
    options = ExportOptions(**OPTIONS["pivot"])
    header, _ = parse_csv(batched_csv(responses, form_data, options, 2))
    questions = ["ad_id", "b1", "b2", "q1", "q2", "q3", "q4"]
    keys = header[: -len(questions)]
    assert header[-len(questions):] == questions
    assert keys == sorted(keys)
    assert "ad_id_metadata" in keys and "userid" in keys


def test_pivot_includes_questions_no_exported_user_answered(survey):
    responses, form_data = survey
    # u08 alone answered q4; drop u08 by making it the only user without a
    # stratumid.
    responses = responses.copy()
    responses.loc[responses.userid == "u08", "metadata"] = '{"ad_id": "ad-8"}'
    options = ExportOptions(**OPTIONS["pivot_drop_users_without"])

    old, new = compare(responses, form_data, options, 2)

    assert "q4" not in parse_csv(old)[0]
    assert "q4" in parse_csv(new)[0]
    assert set(column(new, "q4")) == {""}


def test_batch_emptied_by_a_filter_is_skipped(survey):
    responses, form_data = to_polars(*survey)
    options = ExportOptions(metadata=["stratumid"], drop_users_without="stratumid")
    only_u05 = responses.filter(pl.col("userid") == "u05")
    assert len(format_data(only_u05, form_data, options)) == 0
    assert batched_csv(only_u05, form_data, options, 1) == ""


def test_append_csv_rejects_a_batch_with_other_columns():
    out = io.BytesIO()
    header = append_csv(out, pl.DataFrame({"a": [1], "b": [2]}), None)
    header = append_csv(out, pl.DataFrame({"b": [4], "a": [3]}), header)
    assert out.getvalue() == b"a,b\n1,2\n3,4\n"
    with pytest.raises(ValueError):
        append_csv(out, pl.DataFrame({"a": [5]}), header)


# --- Values written as pandas wrote them ---

JSON_VALUES = [
    # (JSON text of the value, the cell written)
    ('"abc"', "abc"),
    ('"007"', "007"),
    ('"true"', "true"),
    ('""', ""),
    ('"ünï \\"q\\", x\\ny"', 'ünï "q", x\ny'),
    ("true", "True"),
    ("false", "False"),
    ("null", ""),
    ("1", "1"),
    ("-2", "-2"),
    ("1690000000000", "1690000000000"),
    ("12345678901234567890", "12345678901234567890"),
    ("0.5", "0.5"),
    ("1.0", "1.0"),
    ("1E+3", "1000.0"),
    ("1e16", "1e+16"),
    ('{"z": 1, "a": [true, null]}', '{"z":1,"a":[true,null]}'),
    ("[]", "[]"),
    ("[true]", "[true]"),
]


def _metadata_cells(texts):
    frame = pl.DataFrame({"metadata": [f'{{"k": {t}, "o": 1}}' for t in texts] + ['{"o": 1}']})
    written = csv_frame(frame.select(metadata_value("k").alias("k"), pl.lit("x").alias("x")))
    return [r[0] for r in csv.reader(io.StringIO(written.write_csv(include_header=False)))]


def test_metadata_value_writes_each_json_kind():
    cells = _metadata_cells([t for t, _ in JSON_VALUES])
    assert cells == [w for _, w in JSON_VALUES] + [""]


@pytest.mark.parametrize("text, written", JSON_VALUES)
def test_metadata_value_is_the_same_alone_as_among_others(text, written):
    assert _metadata_cells([text]) == [written, ""]


def test_metadata_value_selects_keys_that_need_quoting():
    keys = ['a"b', "it's", "a.b", "a]b", "sp ace", "$x", "é"]
    frame = pl.DataFrame({"metadata": [json.dumps({k: i for i, k in enumerate(keys)})]})
    out = frame.select(metadata_value(k).alias(str(i)) for i, k in enumerate(keys))
    assert out.row(0) == tuple(str(i) for i in range(len(keys)))


FLOATS = [
    12.0, 0.5, -0.0, 47.5, 0.1 + 0.2, 1690000000000.0, 123456789012345.6,
    9999999999999998.0, 1e16, 1.5e16, 1e22, 0.0001, 1e-05, 2.5e-05, 1e-07,
    -3.2e-10, float("nan"), None,
]


def test_floats_are_written_as_pandas_writes_them():
    expected = pd.DataFrame({"f": FLOATS, "x": "x"}).to_csv(index=False)
    frame = pl.DataFrame({"f": FLOATS, "x": ["x"] * len(FLOATS)}, schema={"f": pl.Float64, "x": pl.String})
    assert csv_frame(frame).write_csv() == expected


def test_datetimes_are_written_as_pandas_writes_them():
    # pandas gives each timezone-aware value a fraction only if it has one.
    texts = [
        "2020-01-01 12:00:00+00", "2020-01-01 12:00:00.123456+00",
        "2020-01-01 12:00:00.001+00", "2020-01-01 12:00:00.000000001+00",
    ]
    expected = pd.DataFrame({"t": [pd.Timestamp(t) for t in texts] + [None], "x": "x"}).to_csv(index=False)
    times = pl.Series(texts + [None]).str.to_datetime(
        "%Y-%m-%d %H:%M:%S%.f%#z", time_unit="ns", time_zone="UTC"
    )
    frame = pl.DataFrame({"t": times, "x": ["x"] * len(times)})
    assert csv_frame(frame).write_csv() == expected


def test_strings_are_quoted_as_pandas_quotes_them():
    values = [
        "plain", "", None, "a,b", 'say "hi"', "line1\nline2", "cr\rx", "crlf\r\nx",
        " lead", "trail ", "ünïcødé 🎉", "tab\tx", '"', "'q'", "#", "\\", "null", "NA",
        " ", "a;b",
    ]
    frame = {"s": values, "n": list(range(len(values)))}
    expected = pd.DataFrame(frame).to_csv(index=False)
    assert csv_frame(pl.DataFrame(frame)).write_csv() == expected


def test_booleans_ints_and_nested_values():
    frame = pl.DataFrame({
        "b": [True, False, None],
        "i": [1, None, -3],
        "s": [{"a": 1, "b": "x"}, None, {"a": 2, "b": None}],
        "l": [[1, 2], [], None],
    })
    assert csv_frame(frame).write_csv() == (
        'b,i,s,l\nTrue,1,"{""a"":1,""b"":""x""}","[1,2]"\n'
        'False,,,[]\n,-3,"{""a"":2,""b"":null}",\n'
    )


# --- export_data, with the database mocked out ---


class FakeBackend:
    def __init__(self):
        self.uploaded = None

    def save_file(self, path):
        with open(path, newline="", encoding="utf-8") as f:
            self.uploaded = f.read()

    def generate_link(self):
        return "http://link"


def _run_export(responses, form_data, options, batch_size):
    """
    Runs export_data against Polars frames instead of the database. Returns
    the backend and the set_export_status and set_metadata mocks, and the
    error export_data raised, if any.
    """
    backend = FakeBackend()
    db = {
        "get_survey_userids": lambda cnf, user, survey: sorted(responses["userid"].unique()),
        "get_form_data": lambda cnf, user, survey: form_data,
        "get_question_refs": lambda cnf, user, survey: sorted(responses["question_ref"].unique()),
        "get_responses": lambda cnf, user, survey, userids:
            responses.filter(pl.col("userid").is_in(userids)),
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
    backend, status, metadata, error = _run_export(
        *to_polars(responses, form_data), options, batch_size
    )
    assert error is None

    old = reference_export.export_responses_csv(responses.copy(), form_data, options)
    assert_equivalent(old, backend.uploaded, False, metadata_keys(options))

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
    responses, form_data = to_polars(*survey)
    empty = responses.clear()
    backend, status, metadata, error = _run_export(empty, form_data, ExportOptions(**opts), 10)
    assert error is None
    assert backend.uploaded == ""
    assert status.call_args_list[-1].kwargs["status"] == "Finished"
    assert metadata.call_args_list[0].kwargs["users"] == 0


@pytest.mark.parametrize("opts, error_type, message", [
    ({"pivot": True, "response_value": "response"}, PreprocessingError, "Could not pivot"),
    ({"pivot": True}, InvalidOptionsError, "response_value"),
    ({"metadata": ["a\\b"]}, InvalidOptionsError, "backslash"),
])
def test_export_data_marks_option_errors_failed(survey, opts, error_type, message):
    backend, status, metadata, error = _run_export(
        *to_polars(*survey), ExportOptions(**opts), 3
    )
    assert isinstance(error, error_type)
    assert status.call_args_list[-1].kwargs["status"] == "Failed"
    assert message in metadata.call_args_list[-1].kwargs["error"]
    assert backend.uploaded is None
