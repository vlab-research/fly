import csv
import json
import os
import tempfile

import pandas as pd
from pydantic import BaseModel
from vlab_prepro import PreprocessingError, Preprocessor

from . import storage
from .db import query, execute
from .log import log


# Users per batch for responses and chat_log exports. Peak memory grows with
# this, not with the survey; see "Memory" in exporter/README.md.
EXPORT_USER_BATCH_SIZE = int(os.getenv("EXPORT_USER_BATCH_SIZE", "1000"))


def batched(items, size):
    return [items[i : i + size] for i in range(0, len(items), size)]


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


# Metadata keys promoted to CSV columns on every responses export, whether or
# not the user asked for them. `ad_id` is the opaque ad identifier replybot
# stamps onto `state.md` at conversation start; vlab owns the
# (network, ad_id) -> stratum mapping and the join happens at analysis time, so
# this column is the researcher's only handle on it from a raw CSV.
ALWAYS_EXPORTED_METADATA = ["ad_id"]


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


# Errors that come from the export's options or data, so every attempt fails the
# same way: the worker marks the job Failed instead of retrying it.
NON_RETRYABLE_ERRORS = (PreprocessingError, InvalidOptionsError)


def validate_options(options: ExportOptions):
    if options.pivot and not options.response_value:
        raise InvalidOptionsError(
            f"To pivot to wide format we need a response_value. Options: {options}"
        )


def metadata_keys(options: ExportOptions):
    # `ad_id` is always exported, never opt-in. It is the key a researcher joins
    # vlab's (network, ad_id) -> stratum mapping on, and this CSV is the whole
    # manual join path for people working in R or Stata. Leaving it to the
    # free-text "Metadata to add as columns" box would mean most exports simply
    # ship without the join key, which defeats the point. Requested keys follow
    # it, de-duplicated so asking for `ad_id` explicitly stays harmless.
    return list(dict.fromkeys(ALWAYS_EXPORTED_METADATA + (options.metadata or [])))


def _mapped_dtype(values):
    """The dtype Series.map gives a column holding these values."""
    return pd.Series(list(values), dtype=object).map(lambda v: v).dtype


# One stand-in value per kind of JSON value (see get_metadata_kinds).
_KIND_EXAMPLES = {
    "float": 0.5,
    "string": "",
    "boolean": True,
    "null": None,
    "object": {},
    "array": [],
}


def metadata_dtypes(kinds):
    """
    Maps each metadata key to the dtype pandas infers for its column over the
    whole survey, from the (key, kind, min_int, max_int) rows of
    get_metadata_kinds. The inferred dtype depends only on which kinds of value
    the column holds and on the range of its ints, so one example of each
    stands in for every row.
    """
    examples = {}
    for key, kind, lo, hi in kinds:
        vals = [int(lo), int(hi)] if kind == "int" else [_KIND_EXAMPLES[kind]]
        examples.setdefault(key, []).extend(vals)
    return {key: _mapped_dtype(vals) for key, vals in examples.items()}


def _add_metadata(p, keys, question_refs, dtypes):
    """
    Preprocessor.add_metadata, except that the `<key>_metadata` naming (used
    when a question shares the key's name) and each column's dtype are given,
    not taken from the rows at hand. Every batch of an export gets the
    survey-wide answer, so all batches write the same columns the same way: an
    int key missing on some rows is 1.0 in every batch, not 1 in some.
    """

    def add(df):
        parsed = [json.loads(m) for m in df.metadata]
        refs = set(df.question_ref.unique()) if question_refs is None else question_refs
        for key in keys:
            col = f"{key}_metadata" if key in refs else key
            values = pd.Series([m.get(key) for m in parsed], index=df.index, dtype=object)
            dtype = _mapped_dtype(values) if dtypes is None else dtypes.get(key, object)
            df[col] = values if dtype == object else values.astype(dtype)
            p.keys.add(col)
        return df

    return add


def _pivot(p, answer_column, question_refs):
    def pivot(df):
        wide = p.pivot(answer_column, df)
        refs = set(df.question_ref.unique()) if question_refs is None else question_refs
        return wide.reindex(columns=sorted(p.keys) + sorted(refs))

    return pivot


