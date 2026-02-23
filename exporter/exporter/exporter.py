import csv
import json
import os
import tempfile

import pandas as pd
from pydantic import BaseModel
from toolz import pipe
from vlab_prepro import Preprocessor

from . import storage
from .db import query, execute
from .log import log


# --- Full Messages Export: event classification and streaming ---

EVENT_GROUPS = {
    "conversation": ["echo", "text", "quick_reply", "postback"],
    "referrals": ["referral", "optin"],
    "bails": ["bailout"],
    "payments": ["payment", "repeat_payment"],
    "external_tracking": ["moviehouse", "linksniffer", "external_other"],
    "retries": ["redo", "follow_up"],
    "system": ["machine_report", "platform_response", "block_user", "unblock"],
    "other": ["watermark", "reaction", "media", "handover", "timeout"],
}


def expand_groups(groups):
    types = set()
    for g in groups:
        types.update(EVENT_GROUPS.get(g, []))
    return types


def classify_event(msg):
    source = msg.get("source")
    if source == "messenger":
        m = msg.get("message", {})
        if m.get("is_echo"):
            return "echo"
        if m.get("quick_reply"):
            return "quick_reply"
        if "text" in m:
            return "text"
        if m.get("attachments"):
            return "media"
        if msg.get("postback"):
            return "postback"
        if msg.get("referral"):
            return "referral"
        if msg.get("read") or msg.get("delivery"):
            return "watermark"
        if msg.get("reaction"):
            return "reaction"
        if msg.get("optin"):
            return "optin"
        if msg.get("pass_thread_control"):
            return "handover"
        return "unknown_messenger"
    elif source == "synthetic":
        etype = msg.get("event", {}).get("type", "")
        if etype == "external":
            subtype = msg.get("event", {}).get("value", {}).get("type", "")
            if subtype.startswith("moviehouse:"):
                return "moviehouse"
            if subtype.startswith("linksniffer:"):
                return "linksniffer"
            if subtype.startswith("payment:"):
                return "payment"
            return "external_other"
        if etype in (
            "bailout", "redo", "follow_up", "repeat_payment", "block_user",
            "unblock", "platform_response", "machine_report", "timeout",
        ):
            return etype
        return "unknown_synthetic"
    return "unknown"


def get_direction(event_type):
    if event_type == "echo":
        return "bot"
    if event_type in ("text", "quick_reply", "postback", "referral", "optin", "media"):
        return "user"
    return "system"


def _to_str(val):
    if isinstance(val, (dict, list)):
        return json.dumps(val)
    if val is None:
        return ""
    return str(val)


def extract_content(msg, event_type):
    if event_type == "echo":
        return msg.get("message", {}).get("text", "")
    if event_type in ("text", "quick_reply"):
        return msg.get("message", {}).get("text", "")
    if event_type == "postback":
        return msg.get("postback", {}).get("title", "")
    if event_type == "referral":
        return msg.get("referral", {}).get("ref", "")
    if event_type == "media":
        attachments = msg.get("message", {}).get("attachments", [])
        if attachments:
            return attachments[0].get("type", "attachment")
        return "attachment"
    if event_type in ("bailout", "redo", "follow_up", "repeat_payment",
                      "block_user", "unblock", "timeout"):
        return msg.get("event", {}).get("type", "")
    if event_type == "machine_report":
        return msg.get("event", {}).get("value", "")
    if event_type == "platform_response":
        value = msg.get("event", {}).get("value", {})
        if isinstance(value, dict):
            return value.get("error", value.get("message_id", ""))
        return str(value)
    return ""


def extract_event_detail(msg, event_type):
    if event_type in ("moviehouse", "linksniffer", "payment", "external_other"):
        return msg.get("event", {}).get("value", {}).get("type", "")
    return ""


FULL_MESSAGES_COLUMNS = [
    "userid", "timestamp", "source", "event_type",
    "direction", "content", "event_detail",
]

FULL_MESSAGES_COLUMNS_WITH_RAW = FULL_MESSAGES_COLUMNS + ["raw_json"]


def _iter_messages(raw_rows, allowed_types, include_raw_json, stats=None):
    if stats is None:
        stats = {"total": 0, "json_errors": 0, "filtered": 0, "yielded": 0}
    for row in raw_rows:
        stats["total"] += 1
        raw = row["content"]
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            stats["json_errors"] += 1
            continue

        event_type = classify_event(msg)
        if event_type not in allowed_types:
            stats["filtered"] += 1
            continue

        stats["yielded"] += 1
        out = {
            "userid": row["userid"],
            "timestamp": row["timestamp"],
            "source": msg.get("source", "unknown"),
            "event_type": event_type,
            "direction": get_direction(event_type),
            "content": _to_str(extract_content(msg, event_type)),
            "event_detail": extract_event_detail(msg, event_type),
        }
        if include_raw_json:
            out["raw_json"] = raw
        yield out


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


