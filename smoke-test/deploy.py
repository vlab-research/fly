#!/usr/bin/env python3
"""
Fly Smoke Test — Typeform form deployer.

Manages the Fly smoke test survey forms on Typeform.
Reads form JSON from form-a.json and form-b.json.
Saves form IDs to .ids for updates.

Usage:
  python deploy.py create [form-a|form-b|both]
  python deploy.py update [form-a|form-b|both]
  python deploy.py delete [form-a|form-b|both]
  python deploy.py status
  python deploy.py refs [form-a|form-b]

Environment:
  TYPEFORM_TOKEN — Typeform personal access token (read from .env if present)
"""

import sys
import os
import json
import argparse
import urllib.request
import urllib.error

BASE_URL = "https://api.typeform.com"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
IDS_FILE = os.path.join(SCRIPT_DIR, ".ids")
ENV_FILE = os.path.join(SCRIPT_DIR, ".env")
FORM_A_FILE = os.path.join(SCRIPT_DIR, "form-a.json")
FORM_B_FILE = os.path.join(SCRIPT_DIR, "form-b.json")


def load_env():
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip())


def get_token():
    token = os.environ.get("TYPEFORM_TOKEN")
    if not token:
        print("Error: TYPEFORM_TOKEN not set. Add it to .env or export it.", file=sys.stderr)
        sys.exit(1)
    return token


def api_request(method, endpoint, data=None):
    token = get_token()
    url = f"{BASE_URL}{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            resp_body = response.read().decode("utf-8")
            if not resp_body:
                return {}
            return json.loads(resp_body)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"HTTP {e.code}: {error_body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"URL Error: {e.reason}", file=sys.stderr)
        sys.exit(1)


def load_ids():
    if os.path.exists(IDS_FILE):
        with open(IDS_FILE) as f:
            return json.load(f)
    return {}


def save_ids(ids):
    with open(IDS_FILE, "w") as f:
        json.dump(ids, f, indent=2)


def load_form(form_file):
    with open(form_file) as f:
        return json.load(f)


def resolve_target(target):
    if target == "both":
        return [("form_a", FORM_A_FILE), ("form_b", FORM_B_FILE)]
    elif target == "form-a":
        return [("form_a", FORM_A_FILE)]
    elif target == "form-b":
        return [("form_b", FORM_B_FILE)]
    else:
        print(f"Unknown target: {target}. Use form-a, form-b, or both.", file=sys.stderr)
        sys.exit(1)


def cmd_create(args):
    ids = load_ids()
    targets = resolve_target(args.target)
    for key, form_file in targets:
        if key in ids:
            print(f"{key} already exists (id: {ids[key]}). Use 'update' or 'delete' first.")
            continue
        form_data = load_form(form_file)
        result = api_request("POST", "/forms", form_data)
        form_id = result.get("id")
        ids[key] = form_id
        save_ids(ids)
        print(f"{key}: created id={form_id} url=https://form.typeform.com/to/{form_id}")

    print("\nNext steps:")
    print("  1. Run 'python deploy.py refs' to verify choice refs (needed for logic jumps)")
    print("  2. Import both forms into Fly dashboard with shortcodes: flysmoke, flysmokeb")
    print("  3. Test via m.me link: m.me/<PAGE>?ref=form.flysmoke")


def cmd_update(args):
    ids = load_ids()
    targets = resolve_target(args.target)
    for key, form_file in targets:
        if key not in ids:
            print(f"{key} has no saved ID. Use 'create' first.")
            continue
        form_id = ids[key]
        form_data = load_form(form_file)
        del form_data["workspace"]
        result = api_request("PUT", f"/forms/{form_id}", form_data)
        print(f"{key}: updated id={form_id}")


def cmd_delete(args):
    ids = load_ids()
    targets = resolve_target(args.target)
    for key, _ in targets:
        if key not in ids:
            print(f"{key} has no saved ID.")
            continue
        form_id = ids[key]
        api_request("DELETE", f"/forms/{form_id}")
        del ids[key]
        print(f"{key}: deleted id={form_id}")
    save_ids(ids)


def cmd_status(args):
    ids = load_ids()
    if not ids:
        print("No forms created yet. Run 'python deploy.py create' first.")
        return
    for key, form_id in ids.items():
        result = api_request("GET", f"/forms/{form_id}")
        title = result.get("title", "?")
        field_count = len(result.get("fields", []))
        hidden = result.get("hidden", [])
        logic_count = len(result.get("logic", []))
        print(f"{key}:")
        print(f"  id:       {form_id}")
        print(f"  url:      https://form.typeform.com/to/{form_id}")
        print(f"  title:    {title}")
        print(f"  fields:   {field_count}")
        print(f"  hidden:   {hidden}")
        print(f"  logic:    {logic_count} rules")
        print()


def cmd_refs(args):
    ids = load_ids()
    target_key = args.target if args.target in ("form-a", "form-b") else None
    if not target_key:
        keys_to_check = list(ids.keys())
    else:
        key_map = {"form-a": "form_a", "form-b": "form_b"}
        keys_to_check = [key_map[target_key]]

    for key in keys_to_check:
        if key not in ids:
            print(f"{key} has no saved ID.")
            continue
        form_id = ids[key]
        result = api_request("GET", f"/forms/{form_id}")
        print(f"{key} (id: {form_id}):")
        print()
        for field in result.get("fields", []):
            ftype = field.get("type", "?")
            ref = field.get("ref", "?")
            title = field.get("title", "?")[:60]
            print(f"  [{ftype}] ref=\"{ref}\" title=\"{title}\"")
            if "properties" in field and "choices" in field["properties"]:
                for choice in field["properties"]["choices"]:
                    cid = choice.get("id", "?")
                    cref = choice.get("ref", "?")
                    clabel = choice.get("label", "?")
                    print(f"    choice: id={cid} ref=\"{cref}\" label=\"{clabel}\"")
            if "properties" in field and "description" in field["properties"]:
                desc = field["properties"]["description"][:80]
                print(f"    description: \"{desc}\"")
        print()

    print("IMPORTANT: Check that choice refs match the logic jump targets.")
    print("If Typeform reassigned choice refs, update form-a.json and run 'python deploy.py update'.")


def main():
    load_env()

    parser = argparse.ArgumentParser(description="Fly Smoke Test — Typeform form deployer")
    subparsers = parser.add_subparsers(dest="command", help="Command")

    for name, help_text in [("create", "Create forms on Typeform"),
                            ("update", "Update existing forms"),
                            ("delete", "Delete forms from Typeform")]:
        p = subparsers.add_parser(name, help=help_text)
        p.add_argument("target", nargs="?", default="both",
                       choices=["form-a", "form-b", "both"],
                       help="Which form(s) to target (default: both)")

    subparsers.add_parser("status", help="Show form IDs, URLs, and info")

    refs_parser = subparsers.add_parser("refs", help="Show field refs and choice refs (for debugging logic)")
    refs_parser.add_argument("target", nargs="?", default="both",
                             choices=["form-a", "form-b", "both"],
                             help="Which form to inspect (default: both)")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    {"create": cmd_create, "update": cmd_update, "delete": cmd_delete,
     "status": cmd_status, "refs": cmd_refs}[args.command](args)


if __name__ == "__main__":
    main()
