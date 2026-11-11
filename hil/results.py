"""Turns the JUnit file of a run into the result file that leaves the test PC.

The raw JUnit file never leaves the runner: pytest writes the values of a
failed comparison into it, which can be a device UID or a Bluetooth address,
and GitHub does not mask artifacts the way it masks the job log.

The result file holds test names, outcomes and durations, plus the failure
text after `scrub()`. If a known sensitive value survives scrubbing, the
failure text is dropped altogether.
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from ai_common import SENSITIVE_ENV_KEYWORDS, sanitize  # noqa: E402

MAX_DETAIL_CHARS = 8000
HOST_ENV = ("USERNAME", "USER", "COMPUTERNAME", "HOSTNAME", "USERDOMAIN")
GENERIC_VALUES = {"true", "false", "none", "all", "runner", "admin", "administrator", "user", "test", "system"}
REMOVED = "[Fehlertext entfernt: Maskierung nicht eindeutig]"

_known = set()


def remember(value):
    """Registers a value that must never appear in a result file (UID, address, SSID...)."""
    value = str(value or "").strip()
    if len(value) >= 4:
        _known.add(value)


def _variants(value):
    """The value itself plus the spellings an identifier shows up in (without prefix, with/without separators)."""
    found = {value}
    core = value.split("-", 1)[1] if re.match(r"(?i)epd(7|13)-", value) else value
    compact = re.sub(r"[:\-_]", "", core)
    if re.fullmatch(r"[0-9a-fA-F]{6,}", compact):
        found.add(compact)
        if len(compact) % 2 == 0:
            pairs = [compact[i:i + 2] for i in range(0, len(compact), 2)]
            found.update({":".join(pairs), "-".join(pairs)})
        found.add(compact[-6:])  # BLE names carry the last bytes of the address
    return {v for v in found if len(v) >= 4}


def known_values():
    values = set(_known)
    for name, value in os.environ.items():
        value = value.strip()
        upper = name.upper()
        if len(value) >= 4 and (upper in HOST_ENV or any(k in upper for k in SENSITIVE_ENV_KEYWORDS)):
            if value.lower() not in GENERIC_VALUES:
                values.add(value)
    return {variant for value in values for variant in _variants(value)}


def scrub(text):
    """Masks everything that identifies a device, a network or the test PC."""
    if not text:
        return ""
    text = str(text)
    known = sorted(known_values(), key=len, reverse=True)
    for value in known:
        text = re.sub(re.escape(value), "[REDACTED]", text, flags=re.IGNORECASE)

    text = sanitize(text)  # secrets, tokens, MAC addresses, UIDs, device names, user paths
    text = re.sub(r"\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{10,}\b", "[HEX]", text)  # any other long identifier
    text = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[IP]", text)
    # Network names, also those of neighbours in a scan result: quoted value or the rest of the line
    text = re.sub(r"(?i)(ssid\w*[\"']?\s*[:=]\s*)(\"[^\"\n]*\"|'[^'\n]*'|[^\n,}]+)", r"\1[REDACTED_SSID]", text)

    if len(text) > MAX_DETAIL_CHARS:
        head = MAX_DETAIL_CHARS // 3
        text = text[:head] + "\n[... gekürzt ...]\n" + text[-(MAX_DETAIL_CHARS - head):]

    lowered = text.lower()
    if any(value.lower() in lowered for value in known):
        return REMOVED
    return text


def read_junit(path):
    cases = []
    for case in ET.parse(path).getroot().iter("testcase"):
        problem = case.find("failure")
        if problem is None:
            problem = case.find("error")
        if problem is not None:
            outcome = "failed"
            details = scrub(f"{problem.get('message', '')}\n{problem.text or ''}".strip())
        elif case.find("skipped") is not None:
            outcome, details = "skipped", ""
        else:
            outcome, details = "passed", ""
        cases.append({
            "name": case.get("name", ""),
            "outcome": outcome,
            "seconds": round(float(case.get("time", 0)), 1),
            "details": details,
        })
    return cases


def write_results(junit_path, out_path, target_name):
    """Writes the result file for the upload. Returns the number of test cases."""
    cases = read_junit(junit_path) if os.path.isfile(junit_path) else []
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"target": target_name.upper(), "cases": cases}, f, indent=2, ensure_ascii=False)
    return len(cases)
