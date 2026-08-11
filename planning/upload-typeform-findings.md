# upload-typeform Exploration Findings

**Date**: 2026-02-15
**Location**: `/home/nandan/Documents/vlab-research/upload-typeform`

## 1. Overall Structure

The project is a Go CLI tool for creating and managing Typeform surveys programmatically. It reads survey definitions from Excel (.xlsx) files and uses the Typeform API to create, update, and translate forms.

### File Tree (non-git, non-binary)

```
upload-typeform/
  .env                          # Typeform credentials (TYPEFORM_BASE_URL, TYPEFORM_TOKEN)
  .gitignore                    # Ignores .env*, binaries, vendor/
  credentials.json              # Google OAuth2 client credentials (for Sheets API)
  token.json                    # Google OAuth2 token (auto-generated)
  go.mod / go.sum               # Go module definition
  README.md                     # Usage documentation

  # Source files
  main.go                       # Core logic: form building, API client, CLI entrypoint
  config.go                     # SurveyFile: Excel parsing, form configuration
  translate.go                  # Translation logic: copy refs, translate forms
  google.go                     # Google Sheets API integration (appears unused in main flow)

  # Test files
  main_test.go                  # Integration tests with mock HTTP server
  config_test.go                # SurveyFile/InitialForms tests
  translate_test.go             # Translation logic tests
  parse_test.go                 # BuildField/BuildForm/ParseMessages unit tests
  coverage.out                  # Test coverage output

  # Test fixtures
  test/
    form_a.json                 # Full Typeform API response example (Routine Immunization)
    config_a.yaml               # Example YAML config (not used in code)
    translate_test_en.json      # English form fixture for translation tests
    translate_test_sp.json      # Spanish form fixture for translation tests
    logic_test_en.json          # English form with logic jumps
    logic_test_sp.json          # Spanish form with logic jumps
    scratch2.json               # Scratch test file
    test-out.json               # Test output
    Survey Translation Example.xlsx
    Survey Translation Example Spanish.xlsx
    Survey Translation Example (updated).xlsx

  # Project-specific survey data (Excel files)
  bebbo/                        # (empty or xlsx files)
  berlin-brandenburg/
  curiouslearning/              # EdTech Multi Parents Survey, US Survey
  embed/                        # Moldova VL Survey
  embed-uae/                    # Diagnostic Survey PA MENA (English + Arabic)
  marijuana-berg/
  pgp-minnesota/                # Minnesota Gen Pop Surveys (English + Somali)
  polio-pgp/
  routine-immunization/         # Routine Immunization (Armenian)
  shujaaz/                      # Shujaaz Free2Choose (English + Sheng)
  sigap/                        # SIGAP Media First Evaluation (English + Indonesian)
  survey-sampling/

  upload-typeform               # Compiled binary (9.5MB)
```

## 2. Typeform API Interaction Patterns

### Authentication

- **Method**: Bearer token via HTTP header
- **Config**: Two env vars loaded via `github.com/caarlos0/env/v6`:
  - `TYPEFORM_BASE_URL` = `https://api.typeform.com` (required)
  - `TYPEFORM_TOKEN` = personal access token (required)
- **Implementation** (`main.go:222-234`): Uses `github.com/dghubble/sling` HTTP client library. The `TypeformUploader.Api()` method creates a sling instance with base URL and `Authorization: Bearer <token>` header. The sling instance is cached after first creation.
- **Credential file**: `.env` contains a real token `tfp_<REDACTED — real token, see the gitignored .env>` (note: `.env*` is in `.gitignore`)

### API Endpoints Used

| Endpoint | Method | Purpose | Code Location |
|----------|--------|---------|---------------|
| `GET /forms?workspace_id=X&page_size=100` | GET | List all forms in a workspace | `main.go:264-292` (`GetForms`) |
| `GET /forms/{id}` | GET | Get a single form by ID | `main.go:236-252` (`GetForm`) |
| `POST /forms` | POST | Create a new form | `main.go:362-390` (`sendForm`) |
| `PUT /forms/{id}` | PUT | Update an existing form | `main.go:362-390` (`sendForm`) |
| `PUT /forms/{id}/messages` | PUT | Update form custom messages | `main.go:332-354` (`UpdateMessages`) |

