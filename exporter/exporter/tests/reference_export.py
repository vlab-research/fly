"""
The whole-survey responses and chat_log exports, as they were before exports
were batched by user. Tests run them beside the batched exports and compare
the files.

Only tests use this module. Keep it as it is: it is the reference the batched
code is held to.
"""
import json

import pandas as pd
from toolz import pipe
from vlab_prepro import Preprocessor

from exporter.db import query
from exporter.exporter import ALWAYS_EXPORTED_METADATA, ExportOptions, InvalidOptionsError


def format_data(responses: pd.DataFrame, form_data: pd.DataFrame, options: ExportOptions):
    p = Preprocessor()
    fns = []

    if options.keep_final_answer:
        fns.append(p.keep_final_answer)

    metadata_keys = list(
        dict.fromkeys(ALWAYS_EXPORTED_METADATA + (options.metadata or []))
    )
    if metadata_keys and "metadata" in responses.columns:
        fns.append(p.add_metadata(metadata_keys))

    if options.drop_users_without:
        fns.append(p.drop_users_without(options.drop_users_without))

    if options.drop_duplicated_users:
        fns.append(p.drop_duplicated_users(["shortcode"]))

    if options.add_duration:
        fns.append(p.add_duration())

    if options.pivot:
        if not options.response_value:
            raise InvalidOptionsError(
                f"To pivot to wide format we need a response_value. Options: {options}"
            )
        fns.append(p.pivot(options.response_value))

    return pipe(
        responses,
        p.add_form_data(form_data, prefix="form"),
        *fns,
    )


def get_responses(cnf, user, survey):
    q = """
        SELECT parent_surveyid,
               parent_shortcode,
               surveyid,
               flowid,
               responses.userid,
               question_ref,
               question_idx,
               question_text,
               response,
               timestamp::string,
               responses.metadata::string,
               pageid,
               translated_response
        FROM responses
        LEFT JOIN surveys ON responses.surveyid = surveys.id
        LEFT JOIN users ON surveys.userid = users.id
        WHERE users.email = %s
        AND surveys.survey_name = %s
        ORDER BY (responses.userid, timestamp, question_ref)
    """
    dat = list(query(cnf, q, vals=(user, survey), as_dict=True))
    return pd.DataFrame(dat)


def export_responses_csv(responses, form_data, options):
    """The CSV text the whole-survey export uploaded."""
    return format_data(responses, form_data, options).to_csv(index=False)


def get_chat_log(cnf, user, survey, chat_log_options):
    base_columns = (
        "cl.userid, cl.pageid, cl.timestamp::string AS timestamp, cl.direction, "
        "cl.content, cl.question_ref, cl.shortcode, cl.surveyid::string AS surveyid, "
        "cl.message_type"
    )

    optional_columns = ""
    if chat_log_options.include_metadata:
        optional_columns += ", cl.metadata::string AS metadata"
    if chat_log_options.include_raw_payload:
        optional_columns += ", cl.raw_payload::string AS raw_payload"

    q = f"""
        SELECT DISTINCT {base_columns}{optional_columns}
        FROM chat_log cl
        INNER JOIN surveys s ON cl.shortcode = s.shortcode
        INNER JOIN users u ON s.userid = u.id
        WHERE u.email = %s AND s.survey_name = %s
        ORDER BY cl.userid, timestamp
    """
    dat = list(query(cnf, q, vals=(user, survey), as_dict=True))
    return pd.DataFrame(dat)


def metadata_kinds(responses, keys, final_answers_only):
    """
    What get_metadata_kinds computes in SQL, computed in Python from a
    responses frame: (key, kind, min_int, max_int) rows.
    """
    df = responses
    if final_answers_only:
        df = Preprocessor().keep_final_answer(df)

    seen = {}
    for raw in df.metadata:
        md = json.loads(raw)
        for key in keys:
            v = md.get(key)
            if isinstance(v, bool):
                kind = "boolean"
            elif isinstance(v, int):
                kind = "int"
            elif isinstance(v, float):
                kind = "float"
            elif isinstance(v, str):
                kind = "string"
            elif isinstance(v, dict):
                kind = "object"
            elif isinstance(v, list):
                kind = "array"
            else:
                kind = "null"
            seen.setdefault((key, kind), []).append(v)

    return [
        (key, kind, min(vs), max(vs)) if kind == "int" else (key, kind, None, None)
        for (key, kind), vs in seen.items()
    ]
