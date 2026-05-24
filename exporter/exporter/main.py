import os
import threading
import time
from datetime import datetime, timedelta

from dotenv import load_dotenv
from pydantic import BaseModel

from .exporter import ExportOptions, export_data, export_chat_log, export_full_messages
from .db import query, execute
from .log import log

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "5"))
MAX_EXPORT_RETRIES = int(os.getenv("MAX_EXPORT_RETRIES", "3"))
STUCK_TIMEOUT_MINUTES = int(os.getenv("STUCK_TIMEOUT_MINUTES", "120"))
WORKER_THREADS = int(os.getenv("WORKER_THREADS", "4"))


class ChatLogExportOptions(BaseModel):
    include_raw_payload: bool = False
    include_metadata: bool = False


class FullMessagesExportOptions(BaseModel):
    event_groups: list[str] = [
        "conversation", "referrals", "bails", "payments",
        "external_tracking", "retries", "system", "other",
    ]
    include_raw_json: bool = False
    start_time: datetime | None = None
    end_time: datetime | None = None


def claim_job(cnf, max_retries, stuck_timeout_minutes):
    """
    Atomically claim one Requested job for processing.

    First resets any stale Processing jobs (pod crashed mid-export) back to
    Requested so they get retried. Then does a two-step guarded claim:
    SELECT a candidate, then UPDATE only if it's still Requested — safe for
    concurrent workers since only one UPDATE will succeed per job_id.

    Returns the claimed row dict, or None if no work is available.
    If retry_count exceeds max_retries after claiming, marks the job Failed
    and returns None.
    """
    # Reset stale in-flight jobs (any worker-managed status with an old lock).
    # Idempotent — safe for all threads to run on every poll.
    execute(cnf, """
        UPDATE export_status
        SET status = 'Requested', locked_at = NULL
        WHERE status NOT IN ('Requested', 'Finished', 'Failed')
          AND locked_at IS NOT NULL
          AND locked_at < NOW() - %s
    """, vals=(timedelta(minutes=stuck_timeout_minutes),))

    # Step 1: find a candidate
    rows = list(query(cnf, """
        SELECT id FROM export_status
        WHERE status = 'Requested'
        ORDER BY updated ASC
        LIMIT 1
    """))
    if not rows:
        return None
    job_id = rows[0][0]

    # Step 2: guarded UPDATE — concurrent workers safely lose the race
    rows = list(query(cnf, """
        UPDATE export_status
        SET status = 'Processing', locked_at = NOW(), retry_count = retry_count + 1
        WHERE id = %s AND status = 'Requested'
        RETURNING id, user_id, survey_id, source, options, retry_count
    """, vals=(job_id,), as_dict=True))

    if not rows:
        return None

    job = rows[0]

    if job['retry_count'] > max_retries:
        execute(cnf, """
            UPDATE export_status SET status = 'Failed', locked_at = NULL WHERE id = %s
        """, vals=(job['id'],))
        log.error(f"export {job['id']} exceeded max retries ({max_retries}), marked Failed")
        return None

    return job


def reset_for_retry(cnf, export_id):
    execute(cnf, """
        UPDATE export_status SET status = 'Requested', locked_at = NULL WHERE id = %s
    """, vals=(export_id,))


def process_job(cnf, job):
    export_id = str(job['id'])
    user = job['user_id']
    survey = job['survey_id']
    source = job['source']
    options_dict = job['options'] or {}

    log.info(f"processing {source} export for study {survey} (id={export_id})")

    if source == 'chat_log':
        opts = ChatLogExportOptions(**options_dict)
        export_chat_log(cnf, export_id, user, survey, opts)
    elif source == 'full_messages':
        opts = FullMessagesExportOptions(**options_dict)
        export_full_messages(cnf, export_id, user, survey, opts)
    else:
        opts = ExportOptions(**options_dict)
        export_data(cnf, export_id, user, survey, opts)


def worker_loop(thread_id, database_url, max_retries, stuck_timeout_minutes, poll_interval):
    log.info(f"worker {thread_id} started")
    while True:
        try:
            job = claim_job(database_url, max_retries, stuck_timeout_minutes)
            if job is None:
                time.sleep(poll_interval)
                continue
            try:
                process_job(database_url, job)
            except BaseException as e:
                log.error(f"worker {thread_id} export {job['id']} failed (attempt {job['retry_count']}): {e}")
                if job['retry_count'] < max_retries:
                    reset_for_retry(database_url, job['id'])
        except BaseException as e:
            log.error(f"worker {thread_id} unexpected error: {e}")
            time.sleep(poll_interval)


def app():
    log.info(f"starting {WORKER_THREADS} export worker threads (poll={POLL_INTERVAL_SECONDS}s, max_retries={MAX_EXPORT_RETRIES})")

    def start_worker(i):
        t = threading.Thread(
            target=worker_loop,
            args=(i, DATABASE_URL, MAX_EXPORT_RETRIES, STUCK_TIMEOUT_MINUTES, POLL_INTERVAL_SECONDS),
            daemon=True,
            name=f"export-worker-{i}",
        )
        t.start()
        return t

    threads = [start_worker(i) for i in range(WORKER_THREADS)]

    while True:
        for i, t in enumerate(threads):
            if not t.is_alive():
                log.warning(f"worker {i} died unexpectedly, restarting")
                threads[i] = start_worker(i)
        time.sleep(30)


if __name__ == "__main__":
    app()
