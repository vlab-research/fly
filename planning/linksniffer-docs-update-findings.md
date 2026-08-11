# Linksniffer Documentation Update - Findings

## Summary
Linksniffer documentation is scattered across multiple locations with inconsistent coverage of the protocol support feature. The recent update to support tel:, mailto:, sms:, and other URI schemes is not yet documented in the public documentation.

## Documentation Structure of docs.vlab.digital

### Directory Organization
```
docs.vlab.digital/
├── content/
│   ├── fly/
│   │   ├── _index.md
│   │   ├── core-concepts.md
│   │   ├── reference/
│   │   │   ├── _index.md
│   │   │   ├── questions.md          ← LINKSNIFFER DOCS HERE
│   │   │   ├── creating-a-survey.md
│   │   │   ├── default_response.md
│   │   │   ├── downloading-data.md
│   │   │   ├── hidden.md
│   │   │   ├── incentive_payments.md
│   │   │   ├── messages.md
│   │   │   ├── seeds.md
│   │   │   ├── settings.md
│   │   │   ├── shortcodes.md
│   │   │   ├── testing.md
│   │   │   └── timeouts.md
│   │   └── tutorial/
│   │       ├── _index.md
│   │       ├── incentive_payments.md
│   │       └── simple_survey.md
│   └── vlab/
│       ├── connected-accounts/
│       ├── study-configuration/
│       └── tutorials/
├── config.toml
└── README.md
```

### Website Structure
- **Hugo-based static site generator** using the geekdoc theme
- Organized into two main sections: "Fly" and "VLab"
- Fly section contains reference documentation and tutorials
- Documentation is user-facing and published at https://docs.vlab.digital

## Current Linksniffer Documentation

### Location 1: docs.vlab.digital/content/fly/reference/questions.md
**Status:** PRIMARY DOCUMENTATION LOCATION

This is the main user-facing documentation for linksniffer. It covers:
- Link sending via webview buttons (lines 141-221)
- Using links.vlab.digital for click tracking (lines 156-174)
- Query parameters: `url`, `id`, `pageid` (lines 156-174)
- Basic usage examples with and without tracking (lines 158-193)
- Waiting for link clicks with `linksniffer:click` event (lines 195-220)
- External event wait logic including linksniffer (lines 286-469)

**What's documented:**
- HTTP/HTTPS URL forwarding via links.vlab.digital
- Parameter format: `base`, `params` with `url`, `id`, `pageid`
- Wait conditions: `type: "linksniffer:click"` with optional `url` property
- Complex wait logic with `and`/`or` operators
- Moviehouse integration examples

**What's NOT documented:**
- Support for tel:, mailto:, sms:, and other URI schemes (added Feb 2026)
- How to use non-http protocols in webview buttons
- The `p` (protocol) parameter
- Examples of tel: and mailto: links in practice

### Location 2: fly/documentation/questions.md (Internal)
**Status:** INTERNAL DOCUMENTATION (not published)

Similar to the public docs but less detailed. Includes:
- Basic link tracking setup
- Parameter documentation
- No wait event logic examples

### Location 3: Git History References
- **afbc16d** (Aug 2021): "added documentation for linksniffer" - original documentation added
- **556247d** (Sep 2024): "chore: update linksniffer to include id and pageid" - added id and pageid parameter documentation

### Location 4: Code References
- **linksniffer/server.go** - Implementation of protocol handling
- **replybot/lib/typewheels/machine.test.js** - Test examples using linksniffer:click event

## Linksniffer Implementation Details

### Supported Protocols (from linksniffer/server.go)

The linksniffer service supports ANY URI scheme by handling two protocol types:

1. **Double-colon protocols** (http, https): Format as `protocol://destination`
   - Examples: `https://example.com`, `http://example.com`

2. **Single-colon protocols** (all others): Format as `protocol:destination`
   - Supported: `tel:`, `mailto:`, `sms:`, `whatsapp:`, and any other single-colon URI scheme
   - Examples: `tel:+1234567890`, `mailto:user@example.com`, `sms:+1234567890`

### Query Parameters

The linksniffer service accepts these query parameters:

