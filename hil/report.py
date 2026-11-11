#!/usr/bin/env python3
"""Builds the test protocol of a HIL run: test results, AI risk analysis and,
for failed tests, an AI root cause analysis.

    python hil/report.py junit_epd7.xml junit_epd13.xml --risk-report risk_report.md \
        --output-md hil_test_protocol.md --output-json hil_test_protocol.json >> $GITHUB_STEP_SUMMARY

The protocol goes to stdout, notes go to stderr.
Exits with 1 if a test failed, no result file was found or the risk analysis blocks.
"""

import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from ai_common import sanitize  # noqa: E402
from ai_failure_analysis import analyze_failure  # noqa: E402
from ai_risk_analysis import extract_risk_summary  # noqa: E402

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

ICONS = {"passed": "✅", "failed": "❌", "skipped": "⚪"}
LABELS = {"passed": "bestanden", "failed": "fehlgeschlagen", "skipped": "übersprungen"}

TEST_TITLES = {
    "test_00": "Kandidaten-Firmware per BLE installieren",
    "test_01": "Werksreset (5x Taster)",
    "test_02": "BLE-Schnittstelle (GATT)",
    "test_99": "Cloud-Firmware wiederherstellen",
}

MAX_AI_DIAGNOSES = 4  # later failures are usually consequences of the first ones


def title_of(test_name):
    return next((title for key, title in TEST_TITLES.items() if test_name.startswith(key)), test_name)


def read_cases(path):
    cases = []
    for case in ET.parse(path).getroot().iter("testcase"):
        problem = case.find("failure")
        if problem is None:
            problem = case.find("error")
        if problem is not None:
            outcome = "failed"
            details = f"{problem.get('message', '')}\n{problem.text or ''}".strip()
        elif case.find("skipped") is not None:
            outcome, details = "skipped", ""
        else:
            outcome, details = "passed", ""
        cases.append({
            "name": case.get("name"),
            "title": title_of(case.get("name", "")),
            "outcome": outcome,
            "seconds": round(float(case.get("time", 0)), 1),
            "details": details,
        })
    return cases


def load_risk(path):
    if not path or not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        text = f.read().strip()
    return {**extract_risk_summary(text), "text": text} if text else None