### API Call Flow

**Create Form** (`CreateForm`, `main.go:392-413`):
1. Extract workspace ID from the form's workspace href
2. `GET /forms?workspace_id=X` -- assert no form with the same title exists
3. `POST /forms` -- create the form, get form ID from `Location` response header
4. `PUT /forms/{id}/messages` -- update custom messages (expects 204 response)

**Update Form** (`UpdateForm`, `main.go:416-443`):
1. `GET /forms?workspace_id=X` -- find existing form by title
2. `GET /forms/{id}` -- get full form details
3. Set form ID on the new form data
4. If `keepLogic=true`: copy logic and choice refs from existing form
5. `PUT /forms/{id}` -- update the form

**Translate Form** (`Translations`, `main.go:479-512`):
1. Parse base Excel and translation Excel files
2. `GET /forms?workspace_id=X` + `GET /forms/{id}` -- get the actual English form from Typeform
3. Call `TranslateForm()` to merge structure (refs, logic, hidden) from source with translated text
4. Return translated FormConf ready for create/update

### Error Handling

- `TypeformError` struct (`main.go:172-184`): Deserializes Typeform API error responses with `code`, `description`, and `details` fields
- `ExistingFormError` sentinel (`main.go:294`): Used to skip already-existing forms during batch creation
- Errors from `sendForm` are returned but the function returns `(error, string)` -- note the unusual Go convention of error first in return

## 3. Form Structures / Schemas

### Core Types (in upload-typeform)

```go
// main.go:200-209
type Form struct {
    ID              string            `json:"id,omitempty"`
    Workspace       Workspace         `json:"workspace,omitempty"`
    Title           string            `json:"title"`
    Fields          []*trans.Field    `json:"fields"`
    ThankYouScreens []*ThankyouScreen `json:"thankyou_screens,omitempty"`
    Logic           json.RawMessage   `json:"logic,omitempty"`
    Hidden          []HiddenVariable  `json:"hidden,omitempty"`
}

type Workspace struct {
    Href string `json:"href,omitempty"`   // e.g. "https://api.typeform.com/workspaces/12345"
}

type ThankyouScreen struct {
    Ref   string `json:"ref"`
    Title string `json:"title"`
}

type HiddenVariable string
```

### Shared Types (from `github.com/vlab-research/trans@v0.0.14/forms.go`)

```go
type Field struct {
    ID         string           `json:"id,omitempty"`
    Type       string           `json:"type,omitempty"`        // "multiple_choice", "short_text", "statement", "phone_number", "thankyou_screen", "hidden"
    Title      string           `json:"title,omitempty"`
    Ref        string           `json:"ref,omitempty"`         // Unique reference string for the field
    Properties *FieldProperties `json:"properties,omitempty"`
}

type FieldProperties struct {
    Choices     []*FieldChoice `json:"choices,omitempty"`
    Description string         `json:"description,omitempty"`
}

type FieldChoice struct {
    ID    string `json:"id,omitempty"`
    Label string `json:"label,omitempty"`     // The display text for the choice
    Ref   string `json:"ref,omitempty"`       // Unique reference for the choice (used in logic)
}
```

### Supported Question Types

From `BuildField` (`main.go:70-136`):

| Type | Behavior |
|------|----------|
| `multiple_choice` | Parses options into choices. Two modes: (a) labeled answers like "A. Foo" put full text in title and extract labels as choices, (b) plain answers like "yes\nno" use each line as a choice label |
| `thankyou_screen` | Creates a `ThankyouScreen` with ref and title |
| `hidden` | Creates a `HiddenVariable` (just the ref string) |
| Any other (e.g. `short_text`, `statement`, `phone_number`) | Creates a generic `trans.Field` with type, title, ref, properties |

### Multiple Choice Answer Format

The `trans.ExtractLabels()` function (`forms.go:62-92`) parses labeled answer options using regex. Supports:
- `- A. Foo` (dash prefix with letter label)
- `A. Foo` (letter label with dot)
- `A) Foo` (letter label with paren)
- Unicode letters, Arabic-Indic digits, Devanagari digits, Bengali digits, emoji as labels
- Multi-digit numbers

If `ExtractLabels` finds labeled answers, the title includes the full text (question + options), and choices use just the label letter (e.g., "A", "B"). If no labels are found, each line becomes a choice with its full text as the label.

