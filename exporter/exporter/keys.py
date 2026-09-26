"""Object keys for export artifacts.

`survey_name` is unique per owner, not globally, so every key is namespaced by
an opaque digest of the owner's email. The email itself stays out of the key
because keys surface in presigned URLs, bucket listings and logs.

Every key must start with EXPORTS_PREFIX: the bucket's expiry rule
(storage.S3StorageBackend._ensure_lifecycle) matches on it, and a key outside
it is never cleaned up.

dashboard-server/api/exports/exports.keys.js recomputes owner_prefix to refuse
links that are not under the caller's own prefix; the two must agree.
"""

import hashlib
from datetime import datetime
from typing import Optional

EXPORTS_PREFIX = "exports/"
OWNER_PREFIX_LENGTH = 16


def owner_prefix(user: str) -> str:
    return hashlib.sha256(user.encode("utf-8")).hexdigest()[:OWNER_PREFIX_LENGTH]


def export_key(user: str, survey: str, artifact: str = "") -> str:
    return f"{EXPORTS_PREFIX}{owner_prefix(user)}/{survey}{artifact}.csv"


def responses_key(user: str, survey: str) -> str:
    return export_key(user, survey)


def chat_log_key(user: str, survey: str) -> str:
    return export_key(user, survey, "_chat_log")


def _stamp(dt: Optional[datetime]) -> str:
    return dt.strftime("%Y%m%dT%H%M%SZ") if dt else "open"


def full_messages_key(
    user: str,
    survey: str,
    start_time: Optional[datetime] = None,
    end_time: Optional[datetime] = None,
) -> str:
    suffix = ""
    if start_time or end_time:
        suffix = f"_{_stamp(start_time)}_to_{_stamp(end_time)}"
    return export_key(user, survey, f"_full_messages{suffix}")
