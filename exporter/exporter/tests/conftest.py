import json
import os
import time
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from exporter.db import execute, query


SNAPSHOT = datetime(2026, 1, 1, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _stub_export_db_calls(request):
    """
    Unit tests don't have a real DB; stub set_metadata so its UPDATE no-ops,
    and snapshot_timestamp to return SNAPSHOT. Integration tests (marked) opt
    out and exercise the real calls.
    """
    if request.node.get_closest_marker("integration"):
        yield
        return
    with patch("exporter.exporter.set_metadata"), \
            patch("exporter.exporter.snapshot_timestamp", return_value=SNAPSHOT):
        yield

# Set DATABASE_URL to the test CockroachDB to run integration tests.
# Quick start: `make test-db` in devops/, then:
#   DATABASE_URL=postgresql://root@localhost:5433/chatroach python -m pytest
DB_URL = os.environ.get("DATABASE_URL")


def wait_for_follower_reads(cnf, timeout=30):
    """
    Waits until what was committed before the call can be read at
    follower_read_timestamp(), the timestamp exports read at.
    """
    committed = list(query(cnf, "SELECT now()"))[0][0]
    deadline = time.monotonic() + timeout
    while not list(query(cnf, "SELECT follower_read_timestamp() > %s", vals=(committed,)))[0][0]:
        if time.monotonic() > deadline:
            raise TimeoutError(f"follower_read_timestamp() did not pass {committed}")
        time.sleep(0.2)


@pytest.fixture
def db_url():
    if not DB_URL:
        pytest.skip("DATABASE_URL not set — run 'make test-db' in devops/ first")
    return DB_URL


@pytest.fixture
def export_id():
    return str(uuid.uuid4())


@pytest.fixture
def insert_export(db_url):
    """
    Factory fixture that inserts an export_status row and cleans it up after
    the test. Returns a callable:
        insert_export(export_id, status="Requested", source="responses",
                      options=None, retry_count=0, locked_at=None,
                      user_id="test@example.com", survey_id="test-survey")
    """
    inserted = []

    def _insert(eid, status="Requested", source="responses",
                options=None, retry_count=0, locked_at=None,
                user_id="test@example.com", survey_id="test-survey"):
        inserted.append(eid)
        execute(db_url, """
            INSERT INTO export_status
                (id, user_id, survey_id, status, export_link, source,
                 options, retry_count, locked_at)
            VALUES (%s, %s, %s, %s, 'Not Found', %s, %s::jsonb, %s, %s)
        """, vals=(eid, user_id, survey_id, status, source,
                   json.dumps(options or {}), retry_count, locked_at))
        return eid

    yield _insert

    for eid in inserted:
        try:
            execute(db_url, "DELETE FROM export_status WHERE id = %s", vals=(eid,))
        except Exception:
            pass