def format_data(
    responses: pd.DataFrame,
    form_data: pd.DataFrame,
    options: ExportOptions,
    question_refs=None,
    dtypes=None,
):
    """
    Runs a responses export's preprocessing over `responses`.

    `question_refs` (every question_ref in the survey) and `dtypes` (the
    metadata columns' dtypes, from metadata_dtypes()) describe the whole
    survey. A batch of its users passes them so that its columns, their order
    and their formatting match every other batch's. Left out, they are taken
    from `responses`.

    Returns an empty frame as soon as a step leaves no rows; its columns are
    then incomplete, so callers skip it.
    """
    validate_options(options)
    p = Preprocessor()
    steps = [p.add_form_data(form_data, prefix="form")]

    if options.keep_final_answer:
        steps.append(p.keep_final_answer)

    keys = metadata_keys(options)
    if keys and "metadata" in responses.columns:
        steps.append(_add_metadata(p, keys, question_refs, dtypes))

    if options.drop_users_without:
        steps.append(p.drop_users_without(options.drop_users_without))

    if options.drop_duplicated_users:
        steps.append(p.drop_duplicated_users(["shortcode"]))

    if options.add_duration:
        steps.append(p.add_duration())

    if options.pivot:
        steps.append(_pivot(p, options.response_value, question_refs))

    df = responses
    for step in steps:
        if len(df) == 0:
            break
        df = step(df)
    return df


def append_csv(fh, df, header):
    """
    Appends df's rows to an open export CSV whose columns are `header`, or, if
    header is None, starts it with df's columns as the header line. Empty
    frames are skipped. Returns the header.
    """
    if len(df) == 0:
        return header
    if header is None:
        df.to_csv(fh, index=False)
        return list(df.columns)
    if set(df.columns) != set(header):
        raise ValueError(
            f"batch columns {sorted(df.columns)} do not match the export's "
            f"header {header}"
        )
    df.to_csv(fh, index=False, header=False, columns=header)
    return header


def export_data(cnf, export_id, user, survey, options: ExportOptions,
                batch_size=None):
    """
    Export a survey's responses as CSV, processed batch_size users at a time,
    so memory depends on the batch size and not on the survey. Every
    preprocessing step needs only one user's rows, which is what makes the
    batches independent.
    """
    log.info(f"starting csv export for survey: {survey}")
    set_export_status(cnf, export_id, status="Querying")
    storage_backend = storage.get_storage_backend(file_path=f"exports/{survey}.csv")

    try:
        validate_options(options)
        userids = get_survey_userids(cnf, user, survey)
        batches = batched(userids, batch_size or EXPORT_USER_BATCH_SIZE)
        set_metadata(
            cnf, export_id, users=len(userids), responses=0, rows=0,
            batches_done=0, batches=len(batches),
        )

        form_data = get_form_data(cnf, user, survey)
        question_refs = set(get_question_refs(cnf, user, survey))
        dtypes = metadata_dtypes(get_metadata_kinds(
            cnf, user, survey, metadata_keys(options), options.keep_final_answer
        ))

        set_export_status(cnf, export_id, status="Writing")
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, newline=""
        )
        try:
            header = None
            n_responses = n_rows = 0
            for i, batch in enumerate(batches, 1):
                responses = get_responses(cnf, user, survey, batch)
                dd = format_data(responses, form_data, options, question_refs, dtypes)
                header = append_csv(tmp, dd, header)
                n_responses += len(responses)
                n_rows += len(dd)
                # Free this batch before the next is fetched, or two are held at once.
                del responses, dd
                set_metadata(
                    cnf, export_id, responses=n_responses, rows=n_rows, batches_done=i
                )
            tmp.close()

            set_export_status(cnf, export_id, status="Uploading")
            storage_backend.save_file(tmp.name)
        finally:
            tmp.close()
            os.unlink(tmp.name)

        url = storage_backend.generate_link()
        set_export_status(cnf, export_id, url, status="Finished")
        log.info(f"finished csv export for survey: {survey}")
    except (Exception, *NON_RETRYABLE_ERRORS) as e:
        set_metadata(cnf, export_id, error=str(e)[:500])
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


def set_metadata(cnf, export_id, **fields):
    """
    Merge fields into the export_status.metadata JSONB column. Keys persist
    after Finished/Failed so users see context on past exports.
    """
    execute(cnf, """
        UPDATE export_status
        SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
        WHERE id = %s
    """, vals=(json.dumps(fields), export_id))
    log.info(f"export {export_id} metadata: {fields}")


# The survey's responses joined to its owner. Through surveyid, not shortcode:
# shortcodes are reused across owners' surveys, so a shortcode filter pulls in
# other researchers' users.
_SURVEY_RESPONSES = """
    FROM responses r
    JOIN surveys s ON r.surveyid = s.id
    JOIN users u ON s.userid = u.id
    WHERE u.email = %s AND s.survey_name = %s
"""


def get_survey_userids(cnf, user, survey):
    """The userids that responded to the survey, sorted."""
    q = f"SELECT DISTINCT r.userid {_SURVEY_RESPONSES} ORDER BY r.userid"
    return [row[0] for row in query(cnf, q, vals=(user, survey))]


def get_question_refs(cnf, user, survey):
    """Every question_ref answered in the survey, sorted."""
    q = f"SELECT DISTINCT r.question_ref {_SURVEY_RESPONSES} ORDER BY r.question_ref"
    return [row[0] for row in query(cnf, q, vals=(user, survey))]


