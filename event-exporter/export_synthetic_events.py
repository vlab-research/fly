#!/usr/bin/env python3
"""
Export synthetic external events (moviehouse:* and linksniffer:*) from CockroachDB.

Usage:
    export DATABASE_URL="postgresql://root@localhost:5432/chatroach"
    python export_synthetic_events.py --pageid 105246245358509

    # With date range (uses timestamp index for faster queries):
    python export_synthetic_events.py --pageid 105246245358509 --since 2024-01-01 --until 2024-12-31
"""

import argparse
from datetime import datetime
import json
import os
import sys

import psycopg2
from psycopg2.extras import RealDictCursor


def get_connection_string():
    """Get database connection string from environment."""
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        return database_url

    # Fall back to individual env vars
    host = os.environ.get("DB_HOST", "localhost")
    port = os.environ.get("DB_PORT", "5432")
    dbname = os.environ.get("DB_NAME", "chatroach")
    user = os.environ.get("DB_USER", "root")
    password = os.environ.get("DB_PASSWORD", "")

    if password:
        return f"postgresql://{user}:{password}@{host}:{port}/{dbname}"
    return f"postgresql://{user}@{host}:{port}/{dbname}"


def build_query(
    pageid: str,
    event_types: list[str] | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> tuple[str, dict]:
    """Build the SQL query for exporting events."""
    # Start with timestamp filter if provided (uses index)
    base_query = """
        SELECT content
        FROM chatroach.messages
        WHERE 1=1
    """
    params = {"pageid": pageid}

    # Add timestamp filters first (these use the index)
    if since:
        base_query += " AND timestamp >= %(since)s"
        params["since"] = since
    if until:
        base_query += " AND timestamp < %(until)s"
        params["until"] = until

    # Then add JSON filters
    base_query += """
          AND content::jsonb->>'source' = 'synthetic'
          AND content::jsonb->'event'->>'type' = 'external'
          AND content::jsonb->>'page' = %(pageid)s
    """

    if event_types:
        # Filter to specific event types
        type_conditions = " OR ".join(
            f"content::jsonb->'event'->'value'->>'type' = %(type_{i})s"
            for i in range(len(event_types))
        )
        base_query += f" AND ({type_conditions})"
        params.update({f"type_{i}": t for i, t in enumerate(event_types)})
    else:
        # Default: all moviehouse and linksniffer events
        base_query += """
          AND (content::jsonb->'event'->'value'->>'type' LIKE 'moviehouse:%%'
               OR content::jsonb->'event'->'value'->>'type' LIKE 'linksniffer:%%')
        """

    base_query += " ORDER BY timestamp"

    return base_query, params


def export_events(
    pageid: str,
    output_file: str,
    event_types: list[str] | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    batch_size: int = 5000,
):
    """Export events to a JSONL file using LIMIT/OFFSET pagination."""
    conn_string = get_connection_string()
    base_query, params = build_query(pageid, event_types, since, until)

    print(f"Connecting to database...")
    print(f"Exporting events for pageid: {pageid}")
    if since:
        print(f"Since: {since}")
    if until:
        print(f"Until: {until}")
    if event_types:
        print(f"Filtering event types: {', '.join(event_types)}")
    print(f"Output file: {output_file}")
    print()

    try:
        with psycopg2.connect(conn_string) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                count = 0
                offset = 0

                with open(output_file, "w") as f:
                    while True:
                        # CockroachDB doesn't support server-side cursors,
                        # so we use LIMIT/OFFSET pagination
                        paginated_query = f"{base_query} LIMIT {batch_size} OFFSET {offset}"
                        cur.execute(paginated_query, params)
                        rows = cur.fetchall()

                        if not rows:
                            break

                        for row in rows:
                            f.write(row["content"] + "\n")
                            count += 1

                        print(f"\rExported {count:,} events...", end="", flush=True)
                        offset += batch_size

                print(f"\rExported {count:,} events total.")

    except psycopg2.Error as e:
        print(f"Database error: {e}", file=sys.stderr)
        sys.exit(1)
    except IOError as e:
        print(f"File error: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Export synthetic external events from CockroachDB"
    )
    parser.add_argument(
        "--pageid",
        required=True,
        help="The page ID to filter events by",
    )
    parser.add_argument(
        "--output",
        help="Output file path (default: events_{pageid}.jsonl)",
    )
    parser.add_argument(
        "--event-types",
        help="Comma-separated list of event types (e.g., moviehouse:play,linksniffer:click)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=5000,
        help="Number of rows to fetch at a time (default: 5000)",
    )
    parser.add_argument(
        "--since",
        help="Only export events after this date (YYYY-MM-DD). Uses timestamp index.",
    )
    parser.add_argument(
        "--until",
        help="Only export events before this date (YYYY-MM-DD). Uses timestamp index.",
    )

    args = parser.parse_args()

    output_file = args.output or f"events_{args.pageid}.jsonl"
    event_types = args.event_types.split(",") if args.event_types else None

    since = datetime.fromisoformat(args.since) if args.since else None
    until = datetime.fromisoformat(args.until) if args.until else None

    export_events(
        pageid=args.pageid,
        output_file=output_file,
        event_types=event_types,
        since=since,
        until=until,
        batch_size=args.batch_size,
    )


if __name__ == "__main__":
    main()
