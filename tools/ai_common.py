"""Shared helpers for the AI steps of the pipeline: masking of sensitive text and the Gemini call.

Only the standard library is used, so the scripts run without `pip install`.
Everything sent to the API passes through `sanitize()` first.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

DEFAULT_MODEL = "gemini-3.8-flash"
FALLBACK_MODELS = ("gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest")

# Environment variables whose values must never leave the runner
SENSITIVE_ENV_KEYWORDS = ("SECRET", "KEY", "PASS", "TOKEN", "CREDENTIAL", "AUTH", "SSID")
HARMLESS_VALUES = {"true", "false", "none", "all"}

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def load_env_file():
    """Reads KEY=VALUE pairs from a local .env file (for runs outside of GitHub Actions)."""
    values = {}
    try:
        with open(os.path.join(REPO_ROOT, ".env"), "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
    except OSError:
        pass
    return values


def get_api_key():
    key = os.environ.get("GEMINI_API_KEY") or load_env_file().get("GEMINI_API_KEY")
    if key:
        print(f"::add-mask::{key}")
    return key


def sanitize(text, max_chars=None):
    """Masks secrets, device identities and user paths in `text`."""
    if not text:
        return ""
    text = str(text)

    secrets = set()
    for name, value in os.environ.items():
        value = value.strip()
        if any(k in name.upper() for k in SENSITIVE_ENV_KEYWORDS) and len(value) >= 5 and value.lower() not in HARMLESS_VALUES:
            secrets.add(value)
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, "[REDACTED_SECRET]")

    text = re.sub(r"-----BEGIN [A-Z ]+-----[^-]+-----END [A-Z ]+-----", "[REDACTED_CERTIFICATE]", text)
    text = re.sub(r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED_AWS_KEY]", text)
    text = re.sub(r"\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b", "[REDACTED_JWT]", text)
    text = re.sub(r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]+=*", "Bearer [REDACTED_TOKEN]", text)
    text = re.sub(r"(https?://)([^:/\s]+):([^@/\s]+)@", r"\1[REDACTED_USER]:[REDACTED_PASS]@", text)
    text = re.sub(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b", "[REDACTED_MAC]", text)
    text = re.sub(r"\bepd(?:7|13)-[0-9a-fA-F]{6,}\b", "[REDACTED_UID]", text)
    text = re.sub(r"\b(?:EPD7|EPD13)_[0-9A-Fa-f]{4,}\b", "[REDACTED_DEVICE]", text)
    text = re.sub(r"[A-Za-z]:\\[Uu]sers\\[^\\\s]+\\", r"<home>\\", text)
    text = re.sub(r"/(?:home|Users)/[^/\s]+/", "<home>/", text)
    text = re.sub(
        r'(?i)\b(password|passwort|passwd|secret|token|api_?key)\b(\s*[:=]\s*)(["\'])[^"\'\n]+\3',
        r"\1\2\3[REDACTED]\3",
        text,
    )

    if max_chars and len(text) > max_chars:
        text = text[:max_chars] + "\n\n[... gekürzt ...]"
    return text


def call_gemini(system_prompt, user_prompt, api_key, max_output_tokens=4096, timeout=90):
    """Returns (answer, model). Tries the configured model first, then the fallbacks."""
    payload = json.dumps({
        "contents": [{"parts": [{"text": system_prompt}, {"text": user_prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_output_tokens},
    }).encode("utf-8")

    models = [os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL]
    models += [m for m in FALLBACK_MODELS if m not in models]

    last_error = None
    for model in models:
        request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=payload,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
            parts = data["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts).strip()
            if text:
                return text, model
            last_error = f"{model}: leere Antwort"
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")[:300]
            last_error = f"{model}: HTTP {e.code} {body}"
            if e.code not in (404, 429, 500, 502, 503, 504):
                break  # e.g. invalid key: another model will not help
            print(f"⚠️ Modell '{model}' meldet HTTP {e.code}, versuche das nächste Modell...")
            time.sleep(1)
        except Exception as e:  # network error, timeout, unexpected response format
            last_error = f"{model}: {e}"

    raise RuntimeError(f"Gemini API nicht nutzbar ({last_error})")