| Parameter | Required | Purpose | Example |
|-----------|----------|---------|---------|
| `url` | Yes | The destination URL/URI (without protocol prefix) | `example.com/page` or `user@example.com` |
| `p` | No | Protocol scheme (default: "https") | `http`, `https`, `tel`, `mailto`, `sms` |
| `id` | No | User tracking ID | User identifier |
| `pageid` | No | Page/campaign tracking ID | Campaign identifier |

### URL Reconstruction Logic

```go
// If protocol is http or https, use ://
if p == "http" || p == "https" {
    u = p + "://" + u
} else {
    // All other protocols use single colon
    u = p + ":" + u
}
```

## Recommended Documentation Updates

### Priority 1: Update questions.md (REQUIRED)
File: `../docs.vlab.digital/content/fly/reference/questions.md`

Add a new subsection under "## Links" titled "## Using Special URI Schemes (tel, mailto, sms)" with:

1. **Explanation of protocol parameter**
   - Default behavior (assumes https)
   - Using the `p` parameter to specify other protocols
   - Distinction between double-colon (http/https) and single-colon schemes

2. **Complete protocol reference table**
   - Common protocols: http, https, tel, mailto, sms, whatsapp
   - Format differences

3. **Practical examples for each major use case:**
   - Phone numbers: `tel:+1-555-123-4567`
   - Email addresses: `mailto:user@example.com`
   - SMS messages: `sms:+1-555-123-4567`
   - WhatsApp: `whatsapp:+1-555-123-4567`

4. **Code examples showing:**
   - Basic tel: link without tracking
   - Tel: link with id and pageid parameters
   - Mailto: link examples
   - Waiting for a tel: or mailto: link click

5. **Usage guidance:**
   - When/why to use each protocol
   - Browser/device support considerations
   - Tracking behavior (events still sent for tel:/mailto: links)

### Priority 2: Create linksniffer reference page (OPTIONAL)
Create: `../docs.vlab.digital/content/fly/reference/linksniffer.md`

A dedicated linksniffer reference guide covering:
- Service purpose and architecture
- All supported protocols and their uses
- Complete parameter reference
- API response format
- Tracking event format
- Integration with Fly surveys
- Advanced use cases and examples

This would be a more comprehensive reference than embedded in questions.md.

### Priority 3: Update internal documentation
Update: `fly/documentation/questions.md`

Mirror any changes to the public docs for internal consistency.

## Current Documentation Gaps

1. **No mention of tel: protocol support** - Users may not know it's available
2. **No examples of non-HTTP uses** - Webview buttons only shown for regular URLs
3. **Missing protocol parameter documentation** - The `p` parameter exists but isn't documented
4. **No guidance on mailto: vs regular links** - When should developers use mailto: vs opening a page that sends email?
5. **No mention of device/platform support** - Some protocols may not work on all devices/browsers
6. **Event tracking behavior unclear for tel:/mailto:** - Do events get sent? How are they tracked?

## Files That Need Updates

### Public Documentation (docs.vlab.digital repo)
- `content/fly/reference/questions.md` - Main location, update "## Links" section
- Optional: Create new `content/fly/reference/linksniffer.md` for comprehensive reference

### Internal Documentation (fly repo)
- `documentation/questions.md` - Keep in sync with public docs
- `README.md` files in linksniffer/ component - Add protocol support info if exists

## Documentation Style and Format

The existing documentation:
- Uses **Hugo + Markdown** format
- Includes **JSON code examples** with syntax highlighting
- Uses **"weight"** front matter for ordering
- Includes **table of contents** with `{{< toc >}}`
- Cross-references with `{{< ref "..." >}}` notation
- Organized around **user tasks** not technical details
- Includes **practical examples** before advanced usage
- Follows **2-level heading hierarchy** in reference docs

New documentation should follow this same style and format conventions.

## Summary of Findings

- **Primary location**: `docs.vlab.digital/content/fly/reference/questions.md`
- **Current coverage**: HTTP/HTTPS link tracking well documented, special protocols undocumented
- **Gap**: No mention of tel:, mailto:, sms:, or other URI scheme support
- **Action needed**: Add protocol reference, examples, and guidance for non-HTTP links
- **Effort**: Moderate - add 1-2 new subsections with examples to existing documentation
- **Audience**: Survey designers using Fly platform
