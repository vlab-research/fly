import json
import os
import uuid
from datetime import datetime, timezone

import pytest

from exporter.db import execute

# Set DATABASE_URL to the test CockroachDB to run integration tests.
# Quick start: `make test-db` in devops/, then:
#   DATABASE_URL=postgresql://root@localhost:5433/chatroach python -m pytest
DB_URL = os.environ.get("DATABASE_URL")


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
                      options=None, retry_count=0, locked_at=None)
    """
    inserted = []

    def _insert(eid, status="Requested", source="responses",
                options=None, retry_count=0, locked_at=None):
        inserted.append(eid)
        execute(db_url, """
            INSERT INTO export_status
                (id, user_id, survey_id, status, export_link, source,
                 options, retry_count, locked_at)
            VALUES (%s, 'test@example.com', 'test-survey', %s, 'Not Found',
                    %s, %s::jsonb, %s, %s)
        """, vals=(eid, status, source, json.dumps(options or {}), retry_count, locked_at))
        return eid

    yield _insert

    for eid in inserted:
        try:
            execute(db_url, "DELETE FROM export_status WHERE id = %s", vals=(eid,))
        except Exception:
            pass