def build(targets, risk, fw_version, commit):
    """Returns (markdown, ok). `targets` maps a device name to its test cases."""
    failed = [(name, c) for name, cases in targets.items() for c in cases if c["outcome"] == "failed"]
    tests_ok = bool(targets) and not failed and all(targets.values())
    blocked = bool(risk and risk["blocked"])
    ok = tests_ok and not blocked

    if not ok:
        verdict = "❌ **NICHT BESTANDEN**"
    elif risk and "MITTEL" in risk["rating"]:
        verdict = "⚠️ **BESTANDEN, MANUELLE PRÜFUNG EMPFOHLEN**"
    else:
        verdict = "✅ **BESTANDEN**"

    out = [
        "# 🔬 HIL-Testprotokoll Offline-Firmware",
        "",
        f"**Firmware-Version:** `{fw_version}` | **Commit:** `{commit[:7]}` | "
        f"**Zeitstempel:** `{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC`",
        "",
        f"### Gesamtstatus: {verdict}",
        "",
        "| Komponente | Status | Details |",
        "| :--- | :--- | :--- |",
    ]
    for name, cases in targets.items():
        passed = sum(1 for c in cases if c["outcome"] == "passed")
        n_failed = sum(1 for c in cases if c["outcome"] == "failed")
        seconds = sum(c["seconds"] for c in cases)
        status = "❌ Fehlgeschlagen" if n_failed or not cases else "✅ Bestanden"
        out.append(f"| **{name}** | {status} | {passed}/{len(cases)} Tests bestanden ({seconds:.0f} s) |")
    if not targets:
        out.append("| **Hardware-Tests** | ⚪ Nicht ausgeführt | Kein Testergebnis vorhanden: die Hardware-Jobs "
                   "liefen nicht oder brachen vor dem Teststart ab |")
    if risk:
        out.append(f"| **KI-Risikoanalyse** | {risk['rating']} | {risk['recommendation']} |")
    else:
        out.append("| **KI-Risikoanalyse** | ⚪ Nicht verfügbar | Kein Bericht vorhanden |")
    out.append("")

    if failed:
        out += ["---", "", "## 🚨 Fehlgeschlagene Tests", ""]
        for index, (name, case) in enumerate(failed):
            out += [f"### ❌ [{name}] {case['title']}", f"`{case['name']}` · {case['seconds']:.0f} s", ""]
            excerpt = sanitize(case["details"], max_chars=600) or "Keine Fehlermeldung vorhanden."
            out += ["```text", excerpt, "```", ""]
            if index < MAX_AI_DIAGNOSES:
                print(f"KI-Fehlerdiagnose für [{name}] {case['name']}...", file=sys.stderr)
                case["ai_diagnosis"] = analyze_failure(case["name"], name, case["details"])
            if case.get("ai_diagnosis"):
                out += ["**🤖 KI-Fehlerdiagnose**", "", case["ai_diagnosis"], ""]
            elif index < MAX_AI_DIAGNOSES:
                out += ["*KI-Fehlerdiagnose nicht verfügbar (kein `GEMINI_API_KEY` oder API nicht erreichbar).*", ""]

    for name, cases in targets.items():
        out += ["---", "", f"## 📺 Detailergebnisse: {name}", "", "| Test | Ergebnis | Dauer |", "| :--- | :--- | ---: |"]
        for c in cases:
            out.append(f"| {c['title']} (`{c['name']}`) | {ICONS[c['outcome']]} {LABELS[c['outcome']]} | {c['seconds']:.0f} s |")
        out.append("")

    if risk:
        out += [
            "---",
            "",
            "## 🛡️ KI-Risikoanalyse der Änderungen",
            "",
            f"- **Gesamtbewertung:** {risk['rating']}",
            f"- **Empfehlung:** {risk['recommendation']}",
            "",
        ]
        if risk["diff_summary"]:
            out += ["**Kernaussage zu den Code-Änderungen:**", "", risk["diff_summary"], ""]
        out += ["<details>", "<summary><b>Vollständigen Bericht anzeigen</b></summary>", "", risk["text"], "", "</details>", ""]

    return "\n".join(out), ok


def main():
    parser = argparse.ArgumentParser(description="Erzeugt das HIL-Testprotokoll")
    parser.add_argument("junit", nargs="*", help="JUnit-Dateien der Hardware-Tests (junit_<gerät>.xml)")
    parser.add_argument("--risk-report", help="Bericht der KI-Risikoanalyse (risk_report.md)")
    parser.add_argument("--fw-version", default=os.environ.get("FW_VERSION", "?"))
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA", "HEAD"))
    parser.add_argument("--output-md", help="Protokoll zusätzlich als Markdown-Datei speichern")
    parser.add_argument("--output-json", help="Protokoll zusätzlich als JSON-Datei speichern")
    args = parser.parse_args()

    targets = {}
    for path in args.junit:
        if os.path.isfile(path):
            name = os.path.splitext(os.path.basename(path))[0].replace("junit_", "").upper()
            targets[name] = read_cases(path)
    risk = load_risk(args.risk_report)

    markdown, ok = build(targets, risk, args.fw_version, args.commit)
    print(markdown)

    if args.output_md:
        with open(args.output_md, "w", encoding="utf-8") as f:
            f.write(markdown + "\n")
    if args.output_json:
        for cases in targets.values():
            for case in cases:
                case["details"] = sanitize(case["details"], max_chars=4000)
        with open(args.output_json, "w", encoding="utf-8") as f:
            json.dump({
                "version": args.fw_version,
                "commit": args.commit,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "risk_analysis": {k: risk[k] for k in ("rating", "recommendation", "blocked")} if risk else None,
                "targets": targets,
                "overall_success": ok,
            }, f, indent=2, ensure_ascii=False)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