### Form Logic Structure (from test fixtures)

Logic is stored as `json.RawMessage` and passed through without parsing. The structure from Typeform:

```json
{
    "type": "field",
    "ref": "field_ref",
    "actions": [
        {
            "action": "jump",
            "details": { "to": { "type": "field", "value": "target_ref" } },
            "condition": {
                "op": "is",
                "vars": [
                    { "type": "field", "value": "field_ref" },
                    { "type": "choice", "value": "choice_ref" }
                ]
            }
        }
    ]
}
```

Logic references fields and choices by their `ref` values (not IDs). This is why `CopyChoiceRefs` is important during translation -- it ensures the translated form has the same refs so logic still works.

### Messages

Custom messages are a simple `map[string]string` sent to `PUT /forms/{id}/messages`. They come from a "Messages" sheet in the Excel file with columns `[key, value]`. Keys are Typeform message identifiers like `label.error.mustSelect`.

## 4. Scripts / Utilities for Form Creation

### CLI Interface (`main.go:636-674`)

```bash
# Flags
--workspace   string  # Typeform workspace ID (required)
--base        string  # Path to base Excel file (required)
--translation string  # Path to translation Excel file (optional)
--update      bool    # Update existing form instead of creating (default: false)
--sheet       string  # Process only a specific sheet (optional)
--direct      bool    # Run direct from file (stub, not implemented)
--reverse     bool    # Download a form from Typeform to Excel
--form-id     string  # Form ID for --reverse mode
--path        string  # Output path for --reverse mode
```

### Execution Modes

1. **Base Create** (`runBaseCreate`): Parse Excel, create forms from each non-"Messages" sheet
2. **Base Update** (`runBaseCreate` with `--update`): Parse Excel, update existing forms (preserves logic and choice refs)
3. **Translation Create** (`runTranslations`): Uses base + translation Excel, fetches existing English form from API, creates translated form
4. **Translation Update** (`runTranslations` with `--update`): Same but updates existing translated form
5. **Reverse** (`runReverse`): Downloads a form from Typeform API and writes it to an Excel file
6. **Direct** (`runDirect`): Stub -- not implemented

### Excel File Format

Each Excel workbook contains:
- **Multiple sheets** (one per form variant, e.g., "Baseline", "Payment", "Endline") with columns:
  - Column A: `ref` (variable name / unique reference)
  - Column B: `question_type` (e.g., "multiple_choice", "short_text", "statement", "thankyou_screen", "hidden")
  - Column C: `question` (the question text)
  - Column D: `answers` (newline-separated options for multiple_choice)
  - Column E: `description` (optional description)
  - Row 1 is a header row (skipped during parsing)
- **"Messages" sheet**: Two columns `[key, value]` for custom Typeform messages

### Form Naming Convention

Forms are named: `{filename without extension} - {sheet name}`
Example: File `Survey Translation Example.xlsx` with sheet `Baseline` produces form title `Survey Translation Example - Baseline`

### SurveyFile (`config.go`)

The `SurveyFile` struct wraps Excel parsing:
- `NewSurveyFile(workspace, path)` creates a config from workspace ID and file path
- `InitialForms()` returns `map[string]*FormConf` keyed by sheet name
- Each `FormConf` contains: `Name`, `Form` (the built form), `MessagesData` (raw messages rows)

## 5. Credentials / Token Management

### Typeform

- **Token type**: Personal access token (prefix `tfp_`)
- **Storage**: `.env` file at project root
- **Loading**: `caarlos0/env/v6` reads from environment variables (not from .env file directly -- the `.env` file needs to be sourced manually or via a tool)
- **Security**: `.env*` is in `.gitignore`

### Google Sheets (secondary, possibly unused in main flow)

- **credentials.json**: OAuth2 client credentials for Google Sheets API (project "toixotoixo")
  - Client ID: `880175497193-lo2gk444fhvqjndagisq2gr2db26rgbk.apps.googleusercontent.com`
  - Note: This file is NOT in `.gitignore` and is committed
- **token.json**: OAuth2 refresh/access token (auto-generated on first auth)
  - File permissions: 0600 (owner read/write only)
  - Note: This file is also NOT in `.gitignore`
