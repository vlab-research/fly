from .log import log
import re

import psycopg


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


def query(cnf, q, vals=(), as_dict=False):
    with _connect(cnf) as conn:
        for x in _query(conn.cursor(), q, vals, as_dict):
            yield x


def execute(cnf, q, vals=()):
    with _connect(cnf) as conn:
        with conn.cursor() as cur:
            cur.execute(q, vals)
