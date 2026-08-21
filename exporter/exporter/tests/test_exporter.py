from datetime import datetime, timezone

import pandas as pd
import pytest

from exporter.exporter import *


def ts(h, m, s):
    return datetime(2020, 1, 1, h, m, s).replace(tzinfo=timezone.utc).isoformat()


def dt(h, m, s):
    return pd.Timestamp(datetime(2020, 1, 1, h, m, s), tz="UTC")


def make_df(data):
    columns = [
        "surveyid",
        "userid",
        "flowid",
        "question_ref",
        "question_idx",
        "response",
        "timestamp",
        "metadata",
    ]

    return pd.DataFrame(data, columns=columns)


@pytest.fixture
def df():
    data = [
        ("a", "1", 1, "A", 1, "response", ts(12, 2, 0), '{"stratumid": "Z"}'),
        ("a", "1", 1, "B", 2, "response", ts(12, 2, 1), '{"stratumid": "Z"}'),
        ("a", "1", 1, "C", 3, "response", ts(12, 2, 5), '{"stratumid": "Z"}'),
        ("a", "1", 1, "D", 4, "response", ts(12, 2, 10), '{"stratumid": "Z"}'),
        ("b", "1", 1, "A", 1, "response", ts(12, 3, 0), '{"stratumid": "Z"}'),
        ("b", "1", 1, "B", 2, "response", ts(12, 4, 0), '{"stratumid": "Z"}'),
        ("a", "2", 1, "A", 1, "response", ts(12, 2, 0), '{"stratumid": "X"}'),
        ("a", "2", 1, "B", 2, "response", ts(12, 2, 5), '{"stratumid": "X"}'),
        ("c", "2", 2, "C", 2, "response", ts(12, 3, 5), "{}"),
        ("b", "3", 1, "A", 1, "response", ts(12, 2, 5), '{"stratumid": "Z"}'),
        ("b", "3", 1, "A", 1, "response2", ts(12, 2, 6), '{"stratumid": "Z"}'),
        ("c", "3", 1, "A", 1, "response", ts(12, 2, 5), '{"stratumid": "Z"}'),
    ]

    return make_df(data)


@pytest.fixture
def form_df():
    columns = ["surveyid", "shortcode", "version", "survey_created", "metadata"]

    data = [
        ("a", "foo", 1, ts(12, 1, 0), '{"wave": "0"}'),
        ("b", "bar", 1, ts(12, 1, 0), "{}"),
        ("c", "fooz", 1, ts(12, 1, 0), '{"wave": "0"}'),
    ]

    return pd.DataFrame(data, columns=columns)


# NOTE: the column counts in the shape assertions below each include the
# always-exported `ad_id` column (ALWAYS_EXPORTED_METADATA in exporter.py).
# It is added unconditionally, so every responses export is one column wider
# than it was before ad-id attribution landed.
def test_format_data_with_no_options_adds_form_data_with_prefix(df, form_df):
    dat = {}
    options = ExportOptions(**dat)
    res = format_data(df, form_df, options)
    assert res.shape == (12, 13)
    assert "form_wave" in res.columns


def test_format_data_with_just_duration(df, form_df):
    dat = {"add_duration": True}
    options = ExportOptions(**dat)
    res = format_data(df, form_df, options)
    assert res.shape == (12, 20)


def test_format_data_with_dropping_users(df, form_df):
    dat = {
        "pivot": False,
        "metadata": ["stratumid"],
        "drop_users_without": "stratumid",
    }
    options = ExportOptions(**dat)

    res = format_data(df, form_df, options)
    assert res.shape == (9, 14)


def test_format_data_with_only_final_answer(df, form_df):
    dat = {
        "pivot": False,
        "metadata": ["stratumid"],
        "drop_users_without": "stratumid",
        "keep_final_answer": True,
    }
    options = ExportOptions(**dat)

    res = format_data(df, form_df, options)
    assert res.shape == (8, 15)


def test_format_data_with_pivot(df, form_df):
    dat = {
        "pivot": False,
        "metadata": ["stratumid"],
        "drop_users_without": "stratumid",
        "keep_final_answer": True,
        "pivot": True,
        "response_value": "response",
    }
    options = ExportOptions(**dat)

    res = format_data(df, form_df, options)
    assert res.shape == (4, 12)


# --- ad_id always-exported metadata ---
#
# ad_id is the researcher's join key onto vlab's (network, ad_id) -> stratum
# mapping, so it must show up as a column on every export regardless of
# whether the researcher opted into the metadata box. These fixtures mirror
# the `df`/`form_df` fixtures above but give some rows an `ad_id` key in
# their metadata JSON and leave others without one, so we can check both
# population and the null case.