def get_metadata_kinds(cnf, user, survey, keys, final_answers_only):
    """
    For each metadata key, the kinds of value it takes across the survey's
    responses, as (key, kind, min_int, max_int) rows. kind is how Python's json
    module reads the value: 'int', 'float', 'string', 'boolean', 'object',
    'array', or 'null' (JSON null or key absent). min_int and max_int are set
    for 'int' only.

    final_answers_only limits it to the rows keep_final_answer keeps, the last
    answer per (userid, surveyid, question_ref): the metadata step runs after
    that one, so the dropped rows never reach it.
    """
    if not keys:
        return []

    if final_answers_only:
        rows = f"""
            SELECT metadata FROM (
                SELECT r.metadata, row_number() OVER (
                    PARTITION BY r.userid, r.surveyid, r.question_ref
                    ORDER BY r.timestamp DESC
                ) AS nth
                {_SURVEY_RESPONSES}
            ) AS answers WHERE nth = 1
        """
    else:
        rows = f"SELECT r.metadata {_SURVEY_RESPONSES}"

    # A JSON number is an int to json.loads iff its text is all digits.
    q = f"""
        WITH answers AS ({rows}),
        valued AS (
            SELECT k.key, answers.metadata ->> k.key AS txt,
                   jsonb_typeof(answers.metadata -> k.key) AS typ
            FROM answers, unnest(%s::STRING[]) AS k(key)
        ),
        kinds AS (
            SELECT key, txt,
                   CASE
                       WHEN typ = 'number' AND txt ~ '^-?[0-9]+$' THEN 'int'
                       WHEN typ = 'number' THEN 'float'
                       ELSE COALESCE(typ, 'null')
                   END AS kind
            FROM valued
        )
        SELECT key, kind,
               min(CASE WHEN kind = 'int' THEN txt::DECIMAL END)::STRING,
               max(CASE WHEN kind = 'int' THEN txt::DECIMAL END)::STRING
        FROM kinds
        GROUP BY key, kind
    """
    return list(query(cnf, q, vals=(user, survey, list(keys))))


RESPONSE_COLUMNS = [
    "parent_surveyid",
    "parent_shortcode",
    "surveyid",
    "flowid",
    "userid",
    "question_ref",
    "question_idx",
    "question_text",
    "response",
    "timestamp",
    "metadata",
    "pageid",
    "translated_response",
]


