"""
The whole-survey responses and chat_log exports, as they were before exports
were batched by user and moved to Polars: pandas frames from the queries, run
through vlab_prepro 0.5.3 and written with to_csv. Tests run them beside the
current exports and compare the files.

`vlab_prepro_053.py` is 0.5.3's preprocess.py, copied verbatim from the wheel
on PyPI (sha256 iM6yRtsbS9Vi50H5yxkWhezwyUxApZ1P98FbSPmEU7k in its RECORD),
so the reference does not move when vlab_prepro does.

Only tests use this module. Keep it as it is: it is the reference the export
is held to.
"""
import pandas as pd
from toolz import pipe

from exporter.db import query
from exporter.exporter import ALWAYS_EXPORTED_METADATA, ExportOptions, InvalidOptionsError
from exporter.tests.vlab_prepro_053 import PreprocessingError, Preprocessor  # noqa: F401


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


def get_form_data(cnf, user, survey):
    q = """
        WITH t AS (
          SELECT surveys.*, row_number() OVER (partition BY shortcode ORDER BY created) AS version
          FROM surveys
          LEFT JOIN users ON surveys.userid = users.id
          WHERE users.email = %s
          AND survey_name = %s
        )
        SELECT id as surveyid,
               shortcode,
               survey_name,
               version,
               created::string as survey_created,
               metadata::string
        FROM t
        ORDER BY shortcode, created
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
