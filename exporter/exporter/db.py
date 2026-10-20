from .log import log
import re

import psycopg
from psycopg import sql


# Creates a new connection and closes on every transaction
# TODO: create a pool that's shared/managed
def _connect(cnf):
    return psycopg.connect(cnf)


def _query(cur, q, vals=(), as_dict=False):
    with cur:
        cur.execute(q, vals)

        if as_dict:
            column_names = [desc[0] for desc in cur.description]
            for record in cur:
                yield dict(zip(column_names, record))
        else:
            for record in cur:
                yield record


def snapshot_timestamp(cnf):
    """
    A timestamp to read at with `as_of`: follower_read_timestamp(), the newest
    one CockroachDB has closed, so reads at it never wait on or conflict with
    writes still in flight.
    """
    with _connect(cnf) as conn:
        return conn.execute("SELECT follower_read_timestamp()").fetchone()[0]


def _read_as_of(conn, as_of):
    # A query's own AS OF SYSTEM TIME clause is rejected inside the
    # transaction psycopg has opened ("inconsistent AS OF SYSTEM TIME").
    if as_of is not None:
        conn.execute(sql.SQL("SET TRANSACTION AS OF SYSTEM TIME {}").format(sql.Literal(as_of)))


def query(cnf, q, vals=(), as_dict=False, as_of=None):
    """
    Yields the rows of q. With `as_of`, a timestamp, reads the database as it
    was then: such reads are never restarted by concurrent writes.
    """
    with _connect(cnf) as conn:
        _read_as_of(conn, as_of)
        for x in _query(conn.cursor(), q, vals, as_dict):
            yield x


def stream(cnf, q, vals=(), as_of=None):
    """
    Yields the rows of q as tuples as the server sends them, without holding
    the whole result in the client first, as query() does. `as_of` as for
    query().
    """
    with _connect(cnf) as conn:
        _read_as_of(conn, as_of)
        with conn.cursor() as cur:
            yield from cur.stream(q, vals)


def execute(cnf, q, vals=()):
    with _connect(cnf) as conn:
        with conn.cursor() as cur:
            cur.execute(q, vals)
