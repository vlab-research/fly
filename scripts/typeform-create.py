#!/usr/bin/env python3
"""
typeform-create.py — Create and manage Typeform forms via the API.

QUICK START FOR AI AGENTS
=========================

Prerequisites:
  - Python 3 (stdlib only, no pip install needed)
  - TYPEFORM_TOKEN env var must be set (Typeform personal access token)

Common operations:

  1. CREATE A FORM (inline flags — fastest for simple forms):

     python scripts/typeform-create.py create \
       --title "My Survey" \
       --field "mc:q1:Do you like X?:Yes,No,Maybe" \
       --field "text:q2:Why or why not?" \
       --field "statement:intro:Welcome to the survey!" \
       --hidden userid --hidden surveyid

  2. CREATE A FORM (JSON via stdin — full control):

     python scripts/typeform-create.py create - <<'EOF'
     {
       "title": "My Survey",
       "fields": [
         {"type": "multiple_choice", "ref": "q1",
          "title": "Pick one\n- A. Yes\n- B. No",
          "properties": {"choices": [{"label": "A"}, {"label": "B"}]}},
         {"type": "short_text", "ref": "q2", "title": "Why?"}
       ],
       "hidden": ["userid"]
     }
     EOF

  3. LIST / GET / DELETE:

     python scripts/typeform-create.py list
     python scripts/typeform-create.py get <form-id>
     python scripts/typeform-create.py delete <form-id>

  4. PRINT EXAMPLE JSON (discover the full form schema):

     python scripts/typeform-create.py create --example

OUTPUT: All commands print JSON to stdout. `create` prints:
  {"id": "abc123", "url": "https://form.typeform.com/to/abc123"}

FIELD SPEC FORMAT (for --field flags):
  "TYPE:REF:TITLE" or "TYPE:REF:TITLE:CHOICE1,CHOICE2,..."

  TYPE shortcuts:
    mc        → multiple_choice  (requires choices after 4th colon)
    text      → short_text
    statement → statement
    phone     → phone_number
    number    → number

  For mc fields, choices are auto-labeled A, B, C... and appended to the
  title as "\\n- A. Choice1\\n- B. Choice2". Choice labels in the API
  payload become just {"label": "A"}, {"label": "B"}, etc.

HIDDEN FIELDS: Typeform hidden fields are URL params passed through to
  webhooks/responses. Common ones: userid, surveyid, pageid, startTime.
  Add with --hidden <name> (repeatable).

DEFAULTS APPLIED AUTOMATICALLY:
  - workspace: WA44hg (override with --workspace)
  - thankyou_screens: added if missing
  - validations.required: false on all fields
  - multiple_choice: allow_multiple_selection=false, vertical_alignment=true

ERRORS: Non-zero exit code. Error details printed to stderr.
"""

import sys
import os
import json
import argparse
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional


BASE_URL = "https://api.typeform.com"
DEFAULT_WORKSPACE = "WA44hg"

EXAMPLE_FORM = {
    "title": "Test Survey - Feature X",
    "fields": [
        {
            "type": "multiple_choice",
            "ref": "gender",
            "title": "What is your gender?\n- A. Male\n- B. Female\n- C. Other",
            "properties": {
                "choices": [
                    {"label": "A"},
                    {"label": "B"},
                    {"label": "C"}
                ]
            }
        },
        {
            "type": "short_text",
            "ref": "name",
            "title": "What is your name?"
        },
        {
            "type": "statement",
            "ref": "intro",
            "title": "Welcome to our survey!",
            "properties": {"button_text": "Continue"}
        }
    ],
    "hidden": ["userid", "surveyid"],
    "thankyou_screens": [
        {
            "ref": "default_ending",
            "title": "Thank you for completing this survey!",
            "properties": {"show_button": False, "share_icons": False}
        }
    ]
}


def get_token() -> str:
    """Get Typeform API token from environment."""
    token = os.environ.get("TYPEFORM_TOKEN")
    if not token:
        print("Error: TYPEFORM_TOKEN environment variable not set", file=sys.stderr)
        sys.exit(1)
    return token


