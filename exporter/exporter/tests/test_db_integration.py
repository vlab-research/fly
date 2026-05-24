"""
Integration tests for claim_job and reset_for_retry against a live CockroachDB.

Run `make test-db` in devops/ first, then:
    DATABASE_URL=postgresql://root@localhost:5433/chatroach python -m pytest -m integration
"""
import threading
import time
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from exporter.db import query
from exporter.main import FullMessagesExportOptions, claim_job, reset_for_retry

pytestmark = pytest.mark.integration


class TestClaimJob:
    def test_returns_none_when_table_has_no_requested_rows(self, db_url):
        result = claim_job(db_url, max_retries=3, stuck_timeout_minutes=120)
        assert result is None

    def test_claims_requested_row_and_increments_retry_count(
        self, db_url, export_id, insert_export
    ):
        insert_export(export_id)

        job = claim_job(db_url, max_retries=3, stuck_timeout_minutes=120)

        assert job is not None
        assert str(job["id"]) == export_id
        assert job["user_id"] == "test@example.com"
        assert job["survey_id"] == "test-survey"
        assert job["source"] == "responses"
        assert job["retry_count"] == 1

        row = next(query(db_url, "SELECT status FROM export_status WHERE id = %s", vals=(export_id,)))
        assert row[0] == "Processing"

    def test_ignores_processing_rows(self, db_url, export_id, insert_export):
        insert_export(export_id, status="Processing")
        assert claim_job(db_url, max_retries=3, stuck_timeout_minutes=120) is None

    def test_ignores_finished_rows(self, db_url, export_id, insert_export):
        insert_export(export_id, status="Finished")
        assert claim_job(db_url, max_retries=3, stuck_timeout_minutes=120) is None

    def test_ignores_failed_rows(self, db_url, export_id, insert_export):
        insert_export(export_id, status="Failed")
        assert claim_job(db_url, max_retries=3, stuck_timeout_minutes=120) is None

    def test_resets_stale_processing_job_and_claims_it(
        self, db_url, export_id, insert_export
    ):
        stale_time = datetime.now(timezone.utc) - timedelta(hours=3)
        insert_export(export_id, status="Processing", locked_at=stale_time)

        job = claim_job(db_url, max_retries=3, stuck_timeout_minutes=120)

        assert job is not None
        assert str(job["id"]) == export_id

    def test_fresh_processing_row_is_not_reset(
        self, db_url, export_id, insert_export
    ):
        # locked_at is very recent — should not be reset
        insert_export(export_id, status="Processing", locked_at=datetime.now(timezone.utc))
        assert claim_job(db_url, max_retries=3, stuck_timeout_minutes=120) is None

    def test_exhausts_job_when_max_retries_exceeded(
        self, db_url, export_id, insert_export
    ):
        # retry_count=3 means the next claim increments to 4, which is > max_retries=3
        insert_export(export_id, retry_count=3)

        result = claim_job(db_url, max_retries=3, stuck_timeout_minutes=120)

        assert result is None
        row = next(query(db_url, "SELECT status FROM export_status WHERE id = %s", vals=(export_id,)))
        assert row[0] == "Failed"

    def test_concurrent_workers_never_double_claim(self, db_url, insert_export):
        id1 = str(uuid.uuid4())
        id2 = str(uuid.uuid4())
        insert_export(id1)
        time.sleep(0.05)  # ensure distinct updated timestamps for deterministic ordering
        insert_export(id2)

        results = []

        def _claim():
            results.append(claim_job(db_url, max_retries=3, stuck_timeout_minutes=120))

        t1 = threading.Thread(target=_claim)
        t2 = threading.Thread(target=_claim)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        claimed_ids = [r["id"] for r in results if r is not None]
        # Safety: no id claimed twice
        assert len(claimed_ids) == len(set(claimed_ids))
        # Liveness: at least one claim succeeded
        assert len(claimed_ids) >= 1


class TestResetForRetry:
    def test_sets_status_to_requested_and_clears_lock(
        self, db_url, export_id, insert_export
    ):
        insert_export(export_id, status="Processing", locked_at=datetime.now(timezone.utc))

        reset_for_retry(db_url, export_id)

        row = next(query(
            db_url,
            "SELECT status, locked_at FROM export_status WHERE id = %s",
            vals=(export_id,),
        ))
        assert row[0] == "Requested"
        assert row[1] is None


class TestJsonbRoundtrip:
    def test_full_messages_options_with_datetimes_survive_db_roundtrip(
        self, db_url, export_id, insert_export
    ):
        opts = {
            "event_groups": ["conversation", "bails"],
            "include_raw_json": True,
            "start_time": "2025-10-01T00:00:00.000Z",
            "end_time": "2025-11-01T00:00:00.000Z",
        }
        insert_export(export_id, source="full_messages", options=opts)

        job = claim_job(db_url, max_retries=3, stuck_timeout_minutes=120)

        assert job is not None
        assert str(job["id"]) == export_id

        parsed = FullMessagesExportOptions(**job["options"])
        assert parsed.event_groups == ["conversation", "bails"]
        assert parsed.include_raw_json is True
        assert parsed.start_time == datetime(2025, 10, 1, tzinfo=timezone.utc)
        assert parsed.end_time == datetime(2025, 11, 1, tzinfo=timezone.utc)

    def test_null_options_returns_empty_dict(
        self, db_url, export_id, insert_export
    ):
        insert_export(export_id, options={})

        job = claim_job(db_url, max_retries=3, stuck_timeout_minutes=120)

        assert job is not None
        assert job["options"] == {} or job["options"] is None
