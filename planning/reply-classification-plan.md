# Classifying rejected replies

**Status:** plan, 2026-09-30. Nothing built. Decisions below are settled unless
marked OPEN.

Every free-text message a respondent sends that the bot does not accept as an
answer gets classified by a small model into a fixed taxonomy: is this person
annoyed, and what about. It is a batch job writing to its own table, not part of
the live conversation. Nothing acts on the result at first. The table feeds
survey-health statistics for two readers:

- **researchers**, on the dashboard, to see how their survey is going;
- **agents** monitoring a study (the study watch,
  `projects/study-watch-plan.md`), which read the same statistics.

Related: `planning/external-responder-design.md` and
`planning/llm-enumerator-eval.md` put a model *inside* the conversation. This
plan does not. The classifier runs beside the conversation, never feeds the
machine, and so has none of the replay-determinism constraints those documents
deal with. The two should share the provider choice and the model-alias config.

## Why

A study in the field finds out respondents are angry only when someone reads
their messages. On LAC Healthy Diets that was a regex over Spanish complaint
words (`projects/lac-healthy-diets/read_replies.py`) run by hand. It misses
sarcasm, other languages and spellings, flags harmless questions, and only
looked at pay and end forms. Respondents calling us a scam also counts against
the WhatsApp number's quality rating, so catching it early is not only courtesy.

The same data says which questions confuse people: many rejected replies on one
question means the question, not the respondent, is the problem.

## What counts as a rejected reply

`chatroach.responses` holds only answers that passed the field's validator
(`replybot/lib/generic-validator.js`). A TEXT event reaches the validator for the
current question in every state except START, RESPONDING, USER_BLOCKED and a
handover wait (`replybot/lib/typewheels/machine.js`, `case 'TEXT'`). So a
respondent's text is one of:

| Case | What the bot does | In `responses`? |
|---|---|---|
| Valid answer (a number for a number field, an option label, any text for short_text) | moves on | yes |
| Invalid answer (text where a button or number was expected) | re-sends the question with the error message | no |
| Text to a statement, including end screens: `validateStatement` is always `valid: false` | sends the statement's `responseMessage` | no |
| Text while RESPONDING, USER_BLOCKED or in a handover | drops it silently | no |

**Rejected = inbound free text with no matching row in `responses`.** That covers
the last three rows: wrong answers, people writing after the survey or while
waiting on a payment, and messages replybot dropped. Accepted short_text answers
are survey data and are not classified by default.

Neither the rejection nor the drop is recorded as an event, so this is derived
offline: an inbound text message (`messages`, WhatsApp `type: text` or a
Messenger `message.text` that is not an echo or quick reply) for which
`responses` has no row with the same `userid` and `timestamp`. **To verify
first:** that a response's `timestamp` is the inbound event's timestamp
(`scribble/response.go` writes the event's), and how a WhatsApp interactive
reply that matched nothing appears.

## Taxonomy

Small enums, so output can be checked by type and counted:

- `mood`: `neutral` | `confused` | `annoyed` | `angry`
- `about`: `payment_not_received` | `scam_accusation` | `question_unclear` |
  `answer_attempt` (a real answer the validator could not parse) |
  `wants_to_stop` | `asking_something` | `other`
- `needs_human`: bool
- stored with each row: message id, userid, shortcode, question ref, model,
  prompt version, the model's confidence where it gives one.

`wants_to_stop` matters before anything else does: a person asking to be left
alone should stop getting messages.

## Provider

Respondent text is personal data and our data is in the EU (GKE cluster
`toixo`, `europe-west1`). Multilingual is required: most surveys are not in
English.

**Decision: Vertex AI, `eu` multi-region endpoint, Gemini 3.1 Flash-Lite as the
default**, scored against Claude Haiku 4.5 and Mistral Small 3.1 before
committing (see Evaluation). Same Google Cloud project and data processing terms
as the rest of our infrastructure.

Prices as read from the vendors' pages on 2026-09-30 (USD per million tokens,
input / output; re-check before relying on them). Monthly cost assumes ~450
input and ~40 output tokens per message. Last week's volume was 10k–40k inbound
text messages a day across all studies, every answer included, so ~30k/day is a
ceiling for classifying everything; rejected replies alone are far fewer, ~2k/day
assumed until counted.

