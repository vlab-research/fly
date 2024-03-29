import pandas as pd
from pydantic import BaseModel
from toolz import pipe
from vlab_prepro import Preprocessor

from . import storage
from .db import query, execute
from .log import log


class ExportOptions(BaseModel):
    pivot: bool = False
    keep_final_answer: bool = False
    drop_duplicated_users: bool = False
    add_duration: bool = False
    metadata: list[str] | None = None
    drop_users_without: str | None = None
    response_value: str | None = None


class InvalidOptionsError(BaseException):
    pass


def format_data(
    responses: pd.DataFrame,
    form_data: pd.DataFrame,
    options: ExportOptions,
):
    p = Preprocessor()
    fns = []

    if options.keep_final_answer:
        fns.append(p.keep_final_answer)

    # TODO: autopopulate metadata??? Just add it all?
    if options.metadata:
        fns.append(p.add_metadata(options.metadata))

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


def export_data(cnf, user, survey, options: ExportOptions):
    log.info(f"starting csv export for survey: {survey}")
    set_export_status(cnf, user, survey, status="Started")
    storage_backend = storage.get_storage_backend(file_path=f"exports/{survey}.csv")

    try:
        # Get responses and form data from database
        responses = get_responses(cnf, user, survey)
        form_data = get_form_data(cnf, user, survey)

        # process data using the vlab prepro library
        dd = format_data(responses, form_data, options)

        # store as csv on configured backend
        storage_backend.save_to_csv(dd)
        url = storage_backend.generate_link()
        set_export_status(cnf, user, survey, url, status="Finished")
        log.info(f"finished csv export for survey: {survey}")
    except Exception as e:
        set_export_status(cnf, user, survey, status="Failed")
        raise e


def set_export_status(cnf, user, survey, url="Not Found", status="Failed"):
    q = f"""
        INSERT INTO export_status (survey_id, user_id, status, export_link)
		VALUES (%s, %s, %s, %s)
        ON CONFLICT (user_id, survey_id)
        DO UPDATE SET (status, export_link) = (excluded.status, excluded.export_link)
    """
    execute(cnf, q, vals=(survey, user, status, url))


def get_responses(cnf, user, survey):
    """
    Returns the responses of a survey in a dataframe
    """
    q = f"""
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
    """
    Returns the form data that is related to a specific survey in a dataframe
    """
    q = f"""
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
