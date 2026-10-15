# Exporter: bounded memory by exporting in batches of users, on a Polars vlab_prepro

**Status 2026-10-15: Parts A and C implemented on `fix/exporter-streaming`; Part B (vlab_prepro 0.6.0) implemented, not yet on PyPI, so the exporter's `poetry.lock` is not updated yet.** Linear: VIR-92 (client ticket). Related:
VIR-96 (one Kubernetes Job per export, `exporter-k8s-job-dispatch.md`), which
this plan does not replace, and VIR-23 (object keys collide), which it does not
fix.

## Why

On 2026-10-14 two long-format `responses` exports of Kenya Girl Effect
(~605k responses, 12.4k users) were OOM-killed at the exporter's 6Gi limit,
three attempts each, and failed after ~6 hours. Each attempt got through query
and formatting and died while writing. A third export, pivoted, failed with
"Could not pivot" three times because pivot errors are retried.

A responses export holds the whole survey in memory several times over:

1. `get_responses` turns every row into a Python dict, in one list.
2. The list becomes a pandas DataFrame of object (Python string) columns.
3. `add_form_data` merges, copying every column.
4. `save_to_csv` builds the whole CSV as one string, then `.encode()`s a copy.

`chat_log` does the same. `full_messages` already streams (userid batches of
500, `csv.DictWriter` into a temp file, `save_file`), which is why it survives
3M-row exports.

Memory grows with survey size, so any fixed limit is eventually exceeded. The
fix is to make memory depend on a batch size instead.

## Why batching by user works

Every vlab_prepro step a responses export uses needs only one user's rows:

| step | grouped by |
|---|---|
| `add_form_data` | row-wise join on `surveyid` against the (small, whole) form table |
| `add_metadata` | row-wise JSON extraction |
| `keep_final_answer` | (userid, surveyid, question_ref) |
| `drop_users_without` | userid |
| `drop_duplicated_users` | (userid, shortcode) |
| `add_duration` | the key columns, which include userid |
| `pivot` | one output row per user (and form keys) |

So the survey can be processed a batch of users at a time: each batch gets
every row of its users, runs the same pipeline, and is appended to a file.

## Part A — exporter: batched, streamed responses and chat_log (pandas, vlab_prepro 0.5.3)

Ships on its own if Part C slips. Repo: `fly`, branch `fix/exporter-streaming`.

1. **User list first.** One query for the survey's distinct userids, sorted
   (shared with `full_messages`, which already has it). `get_responses` takes a
   batch of userids and keeps its owner/survey joins, so scoping is unchanged.
2. **Batch loop.** `EXPORT_USER_BATCH_SIZE` users per batch (default chosen by
   measurement, see below). Form data is fetched once and passed whole to every
   batch, so flattened form-metadata columns get the same dtypes in every batch.
3. **Fixed header.** Every batch must write the same columns in the same order.
   - Long format: the header is the first non-empty batch's columns.
   - Pivot: question columns are the survey's full distinct `question_ref`
     list (one cheap query), so a question no user in a batch answered is still
     a column. Each batch is reindexed to the header.
   - `add_metadata` names a key `<key>_metadata` when a question shares its
     name, decided from the question_refs present in the frame it is given.
     Decide it once from the survey-wide list so batches agree.
4. **Write.** Append each formatted batch to a temp file (header once), then
   `save_file()`. Remove `save_to_csv` from every storage backend.
5. **`chat_log`** has no preprocessing: query in userid batches and write rows
   with `csv.writer`, as `full_messages` does.
6. **Fail fast on bad options.** `PreprocessingError` ("Could not pivot") and
   `InvalidOptionsError` mark the job Failed on the first attempt, with the
   message in `metadata.error`. Retrying them only delays the answer.
7. **Progress.** `metadata` gets `users`, then running `rows` and
   `batches_done/batches` so a long export visibly moves.