def export_data(cnf, export_id, user, survey, options: ExportOptions):
    log.info(f"starting csv export for survey: {survey}")
    set_export_status(cnf, export_id, status="Started")
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
        set_export_status(cnf, export_id, url, status="Finished")
        log.info(f"finished csv export for survey: {survey}")
    except Exception as e:
        set_export_status(cnf, export_id, status="Failed")
        raise e


def set_export_status(cnf, export_id, url="Not Found", status="Failed"):
    """
    Update the export_status row identified by export_id.
    The row was already INSERTed by the dashboard-server with status='Started'.
    """
    q = """
        UPDATE export_status
        SET status = %s, export_link = %s
        WHERE id = %s
    """
    execute(cnf, q, vals=(status, url, export_id))


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


def export_full_messages(cnf, export_id, user, survey, full_messages_options):
    """
    Export full message history for a survey as CSV.
    Streams rows through a generator — never loads all messages into memory.
    Event type filtering happens in the generator before rows hit disk.
    """
    log.info(f"starting full messages export for survey: {survey}")
    set_export_status(cnf, export_id, status="Started")
    storage_backend = storage.get_storage_backend(
        file_path=f"exports/{survey}_full_messages.csv"
    )

    try:
        allowed_types = expand_groups(full_messages_options.event_groups)
        include_raw = full_messages_options.include_raw_json
        columns = FULL_MESSAGES_COLUMNS_WITH_RAW if include_raw else FULL_MESSAGES_COLUMNS

        log.info(
            f"full messages export {export_id}: "
            f"groups={full_messages_options.event_groups}, "
            f"allowed_types={sorted(allowed_types)}, "
            f"include_raw_json={include_raw}"
        )

        if not allowed_types:
            log.warning(f"full messages export {export_id}: allowed_types is empty, no rows will match")

        # Step 1: collect distinct userids for this survey (small result set)
        userid_q = """
            SELECT DISTINCT userid
            FROM responses
            WHERE shortcode IN (
                SELECT shortcode FROM surveys
                WHERE survey_name = %s
                AND userid = (SELECT id FROM users WHERE email = %s)
            )
        """
        userids = [row[0] for row in query(cnf, userid_q, vals=(survey, user))]
        log.info(
            f"full messages export {export_id}: found {len(userids)} users"
        )

        stats = {"total": 0, "json_errors": 0, "filtered": 0, "yielded": 0}

        # Step 2: query messages in batches of userids to force index usage
        # and avoid full table scan on the 101M-row messages table
        def _batched_message_rows():
            batch_size = 500
            for i in range(0, len(userids), batch_size):
                batch = userids[i : i + batch_size]
                placeholders = ",".join(["%s"] * len(batch))
                q = f"""
                    SELECT m.userid, m.timestamp::string AS timestamp, m.content
                    FROM messages m
                    WHERE m.userid IN ({placeholders})
                    ORDER BY m.userid, m.timestamp ASC
                """
                yield from query(cnf, q, vals=tuple(batch), as_dict=True)

        rows = _iter_messages(_batched_message_rows(), allowed_types, include_raw, stats)

        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, newline=""
        )
        try:
            writer = csv.DictWriter(tmp, fieldnames=columns)
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
            tmp.close()

            storage_backend.save_file(tmp.name)
        finally:
            os.unlink(tmp.name)

        log.info(
            f"full messages export {export_id} stats: "
            f"total_rows={stats['total']}, json_errors={stats['json_errors']}, "
            f"filtered_out={stats['filtered']}, written={stats['yielded']}"
        )

        if stats["total"] == 0:
            log.warning(
                f"full messages export {export_id}: query returned 0 rows for "
                f"survey={survey}, user={user}"
            )

        url = storage_backend.generate_link()
        set_export_status(cnf, export_id, url, status="Finished")
        log.info(f"finished full messages export for survey: {survey}")
    except Exception as e:
        set_export_status(cnf, export_id, status="Failed")
        raise e


def export_chat_log(cnf, export_id, user, survey, chat_log_options):
    """
    Export raw chat log data as CSV for a survey.
    No preprocessing -- just a direct dump of the chat_log table.
    Optional columns (raw_payload, metadata) are controlled by chat_log_options.
    """
    log.info(f"starting chat log export for survey: {survey}")
    set_export_status(cnf, export_id, status="Started")
    storage_backend = storage.get_storage_backend(
        file_path=f"exports/{survey}_chat_log.csv"
    )

    try:
        chat_data = get_chat_log(cnf, user, survey, chat_log_options)

        if chat_data.empty:
            log.warning(f"no chat log data found for survey: {survey}")

        storage_backend.save_to_csv(chat_data)
        url = storage_backend.generate_link()
        set_export_status(cnf, export_id, url, status="Finished")
        log.info(f"finished chat log export for survey: {survey}")
    except Exception as e:
        set_export_status(cnf, export_id, status="Failed")
        raise e


def get_chat_log(cnf, user, survey, chat_log_options):
    """
    Returns chat log data for a survey as a dataframe.
    Base columns are always included. metadata and raw_payload
    are conditionally appended based on chat_log_options.
    """
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
