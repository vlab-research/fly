"""
A small survey that exercises every responses-export option, shared by the
batched-vs-whole-survey equivalence tests (as DataFrames) and the database
integration tests (inserted into CockroachDB).

Two forms, `foo` in two versions and `bar` in one. Form metadata keys are
missing on some versions (`wave` is an int on foo v1 and bar but absent on foo
v2, so it is a float column). Users, each with something an option acts on:

  u01  odd users take foo v1, even users foo v2; u01 also has translations
  u02  no ad_id in metadata
  u03  answers q2 twice (keep_final_answer)
  u04  takes foo twice, in two flows (drop_duplicated_users)
  u05  no stratumid in metadata (drop_users_without)
  u06  answers a question whose ref is `ad_id` (metadata column renamed)
  u07  startTime missing on some rows: an int key with gaps is a float column
  u08  seed is a string on one row: a mixed column is object
  u09  no flag in metadata: a bool key with gaps is object
  u10  takes only bar

`score` is written as JSON number text: 1.0, 1E+3 and 7, read as float,
float and int.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

import pandas as pd

from exporter.exporter import RESPONSE_COLUMNS

FORMS = [
    # (key, shortcode, created, metadata)
    ("foo_v1", "foo", "2020-01-01 00:00:00+00", '{"wave": 1, "arm": "a", "n": 3}'),
    ("foo_v2", "foo", "2020-01-02 00:00:00+00", '{"arm": "b", "n": 3}'),
    ("bar_v1", "bar", "2020-01-01 00:00:00+00", '{"wave": 2, "n": 4, "ratio": 1.5}'),
]

SCORES = {1: "1.0", 2: "1E+3", 3: "7"}

T0 = datetime(2020, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def _ts(t):
    """A timestamp as CockroachDB's timestamptz::string writes it."""
    s = t.strftime("%Y-%m-%d %H:%M:%S")
    if t.microsecond:
        s += f".{t.microsecond:06d}".rstrip("0")
    return s + "+00"


def _metadata(n, drop=(), **overrides):
    md = {
        "ad_id": f"ad-{n}",
        "stratumid": "s1",
        "startTime": 1690000000000 + n,
        "seed": n,
        "flag": True,
    }
    md.update(overrides)
    for k in drop:
        md.pop(k, None)
    text = json.dumps(md)
    if n in SCORES:
        text = text[:-1] + f', "score": {SCORES[n]}}}'
    return text


def response_rows():
    """The survey's responses as dicts keyed by form key instead of surveyid."""
    rows = []
    for n in range(1, 11):
        userid = f"u{n:02d}"
        start = T0 + timedelta(minutes=n, microseconds=(123456 if n % 2 else 0))
        drop = []
        if n == 2:
            drop.append("ad_id")
        if n == 5:
            drop.append("stratumid")
        if n == 9:
            drop.append("flag")

        def add(form, ref, idx, response, seconds, flowid=1, md=None):
            rows.append({
                "form": form,
                "flowid": flowid,
                "userid": userid,
                "question_ref": ref,
                "question_idx": idx,
                "question_text": f'Question {ref}, "{form}"',
                "response": response,
                "timestamp": _ts(start + timedelta(seconds=seconds)),
                "metadata": md or _metadata(n, drop),
                "pageid": "page-1",
                "translated_response": f"t-{response}" if n == 1 else None,
            })

        if n != 10:
            foo = "foo_v1" if n % 2 else "foo_v2"
            no_start = _metadata(n, drop + ["startTime"]) if n == 7 else None
            add(foo, "q1", 1, f"yes {n}", 0)
            add(foo, "q2", 2, "a, b" if n == 3 else f"{n * 2}", 5, md=no_start)
            add(foo, "q3", 3, "line one\nline two" if n == 4 else "no", 9, md=no_start)
            if n == 3:
                add(foo, "q2", 2, "changed my mind", 12)
            if n == 4:
                add(foo, "q1", 1, "second flow", 30, flowid=2)
            if n == 8:
                add(foo, "q4", 4, "seed as text", 14, md=_metadata(n, drop, seed="x"))

        add("bar_v1", "b1", 1, f"{n}", 40)
        add("bar_v1", "b2", 2, "maybe", 47.5)
        if n == 6:
            add("bar_v1", "ad_id", 3, "an answer called ad_id", 50)
    return rows


def build(survey_name="fixture-survey", surveyids=None):
    """
    Returns (form_rows, response_rows): form rows as get_form_data returns them
    and response rows with RESPONSE_COLUMNS, sorted as get_responses sorts
    them. surveyids maps form key to id; fresh uuids if not given.
    """
    surveyids = surveyids or {key: str(uuid.uuid4()) for key, *_ in FORMS}

    forms = []
    versions = {}
    for key, shortcode, created, metadata in sorted(FORMS, key=lambda f: (f[1], f[2])):
        versions[shortcode] = versions.get(shortcode, 0) + 1
        forms.append({
            "surveyid": surveyids[key],
            "shortcode": shortcode,
            "survey_name": survey_name,
            "version": versions[shortcode],
            "survey_created": created,
            "metadata": metadata,
        })

    shortcodes = {key: shortcode for key, shortcode, *_ in FORMS}
    responses = []
    for r in response_rows():
        sid = surveyids[r["form"]]
        responses.append({
            "parent_surveyid": sid,
            "parent_shortcode": shortcodes[r["form"]],
            "surveyid": sid,
            **{k: v for k, v in r.items() if k != "form"},
            "shortcode": shortcodes[r["form"]],
        })
    responses.sort(key=lambda r: (r["userid"], r["timestamp"], r["question_ref"]))
    return forms, responses


def frames(survey_name="fixture-survey"):
    """(responses, form_data) DataFrames, as the export's queries return them."""
    forms, responses = build(survey_name)
    return (
        pd.DataFrame(responses)[RESPONSE_COLUMNS],
        pd.DataFrame(forms),
    )
