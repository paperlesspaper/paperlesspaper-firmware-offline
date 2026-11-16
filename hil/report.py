#!/usr/bin/env python3
"""Builds the test protocol of a HIL run: test results, AI risk analysis and,
for failed tests, an AI root cause analysis.

    python hil/report.py hil_result_epd7.json hil_result_epd13.json --risk-report risk_report.md \
        --output-md hil_test_protocol.md --output-json hil_test_protocol.json >> $GITHUB_STEP_SUMMARY

The inputs are the result files written by `hil.run --results`; their failure
texts are already masked (hil/results.py). The protocol goes to stdout, notes go to stderr.
Exits with 1 if a test failed, no result file was found or the risk analysis blocks.
"""

import argparse
import json
import os
import re
import sys
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
    "test_03": "Galerie: speichern, anzeigen, nächstes Bild",
    "test_04": "USB-Verbindung: Einstellungen und Galerie",
    "test_10": "Web-UI: Verbindung und Geräteanzeige",
    "test_11": "Web-UI: Einstellungen speichern",
    "test_12": "Web-UI: Galerie synchronisieren und anzeigen",
    "test_13": "Web-UI: Firmware-Update",
    "test_14": "USB-Flash ohne Boot-Taste, Start aus app0",
    "test_15": "Web-UI per USB-Kabel: Galerie synchronisieren",
    "test_99": "Cloud-Firmware wiederherstellen",
}

WEB_RESULT = "WEB"  # result of the browser tests against the simulated device (webtest/)

# Areas of the web UI tests: the `# --- area ---` headings of webtest/test_web_ui.py
WEB_AREA_TITLES = {
    "start page": "Startseite",
    "connection": "Verbindung",
    "settings": "Einstellungen",
    "Wi-Fi": "WLAN",
    "gallery": "Galerie",
    "USB link": "Verbindung per USB-Kabel",
    "firmware update": "Firmware-Update und USB",
}
CONSISTENCY_AREA = "Konsistenz Firmware / Web-UI / Tests"
OTHER_AREA = "Weitere"

MAX_AI_DIAGNOSES = 4  # later failures are usually consequences of the first ones


def title_of(test_name):
    return next((title for key, title in TEST_TITLES.items() if test_name.startswith(key)), test_name)


def web_areas():
    """Maps each test function of webtest/ to its area."""
    areas = {}
    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "webtest")
    for filename, area in (("test_web_ui.py", OTHER_AREA), ("test_consistency.py", CONSISTENCY_AREA)):
        try:
            with open(os.path.join(folder, filename), "r", encoding="utf-8") as f:
                lines = f.readlines()
        except OSError:
            continue
        for line in lines:
            if (m := re.match(r"# --- (.+?) -+\s*$", line)):
                area = WEB_AREA_TITLES.get(m.group(1), m.group(1))
            elif (m := re.match(r"def (test_\w+)", line)):
                areas[m.group(1)] = area
    return areas