def get_responses(cnf, user, survey, userids):
    """
    Returns the responses of `userids` to the survey in a dataframe
    """
    placeholders = ",".join(["%s"] * len(userids))
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
        AND responses.userid IN ({placeholders})
        ORDER BY (responses.userid, timestamp, question_ref)
    """
    dat = query(cnf, q, vals=(user, survey, *userids))
    return pd.DataFrame(list(dat), columns=RESPONSE_COLUMNS)


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
    set_export_status(cnf, export_id, status="Querying")

    start_time = full_messages_options.start_time
    end_time = full_messages_options.end_time

    suffix = ""
    if start_time or end_time:
        def _stamp(dt):
            return dt.strftime("%Y%m%dT%H%M%SZ") if dt else "open"
        suffix = f"_{_stamp(start_time)}_to_{_stamp(end_time)}"

    storage_backend = storage.get_storage_backend(
        file_path=f"exports/{survey}_full_messages{suffix}.csv"
    )

    try:
        allowed_types = expand_groups(full_messages_options.event_groups)
        include_raw = full_messages_options.include_raw_json
        columns = FULL_MESSAGES_COLUMNS_WITH_RAW if include_raw else FULL_MESSAGES_COLUMNS

        log.info(
            f"full messages export {export_id}: "
            f"groups={full_messages_options.event_groups}, "
            f"allowed_types={sorted(allowed_types)}, "
            f"include_raw_json={include_raw}, "
            f"start_time={start_time}, end_time={end_time}"
        )

        if not allowed_types:
            log.warning(f"full messages export {export_id}: allowed_types is empty, no rows will match")

        userids = get_survey_userids(cnf, user, survey)
        log.info(
            f"full messages export {export_id}: found {len(userids)} users"
        )
        set_metadata(cnf, export_id, users=len(userids))

        stats = {"total": 0, "json_errors": 0, "filtered": 0, "yielded": 0}

        # Step 2: query messages in batches of userids to force index usage
        # and avoid full table scan on the 101M-row messages table
        def _batched_message_rows():
            batch_size = 500
            for i in range(0, len(userids), batch_size):
                batch = userids[i : i + batch_size]
                placeholders = ",".join(["%s"] * len(batch))
                q = (
                    f"SELECT m.userid, m.timestamp::string AS timestamp, m.content "
                    f"FROM messages m "
                    f"WHERE m.userid IN ({placeholders})"
                )
                extra_vals = []
                if start_time is not None:
                    q += " AND m.timestamp >= %s"
                    extra_vals.append(start_time)
                if end_time is not None:
                    q += " AND m.timestamp < %s"
                    extra_vals.append(end_time)
                q += " ORDER BY m.userid, m.timestamp ASC"
                yield from query(cnf, q, vals=tuple(batch) + tuple(extra_vals), as_dict=True)

        rows = _iter_messages(_batched_message_rows(), allowed_types, include_raw, stats)

        set_export_status(cnf, export_id, status="Writing")
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, newline=""
        )
        try:
            writer = csv.DictWriter(tmp, fieldnames=columns)
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
            tmp.close()

            set_metadata(cnf, export_id, rows=stats["yielded"])
            set_export_status(cnf, export_id, status="Uploading")
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
        set_metadata(cnf, export_id, error=str(e)[:500])
        set_export_status(cnf, export_id, status="Failed")
        raise e


def export_chat_log(cnf, export_id, user, survey, chat_log_options, batch_size=None):
    """
    Export raw chat log data as CSV for a survey.
    No preprocessing -- just a direct dump of the chat_log table, queried in
    batches of users and streamed to a file.
    Optional columns (raw_payload, metadata) are controlled by chat_log_options.
    """
    log.info(f"starting chat log export for survey: {survey}")
    set_export_status(cnf, export_id, status="Querying")
    storage_backend = storage.get_storage_backend(
        file_path=f"exports/{survey}_chat_log.csv"
    )

    try:
        userids = get_chat_log_userids(cnf, user, survey)
        batches = batched(userids, batch_size or EXPORT_USER_BATCH_SIZE)
        set_metadata(
            cnf, export_id, users=len(userids), rows=0,
            batches_done=0, batches=len(batches),
        )

        if not userids:
            log.warning(f"no chat log data found for survey: {survey}")

        set_export_status(cnf, export_id, status="Writing")
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, newline=""
        )
        try:
            # "\n" line endings, as pandas' to_csv writes them.
            writer = csv.writer(tmp, lineterminator="\n")
            writer.writerow(chat_log_columns(chat_log_options))
            n_rows = 0
            for i, batch in enumerate(batches, 1):
                for row in get_chat_log(cnf, user, survey, chat_log_options, batch):
                    writer.writerow(row)
                    n_rows += 1
                set_metadata(cnf, export_id, rows=n_rows, batches_done=i)
            tmp.close()

            set_export_status(cnf, export_id, status="Uploading")
            storage_backend.save_file(tmp.name)
        finally:
            tmp.close()
            os.unlink(tmp.name)

        url = storage_backend.generate_link()
        set_export_status(cnf, export_id, url, status="Finished")
        log.info(f"finished chat log export for survey: {survey}")
    except Exception as e:
        set_metadata(cnf, export_id, error=str(e)[:500])
        set_export_status(cnf, export_id, status="Failed")
        raise e


CHAT_LOG_COLUMNS = [
    "userid",
    "pageid",
    "timestamp",
    "direction",
    "content",
    "question_ref",
    "shortcode",
    "surveyid",
    "message_type",
]


def chat_log_columns(chat_log_options):
    columns = list(CHAT_LOG_COLUMNS)
    if chat_log_options.include_metadata:
        columns.append("metadata")
    if chat_log_options.include_raw_payload:
        columns.append("raw_payload")
    return columns


# chat_log rows belong to a survey through their shortcode.
_SURVEY_CHAT_LOG = """
    FROM chat_log cl
    INNER JOIN surveys s ON cl.shortcode = s.shortcode
    INNER JOIN users u ON s.userid = u.id
    WHERE u.email = %s AND s.survey_name = %s
"""


def get_chat_log_userids(cnf, user, survey):
    """The userids with chat log rows in the survey, sorted."""
    q = f"SELECT DISTINCT cl.userid {_SURVEY_CHAT_LOG} ORDER BY cl.userid"
    return [row[0] for row in query(cnf, q, vals=(user, survey))]


def get_chat_log(cnf, user, survey, chat_log_options, userids):
    """
    Yields the chat log rows of `userids` in the survey, as tuples in
    chat_log_columns() order. metadata and raw_payload are included
    according to chat_log_options.
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

    # DISTINCT because a survey has a surveys row per version, so the join
    # repeats each chat_log row once per version of its form.
    placeholders = ",".join(["%s"] * len(userids))
    q = f"""
        SELECT DISTINCT {base_columns}{optional_columns}
        {_SURVEY_CHAT_LOG}
        AND cl.userid IN ({placeholders})
        ORDER BY cl.userid, timestamp
    """
    return query(cnf, q, vals=(user, survey, *userids))
