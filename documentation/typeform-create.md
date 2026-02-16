# typeform-create.py — Typeform Test Form Generator

> `scripts/typeform-create.py` — Python 3 CLI for creating and managing Typeform
> forms via the API. Stdlib only, no pip dependencies. Designed for AI agents and
> quick manual testing.

## Prerequisites

| Requirement | Details |
|---|---|
| Python | 3.6+ (uses f-strings) |
| Dependencies | None (stdlib only) |
| Auth | `TYPEFORM_TOKEN` env var — a Typeform personal access token |
| Default workspace | `WA44hg` (override with `--workspace`) |

## Commands

### `create` — Create a form

Three input modes, from simplest to most flexible:

#### Mode 1: Inline flags (quick one-liners)

```bash
python scripts/typeform-create.py create \
  --title "Test Survey" \
  --field "mc:q1:Do you like tests?:Yes,No,Maybe" \
  --field "text:q2:Tell us more" \
  --field "statement:intro:Welcome!" \
  --hidden userid \
  --hidden surveyid
```

#### Mode 2: JSON file

```bash
python scripts/typeform-create.py create form.json
```

#### Mode 3: JSON via stdin

```bash
python scripts/typeform-create.py create - <<'EOF'
{
  "title": "My Survey",
  "fields": [
    {
      "type": "multiple_choice",
      "ref": "q1",
      "title": "Pick one\n- A. Yes\n- B. No",
      "properties": {"choices": [{"label": "A"}, {"label": "B"}]}
    },
    {"type": "short_text", "ref": "q2", "title": "Open question"}
  ],
  "hidden": ["userid", "surveyid"]
}
EOF
```

**Output** (JSON to stdout):
```json
{"id": "abc123", "url": "https://form.typeform.com/to/abc123"}
```

#### Combining modes

Inline flags merge with file/stdin input. `--title` overrides the JSON title,
`--field` appends to the JSON fields array, `--hidden` replaces hidden fields.

### `list` — List forms in workspace

```bash
python scripts/typeform-create.py list
python scripts/typeform-create.py list --workspace OTHER_ID
```

**Output**: JSON array of form objects.

### `get` — Get full form JSON

```bash
python scripts/typeform-create.py get <form-id>
```

**Output**: Pretty-printed full Typeform API response for the form.

### `delete` — Delete a form

```bash
python scripts/typeform-create.py delete <form-id>
```

**Output**: `{"deleted": "<form-id>"}`

### `create --example` — Print example form JSON

```bash
python scripts/typeform-create.py create --example
```

Prints a complete example form definition showing every supported field type.
Useful for discovering the expected JSON format.

## Field Spec Format

The `--field` flag accepts a compact string format:

```
TYPE:REF:TITLE
TYPE:REF:TITLE:CHOICE1,CHOICE2,CHOICE3
```

### Type shortcuts

| Shortcut | Typeform API type | Choices? |
|---|---|---|
| `mc` | `multiple_choice` | Required — comma-separated after 4th `:` |
| `text` | `short_text` | No |
| `statement` | `statement` | No |
| `phone` | `phone_number` | No |
| `number` | `number` | No |

### How `mc` choices work

Given `--field "mc:q1:Pick a color:Red,Blue,Green"`, the script generates:

- **Title**: `"Pick a color\n- A. Red\n- B. Blue\n- C. Green"`
- **Choices**: `[{"label": "A"}, {"label": "B"}, {"label": "C"}]`

This follows the project's convention of lettered choice labels (A, B, C...)
displayed in the question title, with only the letter as the response value.

### REF field

The `ref` is a stable identifier for the field, used to reference responses.
Choose short, descriptive names: `q1`, `gender`, `consent`, `age_range`, etc.

## Hidden Fields

Hidden fields are URL parameters that Typeform passes through to
webhooks and response data. They're not shown to the respondent.

```bash
--hidden userid --hidden surveyid --hidden pageid
```

Common hidden fields in this project: `userid`, `surveyid`, `pageid`, `startTime`.

To pre-fill hidden fields, append them to the form URL as query params:
`https://form.typeform.com/to/abc123?userid=123&surveyid=456`

## Defaults Applied

The script automatically applies these defaults so you can keep form definitions minimal:

| Default | Value | Override |
|---|---|---|
| Workspace | `WA44hg` | `--workspace OTHER` |
| Thank you screen | Generic "Thank you" message | Include `thankyou_screens` in JSON |
| `validations.required` | `false` on all fields | Set `validations.required: true` in JSON |
| `allow_multiple_selection` | `false` for mc fields | Set in `properties` in JSON |
| `vertical_alignment` | `true` for mc fields | Set in `properties` in JSON |

## Full JSON Form Schema

For full control, pass a JSON object matching the [Typeform Create API](https://developer.typeform.com/create/reference/create-form/). The script passes your JSON directly to the API after applying defaults. Key fields:

```json
{
  "title": "Form title (required)",
  "fields": [
    {
      "type": "multiple_choice | short_text | statement | phone_number | number",
      "ref": "unique_field_ref",
      "title": "Question text (for mc, include \\n- A. ... labels)",
      "properties": {
        "choices": [{"label": "A"}, {"label": "B"}],
        "allow_multiple_selection": false,
        "vertical_alignment": true,
        "button_text": "Continue"
      },
      "validations": {"required": false}
    }
  ],
  "hidden": ["userid", "surveyid"],
  "thankyou_screens": [
    {
      "ref": "default_ending",
      "title": "Thank you!",
      "properties": {"show_button": false, "share_icons": false}
    }
  ]
}
```

## Error Handling

- Missing `TYPEFORM_TOKEN`: prints error to stderr, exits 1
- API errors (4xx/5xx): prints HTTP status code and response body to stderr, exits 1
- Invalid `--field` spec: prints error and exits 1

## Relationship to Other Tools

| Tool | Purpose |
|---|---|
| `scripts/typeform-create.py` | **Dev/test** — quick form creation for testing features |
| `../upload-typeform` (Go) | **Production** — bulk form uploads from Excel spreadsheets |

This script is the lightweight testing complement to the production upload tool.

## Agent Workflow Examples

### Create a test form, capture its ID, then clean up

```bash
# Create
RESULT=$(python scripts/typeform-create.py create \
  --title "Integration Test Form" \
  --field "mc:q1:Agree?:Yes,No" \
  --hidden userid)
FORM_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# ... run tests using $FORM_ID ...

# Clean up
python scripts/typeform-create.py delete "$FORM_ID"
```

### Create a multi-question survey from JSON

```bash
python scripts/typeform-create.py create - <<'EOF'
{
  "title": "User Feedback Survey",
  "fields": [
    {
      "type": "statement", "ref": "welcome",
      "title": "Thank you for participating!",
      "properties": {"button_text": "Start"}
    },
    {
      "type": "multiple_choice", "ref": "satisfaction",
      "title": "How satisfied are you?\n- A. Very satisfied\n- B. Satisfied\n- C. Neutral\n- D. Unsatisfied",
      "properties": {"choices": [{"label": "A"}, {"label": "B"}, {"label": "C"}, {"label": "D"}]}
    },
    {
      "type": "short_text", "ref": "feedback",
      "title": "Any additional comments?"
    }
  ],
  "hidden": ["userid", "surveyid"]
}
EOF
```
