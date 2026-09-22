# LLM Enumerator — Eval Dataset Plan

Plan for a future agent. Goal: build a frozen, labelled eval set for the
LLM-coercion / external-responder feature *before* any of it ships, so the
question "is the model as good as an enumerator" has a number attached.

Nothing here requires the feature to exist. All of it is mineable from prod today.

## Access

Read-only queries against prod CockroachDB, via a throwaway pod (same mechanism as
`devops/run-prod-migration.sh`, which is the write path — do not use it):

```bash
cat query.sql | kubectl run -n vprod -i --rm crq-$$ \
  --image=cockroachdb/cockroach:v24.1.28 --restart=Never --quiet \
  --command -- ./cockroach sql --insecure \
  --host gbv-cockroachdb-public --database chatroach --format tsv
```

Reads only. Never mutate — see the IaC rule in `CLAUDE.md`.

## Why free-text answers exist at all

`chatroach.responses` only records answers that passed the field's validator
(`replybot/lib/generic-validator.js`). So a `question_ref` with hundreds of distinct
values is a `short_text` field — i.e. a question the researcher *wanted* enumerated but
had to leave open. Those are the coercion targets, and their answers are the eval inputs.

Finder query (120-day window, ~2 min):

```sql
SELECT shortcode, question_ref, count(*) AS n,
       count(DISTINCT response) AS distinct_r,
       round(count(DISTINCT response)::float / count(*)::float, 3) AS ratio,
       round(avg(length(response))) AS avg_len
FROM chatroach.responses
WHERE timestamp > now() - interval '120 days'
GROUP BY 1, 2
HAVING count(*) > 300 AND count(DISTINCT response) > 60
ORDER BY distinct_r DESC LIMIT 40;
```

## Candidate sets, best first

### 1. `bauchipay1hausa` / `bauchipay1english` → `mobile_provider` (primary)

Free-text mobile network, feeding a Reloadly airtime payment. ~3.8k responses,
918 distinct values. Contains every failure mode the feature exists to fix:

- casing/spacing variants (`MTN Nigeria`, `MTN NIGERIA`, `Mtn`, `M T N`)
- Hausa phrasing (`Kamfanin mtn` = "MTN company")
- **historical brand names** (`Zain`, `Zaini` → Airtel Nigeria) — the case regex cannot reach
- **wrong-question answers** (`Oppo`, `Vivo`, `Infinix`, `Tecno` — handset brand, not network);
  these are only recoverable by asking a follow-up, so they are the probe-behaviour test set
- **refusals / non-answers** (`Babu` = none, `Bansaniba` = I don't know) — the escape-hatch
  calibration set; a model that codes these into a network is failing, not succeeding
- phone numbers pasted instead of a provider, and bare option indices (`1`)

**Ground truth is downstream.** The Reloadly result for the same user says whether the
provider was right. Pull it from `responses` where `question_ref` is the payment `wait`
ref, and/or from `messages` (payment events; see `documentation/questions.md` on
`e_payment_reloadly_success` / `e_payment_reloadly_error_message`). Join on `userid`.
Confirm the join and the exact result shape before trusting it — this was not verified.

### 2. Invalid-text-then-button pairs (largest, needs mining)

Every time a user typed text at a `multiple_choice` field they got
`label.error.mustSelect`, the question was re-sent via `_gatherResponses`, and they
eventually tapped a button. That is a free-text → human-chosen-label pair, in the real
populations and languages.

Lives only in `chatroach.messages` (`content` is the raw event JSON; cast to JSONB).
`responses` never sees the rejected text. Mine per-user ordered windows:
user TEXT event → subsequent `quick_reply`/`postback` on the same `question_ref`.

`messages` is large — do not `count(*)` it unscoped (times out). Scope by shortcode's
userid set from `responses` first, then window per user.

### 3. Human-coded sample: `girleffectbl` / `demog_city`

396 distinct city spellings, avg length 7. Cheap to hand-code a few hundred into a
canonical list; gives a clean normalisation benchmark separate from the comprehension
cases above.

### 4. Date coercion: `ENGbauchiMNCHbase` / `q10_first_dose_date`

375 distinct free-text date strings. Tests the `number`/`date` arm of propose-and-validate
(the existing `validateNumber` / date validators become the judge).

## Deliverable

1. **Frozen JSONL** per set: `{input, context: {question_text, choices}, label, source}`.
   Freeze it — the eval must not move when prod moves. Strip/pseudonymise `userid`;
   drop the phone-number and name questions entirely (PII, and not codeable anyway).
2. **Scoring script** reporting three numbers separately — they trade off against each other
   and a single accuracy figure hides the important failure:
   - **coding accuracy** on answers that do map to an option
   - **escape recall** on `Babu`/`Bansaniba`/refusals — did it correctly decline to code?
   - **forced-fit rate** on `Oppo`/`Vivo`/wrong-question answers — how often did it invent
     a plausible network instead of probing? This is the metric that matters most; a model
     optimising for "produce a valid choice" is structurally biased to fail here.
3. **Baselines** to beat: exact match, lowercase+trim, fuzzy/Levenshtein against choice labels.
   If a cheap string baseline gets most of set 1, that narrows what the model is actually for.
4. **Model comparison** across the cheap tier (candidates the owner named: DeepSeek-class
   flash models, Haiku) — cost per 1k codings alongside the three accuracy numbers.

## Out of scope

Multi-turn probe quality cannot be evaluated offline from this data — there are no
recorded clarification exchanges yet. Sets 1–4 measure single-shot coding and the
*decision* to probe, not probe wording. Probe quality needs a live randomised arm
(`seed_2`) once the feature ships.