8. **Empty survey** (zero users) finishes with a header-only or empty file
   instead of a KeyError (VIR-12's xfail).

### Accepted differences from the current output

- **Row order.** Whole-survey `add_duration` regroups all rows; per batch it
  regroups within the batch. Rows are the same multiset; order may differ.
  Batches are in userid order.
- **Pivot column order** is currently derived from a Python `set` and is not
  stable between processes. It becomes fixed: key columns sorted, then question
  columns sorted.
- **Pivot: a question no exported user answered** now appears as an empty
  column (the survey-wide question list).

Anything else is a bug.

## Part B — vlab_prepro 0.6.0: Polars inside, type in = type out

Repo: `vlab_prepro`, branch `polars`. The migration in
`planning/polars-migration-plan.md` was never committed; only its tests and
the `polars` dependency survived. This rewrites it with one change of design:

- **A method returns the type it was given.** Given a `pl.DataFrame`, it
  computes and returns Polars with no pandas round trip. Given a pandas
  DataFrame, it converts in, computes in Polars, and converts back, and the
  result matches 0.5.3 (values and dtypes) — existing pandas callers, including
  researchers' notebooks, keep working unchanged.
  (The old plan kept pandas as the only boundary type, converting at every
  method: extra copies at every step, which is the opposite of the point.)
- Pivot raises the same `PreprocessingError` on duplicates; output columns are
  deterministic (sorted keys, then sorted question columns).
- Commit the surviving tests (`tests/test_integration.py`, 66 tests total) and
  run every one on both input types. Rewrite the plan doc to match what ships.
- Version 0.6.0. Published to PyPI after review.

## Part C — exporter on vlab_prepro 0.6.0, Polars end to end

Built on Part A's branch. Implemented as follows.

- **Fetch.** `get_responses` streams the query (`db.stream`, psycopg
  `cursor.stream`) and builds the batch's `pl.DataFrame` 5000 rows at a time
  with an explicit schema (`RESPONSE_SCHEMA`: UUIDs cast to text in SQL,
  `flowid`/`question_idx` Int64, everything else String). Streaming in chunks
  halved the fetch's peak memory compared with building the frame from all
  of a batch's tuples at once. Form data is a `pl.DataFrame` too
  (`FORM_SCHEMA`).
- **Pipeline** on Polars frames (vlab_prepro returns the type it is given).
  pandas is never used in this path, but vlab_prepro imports it, and pandas
  ≥2.2 imports pyarrow, which is most of the exporter's ~200 MB import
  baseline.
- **Form metadata.** vlab_prepro's Polars `flatten_dict` keeps an int key
  missing on some version as Int64; the exporter casts those columns to
  Float64 so they are `1.0`, as pandas wrote them.
- **Metadata columns are not vlab_prepro's `add_metadata`.** On Polars it
  decodes with types inferred over the rows it is given, so a batch's values
  would depend on the other values in the batch (`7` vs `7.0`). The exporter
  extracts each key per row with `str.json_path_match` (`metadata_value`):
  strings unquoted, numbers as Polars prints them (ints as written),
  booleans `True`/`False` (a JSONPath filter `[?(@ == true)]` tells a real
  boolean from the string `"true"`, which json_path_match also returns
  unquoted), objects and arrays as compact JSON, null/absent empty. The
  `<key>_metadata` naming uses the survey-wide question_refs. A key with a
  backslash can't be written as a JSONPath, so it is an `InvalidOptionsError`.
  The SQL dtype classification (`get_metadata_kinds`, `metadata_dtypes`) is
  gone.
- **CSV.** `csv_frame` renders values as pandas' `to_csv` does, then
  `write_csv` appends to the temp file (opened binary). Booleans
  `True`/`False`; floats as Polars prints them, which equals Python's repr
  except for 0 < |x| < 1e-4, where those few values are formatted with repr;
  NaN empty; datetimes per value as `str(pd.Timestamp)` — pandas writes a
  timezone-aware column value by value, a fraction only when non-zero (6
  digits, 9 with nanoseconds), so no column-wide choice is needed; empty
  strings written as empty fields (`write_csv` writes `""`); nested values as
  JSON. Quoting is otherwise identical to pandas' (checked byte for byte).
- **Allocator.** The Dockerfile sets
  `_RJEM_MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0` (Polars appends it to
  its own default `dirty_decay_ms:500,muzzy_decay_ms:1000`).

### Differences from the old (whole-survey pandas) export

Beyond Part A's (row order, pivot column order, pivot empty columns), only in
metadata columns, where pandas typed the whole column:

- an int in a column pandas made float (key missing on some rows, or mixed
  with floats): `1`, not `1.0`;
- an object or array: `{"a":1}`, not `{'a': 1}`;
- a float below 1e-4: `0.000025`, not `2.5e-05`.

No datetime difference was needed (see CSV above).

### Known vlab_prepro 0.6.0 issue (not worked around)

On Polars input, `flatten_dict` builds each form metadata column with
`pl.Series(..., strict=False)`, so a key whose value is an object on one
version and a string on another becomes the text `{1}` (the struct cast to
string), and `true` on one version with `1` on another becomes `1`. pandas
input is unaffected. Only form metadata (one row per survey version) is
affected, and only with such mixed values.

### Verification

- `tests/reference_export.py` is the old export: pandas frames, vlab_prepro
  0.5.3's `preprocess.py` vendored verbatim (`tests/vlab_prepro_053.py`,
  hash-checked against the PyPI wheel's RECORD), `to_csv`.
- `tests/test_batched_export.py` compares every option set at batch sizes 1,
  2, 3, 100 on the fixture survey, and an edge survey (metadata booleans,
  `"true"`, nested objects/arrays, floats incl. < 1e-4 and 1e16, ints with
  gaps, `"007"`, unicode, empty string; question text and responses with
  commas, quotes, `\n`, `\r\n`, `\r`, emoji, leading spaces, empty
  responses). Cells are compared as row multisets with each accepted
  difference as an explicit normalisation, and every record must be quoted
  byte for byte as pandas quotes it.
- `tests/test_export_db_integration.py` runs the same against CockroachDB,
  including the edge survey (whose metadata CockroachDB re-serialises: sorted
  keys, `1E+16`, `0.000025`).

### Measurement

13k users, 650k responses, local CockroachDB, one process per run, peak RSS
(`ru_maxrss`). Part A: pandas, vlab_prepro 0.5.3, pandas 2.1.4. Part C:
Polars 1.42, vlab_prepro 0.6.0, pandas 2.3.3, numpy 2.4, 8 cores. Long:
`metadata=[stratumid, startTime]`; pivot: `keep_final_answer`,
`metadata=[stratumid]`.

Single runs (repeats vary by about 30 MB):

| batch | Part A long | Part C long | Part C long, decay 0 | Part A pivot | Part C pivot | Part C pivot, decay 0 |
|---|---|---|---|---|---|---|
| 250 | 141 MB, 17 s | 328 MB, 12 s | 281 MB, 13 s | 143 MB, 15 s | 298 MB, 12 s | 265 MB, 12 s |
| 500 | 166 MB, 18 s | 307 MB, 12 s | 292 MB, 12 s | 172 MB, 15 s | 308 MB, 12 s | 277 MB, 12 s |
| 1000 | 218 MB, 18 s | 349 MB, 12 s | 322 MB, 12 s | 230 MB, 15 s | 358 MB, 11 s | 292 MB, 12 s |
| 2000 | 323 MB, 18 s | 432 MB, 12 s | 392 MB, 12 s | 346 MB, 16 s | 402 MB, 12 s | 334 MB, 12 s |

Three repeats at 500, default vs decay 0: long 348-352 vs 334-339 MB, pivot
340-341 vs 313-319 MB, long with `keep_final_answer` and `add_duration`
402-417 vs 360-366 MB (Part A: 213 MB, 69 s; Part C: 14 s). Time is the same
with and without decay 0, so the Dockerfile sets it.

Part C peaks are higher than Part A's mostly from imports: ~200 MB before the
first batch against Part A's ~135 MB, because vlab_prepro 0.6.0 imports
pandas, and pandas ≥2.2 imports pyarrow when it is installed (~70 MB), plus
Polars (~50 MB). vlab_prepro importing pandas only when given pandas would
take ~110 MB off every exporter process. Of the rest, Polars' parallel
`write_csv` holds ~60 MB of per-thread memory on 8 cores
(`POLARS_MAX_THREADS=1` gives 265-303 MB at 500 for 10-30 % more time; not
set). Part C is 1.3x faster for long and pivot and 5x faster with
`add_duration`.

**Default batch size stays 500.** Time is flat from 250 to 2000; memory
grows ~35 MB per 500 users (long) above a ~250 MB floor that batch size can't
reduce, so 250 saves little and 1000+ adds memory for no speed.

**Output check.** Full long and pivot exports of the benchmark survey, Part A
(batch 500) against Part C (batch 500): same header in the same order, same
row count, and the files' lines sorted are byte-identical; no accepted
difference occurred (0 cells: the survey's metadata are strings and ints
present on every row, and there are no nested values). Rows are in a
different order (Part A ran on pandas 2.1.4, whose merge orders rows
differently). The `keep_final_answer` + `add_duration` export (datetimes and
float columns) is also byte-identical once sorted. Part C at batch 500 and
2000 writes byte-identical files.

## Tests

The exporter's DB integration tests (`exporter/tests/test_db_integration.py`)
cover only job claiming. Add export tests against a real CockroachDB
(`make test-db` in `devops/`): seed surveys/responses for several users and
forms, run `export_data` with batch sizes 1, 2 and larger than the user count,
and assert the CSV equals the unbatched result, for long, pivot,
keep_final_answer, drop_duplicated_users, drop_users_without, add_duration and
metadata. Plus: owner scoping (another researcher's same-named survey is not
exported), chat_log, pivot failure is not retried.

## Measurement

Synthetic survey shaped like Kenya Girl Effect (12.5k users, ~50 responses
each, realistic question text and metadata JSON) in the local CockroachDB.
Record peak RSS of one responses export, long and pivot, for: current code,
Part A, Part C. Choose the default batch size from this.

## Release

1. vlab_prepro 0.6.0 tagged and published to PyPI.
2. Exporter pins `vlab-prepro = "0.6.0"`; PR to `main`; tag `exporter-v0.7.0`
   (the release workflow builds the image).
3. Staging (`vstag`): bump `versionExporter`, `helm upgrade`, export a test
   survey long and pivoted, check the files.
4. Production: same, then a large export, watching memory
   (`kubectl top pod`) and the exporter log in Loki.
5. Then lower the exporter's memory limit to what was measured.

## Out of scope

- Recovery time after a crash (2 h stuck timeout) — VIR-96.
- Per-export object keys — VIR-23.