def read_result(path):
    """Returns (device name, test cases) of a result file."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    cases = []
    for case in data.get("cases", []):
        outcome = case.get("outcome")
        cases.append({
            "name": str(case.get("name", "")),
            "title": title_of(str(case.get("name", ""))),
            "outcome": outcome if outcome in ICONS else "failed",
            "seconds": round(float(case.get("seconds", 0)), 1),
            "details": str(case.get("details", "")),
        })
    return str(data.get("target", "?")).upper(), cases


def load_risk(path):
    if not path or not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        text = f.read().strip()
    return {**extract_risk_summary(text), "text": text} if text else None


def build(targets, risk, fw_version, commit):
    """Returns (markdown, ok). `targets` maps a device name to its test cases."""
    failed = [(name, c) for name, cases in targets.items() for c in cases if c["outcome"] == "failed"]
    # The web UI test runs without hardware: its result alone does not make a run pass.
    hardware = [name for name in targets if name != WEB_RESULT]
    tests_ok = bool(hardware) and not failed and all(targets.values())
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
        label = "Web-UI (simuliertes Gerät)" if name == WEB_RESULT else name
        out.append(f"| **{label}** | {status} | {passed}/{len(cases)} Tests bestanden ({seconds:.0f} s) |")
    if not hardware:
        out.append("| **Hardware-Tests** | ⚪ Nicht ausgeführt | Kein Testergebnis vorhanden: die Hardware-Jobs "
                   "liefen nicht oder brachen vor dem Teststart ab |")
    if risk:
        out.append(f"| **KI-Risikoanalyse** | {risk['rating']} | {risk['recommendation']} |")
    else:
        out.append("| **KI-Risikoanalyse** | ⚪ Nicht verfügbar | Kein Bericht vorhanden |")
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

    diagnoses = [0]  # AI diagnoses written so far; hardware failures come first

    def failures_of(name):
        lines = []
        for case in (c for c in targets[name] if c["outcome"] == "failed"):
            lines += [f"#### ❌ {case['title']}", f"`{case['name']}` · {case['seconds']:.0f} s", ""] if case["title"] != case["name"] else [f"#### ❌ `{case['name']}`", ""]
            excerpt = sanitize(case["details"], max_chars=600) or "Keine Fehlermeldung vorhanden."
            lines += ["```text", excerpt, "```", ""]
            if diagnoses[0] >= MAX_AI_DIAGNOSES:
                continue
            diagnoses[0] += 1
            print(f"KI-Fehlerdiagnose für [{name}] {case['name']}...", file=sys.stderr)
            case["ai_diagnosis"] = analyze_failure(case["name"], name, case["details"])
            if case["ai_diagnosis"]:
                lines += ["**🤖 KI-Fehlerdiagnose**", "", case["ai_diagnosis"], ""]
            else:
                lines += ["*KI-Fehlerdiagnose nicht verfügbar (kein `GEMINI_API_KEY` oder API nicht erreichbar).*", ""]
        return lines

    def case_table(cases):
        lines = ["| Test | Ergebnis | Dauer |", "| :--- | :--- | ---: |"]
        for c in cases:
            test = f"`{c['name']}`" if c["title"] == c["name"] else f"{c['title']} (`{c['name']}`)"
            lines.append(f"| {test} | {ICONS[c['outcome']]} {LABELS[c['outcome']]} | {c['seconds']:.0f} s |")
        return lines + [""]

    out += ["---", "", "## 📺 HIL-Testergebnisse", ""]
    if not hardware:
        out += ["Keine Ergebnisse der Hardware-Tests vorhanden.", ""]
    for name in hardware:
        out += [f"### {name}", ""] + case_table(targets[name]) + failures_of(name)

    if WEB_RESULT in targets:
        cases = targets[WEB_RESULT]
        areas = web_areas()
        grouped = {}
        for c in cases:
            grouped.setdefault(areas.get(c["name"].split("[")[0], OTHER_AREA), []).append(c)
        out += ["---", "", "## 🌐 Web-UI-Tests (simuliertes Gerät)", "", "| Bereich | Ergebnis | Tests | Dauer |", "| :--- | :--- | ---: | ---: |"]
        for area, group in sorted(grouped.items(), key=lambda item: item[0] == CONSISTENCY_AREA):  # browser tests first
            passed = sum(1 for c in group if c["outcome"] == "passed")
            n_failed = sum(1 for c in group if c["outcome"] == "failed")
            status = f"{ICONS['failed']} {n_failed} fehlgeschlagen" if n_failed else f"{ICONS['passed']} bestanden"
            out.append(f"| {area} | {status} | {passed}/{len(group)} | {sum(c['seconds'] for c in group):.0f} s |")
        out.append("")
        out += failures_of(WEB_RESULT)
        out += ["<details>", f"<summary><b>Alle {len(cases)} Web-UI-Tests anzeigen</b></summary>", ""] + case_table(cases) + ["</details>", ""]

    return "\n".join(out), ok


def main():
    parser = argparse.ArgumentParser(description="Erzeugt das HIL-Testprotokoll")
    parser.add_argument("results", nargs="*", help="Ergebnisdateien der Hardware-Tests (hil_result_<gerät>.json)")
    parser.add_argument("--risk-report", help="Bericht der KI-Risikoanalyse (risk_report.md)")
    parser.add_argument("--fw-version", default=os.environ.get("FW_VERSION", "?"))
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA", "HEAD"))
    parser.add_argument("--output-md", help="Protokoll zusätzlich als Markdown-Datei speichern")
    parser.add_argument("--output-json", help="Protokoll zusätzlich als JSON-Datei speichern")
    args = parser.parse_args()

    targets = {}
    for path in args.results:
        if os.path.isfile(path):
            name, cases = read_result(path)
            targets[name] = cases
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