| Option | EU processing guaranteed | Price | ~30k/day, per month | ~2k/day, per month |
|---|---|---|---|---|
| Vertex Gemini 3.1 Flash-Lite (`eu`) | yes, EU multi-region | $0.275 / $1.65 | ~$170 (~$85 batch) | ~$11 |
| Vertex Gemini 3.5 Flash-Lite (`eu`) | yes, EU multi-region | $0.33 / $2.75 | ~$230 | ~$16 |
| Vertex Claude Haiku 4.5 | yes, also `europe-west1` itself | $1.10 / $5.50 | ~$640 | ~$43 |
| Vertex Mistral Small 3.1 | yes, EU multi-region and `europe-west4` | $0.10 / $0.30 | ~$50 | ~$4 |
| Vertex Llama 4, Qwen3, Gemma 4 (Model Garden) | no, US only | — | — | — |
| Fireworks serverless (Qwen3 8B, Nemotron, gpt-oss-120b) | no, US servers under standard contractual clauses | $0.05–0.20 | ~$30–90 | ~$2–6 |
| Fireworks dedicated H100, Frankfurt | yes, Enterprise contract only | ~$12/GPU-hour | ~$8,700 | same |
| TypeSafe Jev | no EU option found | $0.042 input | ~$17 | ~$1 |

Why not the others:
- **Jev** (TypeSafe AI, early access since 2026-09-15) fits the shape exactly
  (typed questions in, typed answers with confidence out) but is English-first;
  its docs say other languages "are handled but not equally well".
- **Fireworks** keeps no prompts or outputs for open models by default and holds
  SOC 2 Type II and ISO 27001/27701/42001, but EU residency is Enterprise-only
  and its docs list only US. EU serverless is reportedly on their roadmap. OPEN:
  ask our account contact whether they would contract EU serverless, and read
  their DPA (not publicly readable when checked).
- **Vertex open models** carry no EU residency commitment.
- **Gemini 2.5** models retire 2026-10-20.

Vertex details that matter:
- Use the `eu` endpoint (`aiplatform.eu.rep.googleapis.com`), never `global`,
  which gives no residency guarantee. Belgium is not listed for Gemini; the EU
  multi-region is. Batch jobs must also use a regional endpoint.
- Google does not train on Vertex data without permission (Cloud Data Processing
  Addendum, all managed models). Not training is not the same as not keeping:
  for zero retention, request the abuse-monitoring logging exception, disable
  the project's 24-hour in-memory cache, and leave request-response logging and
  search grounding off.
- The 10% regional premium is assumed to apply to `eu` as well; the pricing page
  only says "non-global". Gemini 3.5 Flash-Lite currently has promotional credits.
- Structured output: Gemini `responseSchema` with string enums; Claude structured
  outputs with `output_config.format`.

## Evaluation

No vendor publishes accuracy on classifying short chat messages, and published
multilingual numbers are reasoning benchmarks (Haiku 4.5 relative to English:
~96% Spanish and Portuguese, ~92% Arabic and Hindi, ~78% Swahili). So:

1. Pull 200–300 rejected replies across our languages, not only LAC's Spanish,
   to a gitignored location (respondent data never goes in git).
2. Hand-label them with the taxonomy. LAC's 29 Sep review (18 complainants,
   each checked against payment records) is a start.
3. Score the LAC regex, Flash-Lite, Haiku 4.5 and Mistral Small. Recall on
   `angry`, `scam_accusation` and `wants_to_stop` matters most; per language,
   not just overall.
4. Pick the default. If a language is weak, route it, or low-confidence
   messages, to the stronger model.

Freeze the set; it becomes the regression test when the model or prompt changes.

## Building it

1. **Count.** A read-only query for rejected replies per day per study, to
   replace the ~2k/day assumption and check the derivation above.
2. **Eval** as above.
3. **Batch classifier.** Not real time: an in-cluster CronJob (helm values)
   runs every hour, classifies rejected replies since the last run, and writes
   them to their own `chatroach` table (a new migration under
   `devops/migrations/`), keyed by message id so a re-run never classifies a
   message twice. A table rather than files, so it joins with `states` and
   `responses` and both the dashboard and agents read one source.
4. **Statistics.** Per survey and per day, computed from the table:
   - share of respondents with a rejected reply, and of those, how many
     `annoyed` or `angry`;
   - counts by `about`, with `payment_not_received` joined to payment status
     (unpaid: pay them; paid: a timing or wording problem);
   - per question, rejected replies and `question_unclear` / `answer_attempt`,
     so a confusing question stands out;
   - anyone with `wants_to_stop`.
5. **Readers, read-only.** The dashboard's study health page
   (`documentation/dashboard-study-health.md`) shows researchers the
   statistics. The study watch reads the same ones each run and reports what
   crosses a threshold. OPEN: whether agents read them through the agent API /
   MCP or by query.
6. **Acting** (later, each a separate decision): honouring `wants_to_stop`,
   apology or re-ask flows, copy changes.

## Open questions

- How agents read the statistics: agent API / MCP tool, or a query (step 5).
- Whether to classify accepted short_text answers too, for some studies.
- Consent: check each study's terms allow sending respondent text to a model
  provider, even inside the EU.
- Fireworks EU serverless and DPA, if we want a second provider.