def api_request(method: str, endpoint: str, data: Optional[Dict] = None) -> Dict[str, Any]:
    """Make HTTP request to Typeform API."""
    token = get_token()
    url = f"{BASE_URL}{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    body = None
    if data:
        body = json.dumps(data).encode("utf-8")

    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req) as response:
            body = response.read().decode("utf-8")
            if not body:
                return {}
            return json.loads(body)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"Error: HTTP {e.code}", file=sys.stderr)
        print(error_body, file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: {e.reason}", file=sys.stderr)
        sys.exit(1)


def parse_field_spec(spec: str) -> Dict[str, Any]:
    """Parse field specification from --field flag.

    Format: "type:ref:title" or "type:ref:title:choice1,choice2" for multiple_choice
    """
    parts = spec.split(":", 3)
    if len(parts) < 3:
        raise ValueError(f"Invalid field spec: {spec}")

    field_type = parts[0]
    ref = parts[1]
    title = parts[2]
    choices = parts[3] if len(parts) > 3 else None

    type_map = {
        "mc": "multiple_choice",
        "text": "short_text",
        "phone": "phone_number",
        "number": "number",
        "statement": "statement",
    }

    if field_type not in type_map:
        raise ValueError(f"Unknown field type: {field_type}")

    form_type = type_map[field_type]
    field = {"type": form_type, "ref": ref, "title": title}

    # Handle multiple_choice with choices
    if form_type == "multiple_choice" and choices:
        choice_list = [c.strip() for c in choices.split(",")]
        # Generate labeled choices (A, B, C, etc.) and append to title
        labels = [chr(65 + i) for i in range(len(choice_list))]
        title_lines = [title]
        for label, choice in zip(labels, choice_list):
            title_lines.append(f"- {label}. {choice}")
        field["title"] = "\n".join(title_lines)
        field["properties"] = {
            "choices": [{"label": label} for label in labels]
        }

    return field


def apply_defaults(form_data: Dict[str, Any]) -> Dict[str, Any]:
    """Apply default values to form data."""
    # Ensure required fields exist
    if "title" not in form_data:
        form_data["title"] = "Untitled Form"

    if "fields" not in form_data:
        form_data["fields"] = []

    # Add default thank you screen if none exists
    if "thankyou_screens" not in form_data:
        form_data["thankyou_screens"] = [
            {
                "ref": "default_ending",
                "title": "Thank you for completing this survey!",
                "properties": {"show_button": False, "share_icons": False}
            }
        ]

    # Apply field defaults
    for field in form_data.get("fields", []):
        if "validations" not in field:
            field["validations"] = {}
        if "required" not in field["validations"]:
            field["validations"]["required"] = False

        if field.get("type") == "multiple_choice":
            if "properties" not in field:
                field["properties"] = {}
            if "allow_multiple_selection" not in field["properties"]:
                field["properties"]["allow_multiple_selection"] = False
            if "vertical_alignment" not in field["properties"]:
                field["properties"]["vertical_alignment"] = True

    return form_data


def cmd_create(args: argparse.Namespace) -> None:
    """Create a new form."""
    if args.example:
        print(json.dumps(EXAMPLE_FORM, indent=2))
        return

    # Load form data
    if args.form_file == "-":
        form_data = json.loads(sys.stdin.read())
    elif args.form_file:
        with open(args.form_file) as f:
            form_data = json.load(f)
    else:
        form_data = {}

    # Apply inline arguments
    if args.title:
        form_data["title"] = args.title

    if args.field:
        if "fields" not in form_data:
            form_data["fields"] = []
        for field_spec in args.field:
            form_data["fields"].append(parse_field_spec(field_spec))

    if args.hidden:
        form_data["hidden"] = args.hidden

    # Set workspace
    workspace = args.workspace or DEFAULT_WORKSPACE
    form_data["workspace"] = {"href": f"https://api.typeform.com/workspaces/{workspace}"}

    # Apply defaults
    form_data = apply_defaults(form_data)

    # Create form
    result = api_request("POST", "/forms", form_data)

    # Extract relevant fields for output
    output = {
        "id": result.get("id"),
        "url": f"https://form.typeform.com/to/{result.get('id')}"
    }
    print(json.dumps(output))


def cmd_list(args: argparse.Namespace) -> None:
    """List forms in workspace."""
    workspace = args.workspace or DEFAULT_WORKSPACE
    result = api_request("GET", f"/forms?workspace_id={workspace}")
    items = result.get("items", [])
    print(json.dumps(items))


def cmd_get(args: argparse.Namespace) -> None:
    """Get a form by ID."""
    result = api_request("GET", f"/forms/{args.form_id}")
    print(json.dumps(result, indent=2))


def cmd_delete(args: argparse.Namespace) -> None:
    """Delete a form by ID."""
    api_request("DELETE", f"/forms/{args.form_id}")
    output = {"deleted": args.form_id}
    print(json.dumps(output))


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Typeform API utility for creating and managing forms",
        epilog="""
Examples:
  # Create from JSON file
  python scripts/typeform-create.py create form.json

  # Create from stdin
  echo '{"title": "My Form", "fields": [...]}' | python scripts/typeform-create.py create -

  # Create with inline flags
  python scripts/typeform-create.py create \\
    --title "My Test" \\
    --field "mc:gender:What is your gender?:Male,Female,Other" \\
    --field "text:name:What is your name?" \\
    --hidden userid --hidden surveyid

  # List forms
  python scripts/typeform-create.py list

  # Get a form
  python scripts/typeform-create.py get abc123xyz

  # Delete a form
  python scripts/typeform-create.py delete abc123xyz
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", help="Subcommand to run")

    # Create subcommand
    create_parser = subparsers.add_parser("create", help="Create a new form")
    create_parser.add_argument(
        "form_file",
        nargs="?",
        help="JSON file to load form from (use - for stdin)",
    )
    create_parser.add_argument(
        "--title",
        help="Form title",
    )
    create_parser.add_argument(
        "--field",
        action="append",
        help="Add a field (format: type:ref:title or type:ref:title:choice1,choice2)",
    )
    create_parser.add_argument(
        "--hidden",
        action="append",
        help="Add a hidden field",
    )
    create_parser.add_argument(
        "--workspace",
        help=f"Workspace ID (default: {DEFAULT_WORKSPACE})",
    )
    create_parser.add_argument(
        "--example",
        action="store_true",
        help="Print example form JSON and exit",
    )
    create_parser.set_defaults(func=cmd_create)

    # List subcommand
    list_parser = subparsers.add_parser("list", help="List forms in workspace")
    list_parser.add_argument(
        "--workspace",
        help=f"Workspace ID (default: {DEFAULT_WORKSPACE})",
    )
    list_parser.set_defaults(func=cmd_list)

    # Get subcommand
    get_parser = subparsers.add_parser("get", help="Get a form by ID")
    get_parser.add_argument("form_id", help="Form ID")
    get_parser.set_defaults(func=cmd_get)

    # Delete subcommand
    delete_parser = subparsers.add_parser("delete", help="Delete a form by ID")
    delete_parser.add_argument("form_id", help="Form ID")
    delete_parser.set_defaults(func=cmd_delete)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
