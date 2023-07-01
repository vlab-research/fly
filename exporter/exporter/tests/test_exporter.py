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


def test_format_data_with_no_options_adds_form_data_with_prefix(df, form_df):
    dat = {}
    options = ExportOptions(**dat)
    res = format_data(df, form_df, options)
    assert res.shape == (12, 12)
    assert "form_wave" in res.columns


def test_format_data_with_just_duration(df, form_df):
    dat = {"add_duration": True}
    options = ExportOptions(**dat)
    res = format_data(df, form_df, options)
    assert res.shape == (12, 19)


def test_format_data_with_dropping_users(df, form_df):
    dat = {
        "pivot": False,
        "metadata": ["stratumid"],
        "drop_users_without": "stratumid",
    }
    options = ExportOptions(**dat)

    res = format_data(df, form_df, options)
    assert res.shape == (9, 13)


def test_format_data_with_only_final_answer(df, form_df):
    dat = {
        "pivot": False,
        "metadata": ["stratumid"],
        "drop_users_without": "stratumid",
        "keep_final_answer": True,
    }
    options = ExportOptions(**dat)

    res = format_data(df, form_df, options)
    assert res.shape == (8, 14)


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
    assert res.shape == (4, 11)
