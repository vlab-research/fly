from vlab_prepro import Preprocessor
from db import setup_database_connection
from toolz import pipe
from log import log
import pandas as pd
from sqlalchemy import text
import storage

def export_data(conn, user, survey):
    log.info(f'starting csv export for survey: {survey}')
    set_export_status(conn, user, survey, status="Started")
    storage_backend = storage.get_storage_backend(file_path=f'exports/{survey}.csv')

    try:
        # Get responses and form data from database
        responses = get_responses(conn, user, survey)
        form_data = get_form_data(conn, user, survey)

        # process data using the vlab prepro library
        p = Preprocessor()
        dd = p.add_form_data(form_data, responses)
# TODO: we should add this as another export
#        dd = pipe(responses,
#            p.add_form_data(form_data),
#            p.keep_final_answer,
#            p.add_duration(),
#            p.add_metadata(["creative", "stratum_gender", "stratum_age", "stratum_location", "seed"]),
#            p.drop_duplicated_users(["shortcode"]),
#        )

        # store as csv on configured backend
        storage_backend.save_to_csv(dd)
        url = storage_backend.generate_link()
        set_export_status(conn, user, survey, url, status="Finished")
        log.info(f'finished csv export for survey: {survey}')
    except Exception as e:
        set_export_status(conn, user, survey, status="Failed")
        raise e

def set_export_status(conn, user, survey, url="Not Found", status="Failed"):
    query = f"""
        INSERT INTO export_status (survey_id, user_id, status, export_link)
		VALUES ('{survey}','{user}', '{status}', '{url}')
        ON CONFLICT (user_id, survey_id)
        DO UPDATE SET (status, export_link) = (excluded.status, excluded.export_link)
    """
    conn.execute(text(query))
    conn.commit()

def get_responses(conn, user, survey):
    """
    Returns the responses of a survey in a dataframe
    """
    query = f"""
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
        WHERE users.email = '{user}'
        AND surveys.survey_name = '{survey}'
        ORDER BY (responses.userid, timestamp, question_ref)
    """
    return pd.read_sql_query(text(query), con=conn)

def get_form_data(conn, user, survey):
    """
    Returns the form data that is related to a specific survey in a dataframe
    """
    query = f"""
        WITH t AS (
          SELECT surveys.*, row_number() OVER (partition BY shortcode ORDER BY created) AS version
          FROM surveys
          LEFT JOIN users ON surveys.userid = users.id
          WHERE users.email = '{user}'
          AND survey_name = '{survey}'
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
    return pd.read_sql_query(text(query), con=conn)

