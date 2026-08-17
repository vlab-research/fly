# ad_id always-exported metadata — QA findings

Scope: tests only, added to `exporter/exporter/tests/test_exporter.py` covering the
`ALWAYS_EXPORTED_METADATA` change in `exporter/exporter/exporter.py::format_data`
(module constant `ALWAYS_EXPORTED_METADATA = ["ad_id"]`, merged into
`options.metadata` de-duplicated, guarded on `"metadata" in responses.columns`).
No production code was touched by this QA pass.

## How to run

```
cd exporter
poetry install
poetry run pytest exporter/tests/test_exporter.py -v -m "not integration"
```

(`test_db_integration.py` is marked `integration` and needs a live CockroachDB —
excluded via `-m "not integration"`.)

## Tests added

All in `exporter/exporter/tests/test_exporter.py`, reusing the `df`/`form_df`
fixture style already in the file. New fixture `df_with_ad_id` mirrors `df` but
gives some rows an `ad_id` key in their metadata JSON and leaves others without one.

1. `test_format_data_adds_ad_id_column_when_not_requested` — PASS. Headline
   behavior: `ad_id` shows up as a column with the correct value even when
   `options.metadata` is `None`.
2. `test_format_data_ad_id_alongside_requested_metadata` — PASS. `ad_id` and a
   user-requested key (`stratumid`) coexist, both correct.
3. `test_format_data_explicit_ad_id_request_is_not_duplicated` — PASS. Explicitly
   requesting `ad_id` in `options.metadata` still yields exactly one `ad_id`
   column (dedup logic works).
4. `test_format_data_row_without_ad_id_is_null_not_string_none` — PASS. A row
   whose metadata JSON lacks `ad_id` gets `NaN` (`pd.isna`), not the crash or the
   string `"None"`.
5. `test_format_data_ad_id_mixed_rows_line_up` — PASS. Rows with and without
   `ad_id` in the same export line up with the correct rows.
6. `test_format_data_empty_responses_does_not_crash` — **FAIL**, see below.

Result: `6 failed, 5 passed` when running the full file — the 6th failure is the
new empty-responses test above; the other 5 failures are pre-existing tests, not
new ones (see next section).

## Findings (not fixed — reporting only, per instructions)

### 1. Zero-response export still crashes — pre-existing bug, NOT caused by this change

`format_data(pd.DataFrame([]), form_df, options)` raises:

```
KeyError: 'surveyid'
  at vlab_prepro/preprocess.py:141, in add_form_data: df.merge(new_form_df, on="surveyid")
```

`pd.DataFrame([])` has **zero columns** (not just zero rows), so
`p.add_form_data`'s merge on `"surveyid"` fails before `format_data` ever reaches
the new `add_metadata` guard. This is upstream of the `ad_id` change entirely.

Verified this is unrelated to the diff under test: reproduced the identical
`KeyError: 'surveyid'` with the `ad_id` change removed from
`exporter/exporter/exporter.py` (temporarily, via `git stash` on just that file,
then restored immediately — confirmed no residue left in the shared stash list
afterward). Same crash, same stack frame, with or without the change.

So the `"metadata" in responses.columns` guard added in this diff is necessary
(it does prevent an `AttributeError` from `add_metadata` reaching for
`df.metadata` on a columnless frame) but not sufficient — a genuinely
zero-response survey export will still crash today, just one call frame earlier,
in `vlab_prepro.Preprocessor.add_form_data`. Test 6 is left in the file failing
on purpose (per instructions, not contorted to pass) so this is visible and
tracked. Fixing it would mean either short-circuiting `format_data`/`export_data`
before the pipe when `responses` is empty, or making `add_form_data` tolerate a
columnless frame — both are production-code changes, out of scope here.

### 2. Five pre-existing shape-assertion tests now fail — expected side effect of the intended behavior, not a bug

`test_format_data_with_no_options_adds_form_data_with_prefix`,
`test_format_data_with_just_duration`, `test_format_data_with_dropping_users`,
`test_format_data_with_only_final_answer`, and `test_format_data_with_pivot` all
assert a hard-coded `res.shape`. Every one of them now comes up exactly one
column short of the previous hard-coded count, because `ad_id` is unconditionally
added whenever `"metadata"` is a column in `responses` — which it is in every one
of these tests' `df` fixture. This is the intended headline behavior working as
designed, not a regression; the shape assertions are just stale. Left unmodified
here since updating them is outside "tests only, don't touch scope beyond the 6
requested cases" — flagging so whoever owns the merge decides whether to bump
those five shape tuples by one.