@pytest.fixture
def df_with_ad_id():
    data = [
        ("a", "1", 1, "A", 1, "response", ts(12, 2, 0), '{"stratumid": "Z", "ad_id": "ad-100"}'),
        ("a", "1", 1, "B", 2, "response", ts(12, 2, 1), '{"stratumid": "Z", "ad_id": "ad-100"}'),
        ("b", "2", 1, "A", 1, "response", ts(12, 3, 0), '{"stratumid": "X", "ad_id": "ad-200"}'),
        ("c", "3", 1, "A", 1, "response", ts(12, 2, 5), '{"stratumid": "Z"}'),
    ]

    return make_df(data)


def test_format_data_adds_ad_id_column_when_not_requested(df_with_ad_id, form_df):
    # Headline behaviour: researcher never touched options.metadata, ad_id
    # still shows up with the right value.
    options = ExportOptions()

    res = format_data(df_with_ad_id, form_df, options)
    assert "ad_id" in res.columns

    row_a1 = res[(res.surveyid == "a") & (res.userid == "1") & (res.question_ref == "A")].iloc[0]
    assert row_a1["ad_id"] == "ad-100"

    row_b2 = res[(res.surveyid == "b") & (res.userid == "2")].iloc[0]
    assert row_b2["ad_id"] == "ad-200"


def test_format_data_ad_id_alongside_requested_metadata(df_with_ad_id, form_df):
    # ad_id must coexist with a user-requested key -- both columns present,
    # both correct, in order (ad_id first, then requested).
    options = ExportOptions(metadata=["stratumid"])

    res = format_data(df_with_ad_id, form_df, options)
    assert "ad_id" in res.columns
    assert "stratumid" in res.columns

    row = res[(res.surveyid == "a") & (res.userid == "1") & (res.question_ref == "A")].iloc[0]
    assert row["ad_id"] == "ad-100"
    assert row["stratumid"] == "Z"


def test_format_data_explicit_ad_id_request_is_not_duplicated(df_with_ad_id, form_df):
    # Researcher explicitly asks for ad_id too -- must dedupe to exactly one
    # column, not mangle the name or produce a second copy.
    options = ExportOptions(metadata=["ad_id"])

    res = format_data(df_with_ad_id, form_df, options)
    assert list(res.columns).count("ad_id") == 1

    row = res[(res.surveyid == "b") & (res.userid == "2")].iloc[0]
    assert row["ad_id"] == "ad-200"


def test_format_data_row_without_ad_id_is_null_not_string_none(df_with_ad_id, form_df):
    options = ExportOptions()

    res = format_data(df_with_ad_id, form_df, options)

    row = res[(res.surveyid == "c") & (res.userid == "3")].iloc[0]
    assert pd.isna(row["ad_id"])
    assert row["ad_id"] != "None"


def test_format_data_ad_id_mixed_rows_line_up(df_with_ad_id, form_df):
    # Rows with and without ad_id in the same export -- values must line up
    # with the right rows, not bleed across or shift.
    options = ExportOptions()

    res = format_data(df_with_ad_id, form_df, options)

    expected = {
        ("a", "1"): "ad-100",
        ("b", "2"): "ad-200",
    }
    for (surveyid, userid), expected_ad_id in expected.items():
        rows = res[(res.surveyid == surveyid) & (res.userid == userid)]
        assert not rows.empty
        assert (rows["ad_id"] == expected_ad_id).all()

    missing_rows = res[(res.surveyid == "c") & (res.userid == "3")]
    assert not missing_rows.empty
    assert missing_rows["ad_id"].isna().all()


@pytest.mark.xfail(
    reason=(
        "PRE-EXISTING BUG, not caused by ad_id. A survey with zero responses "
        "yields pd.DataFrame([]) -- no columns at all -- and Preprocessor."
        "add_form_data merges on 'surveyid', raising KeyError long before the "
        "ad_id/add_metadata step is ever reached. Verified to fail identically "
        "without the ad_id change. A fix exists on the unmerged branch "
        "feature/exporter-integration-tests (commit 07ff6c4e, 'handle "
        "zero-response surveys with proper DataFrame columns'); this test is "
        "left here as an xfail so the gap stays visible, and it flips to XPASS "
        "the moment that fix lands."
    ),
    strict=True,
    raises=KeyError,
)
def test_format_data_empty_responses_does_not_crash(form_df):
    # A survey with zero responses yields pd.DataFrame([]) -- no columns at
    # all. format_data must not blow up on that input.
    responses = pd.DataFrame([])
    options = ExportOptions()

    res = format_data(responses, form_df, options)
    assert res.empty
