# Trans Package Findings

## Location and Version

- **Used by upload-typeform**: `github.com/vlab-research/trans v0.0.14` (from `/home/nandan/Documents/vlab-research/upload-typeform/go.mod` line 43)
- **Local source repo**: `/home/nandan/Documents/vlab-research/trans/`
- **Go module cache**: `~/go/pkg/mod/github.com/vlab-research/trans@v0.0.14/`
- **The local copy and v0.0.14 cached version are identical**

## Core Type Definitions (forms.go)

All types are in package `trans`, file `forms.go`:

### FieldChoice (line 9-13)
```go
type FieldChoice struct {
    ID    string `json:"id,omitempty"`
    Label string `json:"label,omitempty"`
    Ref   string `json:"ref,omitempty"`
}
```
Represents a single answer option in a multiple-choice field.

### FieldProperties (line 15-18)
```go
type FieldProperties struct {
    Choices     []*FieldChoice `json:"choices,omitempty"`
    Description string         `json:"description,omitempty"`
}
```
Contains the configurable properties of a field. Only `Choices` and `Description` are modeled; Typeform has more properties (e.g., `labels`, `start_at_one`, `steps` for opinion_scale, `show_button`/`share_icons` for thankyou_screens) but they are not captured in this struct -- they get silently dropped during JSON unmarshaling.

### Field (line 20-26)
```go
type Field struct {
    ID         string           `json:"id,omitempty"`
    Type       string           `json:"type,omitempty"`
    Title      string           `json:"title,omitempty"`
    Ref        string           `json:"ref,omitempty"`
    Properties *FieldProperties `json:"properties,omitempty"`
}
```
Represents a single form question/screen. The `Type` field holds Typeform type strings like `"multiple_choice"`, `"number"`, `"opinion_scale"`, etc. The same struct is reused for `thankyou_screens`.

### Workspace (line 28-30)
```go
type Workspace struct {
    Href string `json:"href,omitempty"`
}
```

### Form (line 32-38)
```go
type Form struct {
    Workspace       *Workspace      `json:"workspace,omitempty"`
    Title           string          `json:"title"`
    Fields          []*Field        `json:"fields"`
    ThankYouScreens []*Field        `json:"thankyou_screens,omitempty"`
    Logic           json.RawMessage `json:"logic,omitempty"`
}
```
Top-level form structure. `Logic` is kept as raw JSON (not parsed). `ThankYouScreens` use the same `Field` struct.

### Translation-Related Types

```go
type Answer struct {
    Response string  // The key/label the user sends (e.g., "A", "Male", "پ")
    Value    string  // The display text/meaning (e.g., "Jharkhand", "Female")
}

type FieldTranslator struct {
    Translate bool              `json:"translate"`
    Mapping   map[string]string `json:"mapping,omitempty"`
}

type FormTranslator struct {
    Fields map[string]*FieldTranslator `json:"fields"`
}
```

## Key Behaviors

### Field Type Handling
- Only `"multiple_choice"` has a registered translator maker (`translatorMakers` map, line 188)
- All other field types (number, opinion_scale, etc.) get `FieldTranslator{Translate: false, Mapping: nil}` -- they pass through untranslated

### "Shortened" Label Convention
- If the first choice label is `"A"` (line 135), the system assumes labels are single-letter shortcodes (A, B, C, D...) and extracts the actual answer text from the question Title using `ExtractLabels()`
- `ExtractLabels()` parses formatted lists like `"A. Option one\nB. Option two"` with support for various delimiters (`.`, `-`, `)`) and Unicode scripts (Arabic, Devanagari, Bengali digits and letters)
- If labels are NOT shortened (first label != "A"), each choice label IS the answer (Response == Value)

### prepForms Mutation
- `prepForms()` (line 215-218) appends `ThankYouScreens` to `Fields` in-place, mutating the Form structs. This is a side effect to watch out for.

## Files Summary

| File | Purpose |
|------|---------|
| `forms.go` | All type definitions + form translation logic |
| `responses.go` | Single `Translate()` function for applying a FormTranslator to a response |
| `forms_test.go` | Extensive tests for label extraction and translator creation |
| `responses_test.go` | Tests for the Translate function |

## What Typeform Fields Are NOT Captured

The trans package models a minimal subset of the Typeform form schema. Notable omissions:
- `validations` (required, max_length, etc.)
- `properties.labels` (for opinion_scale left/right labels)
- `properties.steps`, `properties.start_at_one` (opinion_scale config)
- `properties.show_button`, `properties.share_icons` (thankyou_screen config)
- `properties.allow_multiple_selection`, `properties.allow_other_choice` (multiple_choice config)
- Welcome screens
- Hidden fields
- Variables
- Settings

These are silently ignored during JSON unmarshaling, which is fine for the translation use case but means this struct cannot round-trip a full Typeform form definition.