- **google.go**: Contains `Auth()` function that reads from Google Sheets. It reads from a hardcoded spreadsheet ID `1mBrvr1YxfR__-UENbz31lHAkyzWgNDfi6ypGByVVRz8`. This function is never called from `main()` -- it appears to be leftover/experimental code.

### Config YAML (test/config_a.yaml)

There is a YAML config format defined but not used in the current code:
```yaml
workspace: foo
name: Routine Immunization
forms:
  - tab: Baseline
  - tab: Payment
  - tab: Endline
messages:
  tab: Messages
baseFile:
  lang: English
  path: eng.xlsx
translationFiles:
  - lang: Armenian
    path: arm.xlsx
```
This suggests a planned but unimplemented configuration-file-driven approach.

## 6. Package Dependencies

### Direct Dependencies (go.mod)

| Package | Version | Purpose |
|---------|---------|---------|
| `github.com/caarlos0/env/v6` | v6.7.2 | Environment variable parsing into structs |
| `github.com/dghubble/sling` | v1.4.0 | HTTP client with fluent API (builds requests, handles JSON) |
| `github.com/vlab-research/trans` | v0.0.14 | Shared Typeform types (Field, FieldChoice, FieldProperties) + form translation utilities |
| `github.com/xuri/excelize/v2` | v2.6.0 | Excel file reading/writing (.xlsx) |
| `github.com/stretchr/testify` | v1.8.1 | Test assertions |
| `golang.org/x/oauth2` | v0.7.0 | Google OAuth2 (for Sheets API) |
| `google.golang.org/api` | v0.118.0 | Google API client (for Sheets API) |

### The `trans` Package (`github.com/vlab-research/trans@v0.0.14`)

This is a shared vlab-research package that provides:
- **Type definitions**: `Field`, `FieldChoice`, `FieldProperties`, `Workspace`, `Form`
- **Label extraction**: `ExtractLabels()` -- regex-based parser for labeled answer options (supports Unicode, RTL)
- **Answer extraction**: `ExtractAnswers()` -- determines if choices are abbreviated (A/B/C) or full text
- **Translation utilities**: `MakeTranslatorByRef()`, `MakeTranslatorByShape()`, `MakeFieldTranslator()`, `MakeMCTranslator()`
- Note: The `trans.Form` type is different from the local `Form` type. The local `Form` adds `ID`, `Hidden`, and uses `ThankyouScreen` instead of `*Field` for thank-you screens.

## 7. Key Observations and Patterns

### Translation Workflow

The core translation pattern is:
1. Create English form from Excel --> POST to Typeform
2. Add logic manually in Typeform UI
3. Fetch the English form back from API (now has refs, IDs, logic)
4. Parse translation Excel
5. Merge: take structure (refs, logic, hidden) from fetched English form, take text from translation Excel
6. POST/PUT the translated form

This ensures translated forms have identical structure (same refs, same logic) but different text.

### Ref Copying (`translate.go`)

`CopyChoiceRefs(src, dest, skipErrors)` copies choice refs from a source form to a destination form, matching by field ref. This is critical because Typeform logic uses choice refs, and newly built forms from Excel don't have them.

### Error Patterns

- Fatal errors use `log.Fatal()` via the `handle()` helper
- API errors are returned as `*TypeformError` implementing the `error` interface
- `BuildField` errors are logged but continue (form building is lenient with blank rows)
- `ExistingFormError` is a sentinel error checked with `errors.Is()` to skip duplicates

### Unused/Stub Code

- `runDirect()` (`main.go:599-601`): Empty function body
- `google.go`: Google Sheets integration not connected to main flow
- `test/config_a.yaml`: YAML config format defined but no YAML parsing in code

### Go Version

The module uses Go 1.17 (`go.mod:3`), which is quite old. Several dependencies are also dated (2022-2023 era).

### Active Project Directories (by modification date)

Most recently used projects based on file timestamps:
- `embed-uae/` (Jan 2026) -- Diagnostic Survey PA MENA
- `sigap/` (Nov 2025) -- SIGAP Media First Evaluation
- `shujaaz/` (Sep 2025) -- Shujaaz Free2Choose Evaluation
- `pgp-minnesota/` (Oct 2025) -- Minnesota Gen Pop Surveys
