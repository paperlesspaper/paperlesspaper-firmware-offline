#!/usr/bin/env python3
"""Turns the JUnit files of a HIL run into a Markdown summary.

    python -m hil.report junit_epd7.xml junit_epd13.xml >> $GITHUB_STEP_SUMMARY

Exits with 1 if a test failed or no result file was found.
"""

import os
import sys
import xml.etree.ElementTree as ET

ICONS = {"passed": "✅", "failed": "❌", "skipped": "⚪"}


def read_cases(path):
    cases = []
    for case in ET.parse(path).getroot().iter("testcase"):
        if case.find("failure") is not None or case.find("error") is not None:
            outcome = "failed"
        elif case.find("skipped") is not None:
            outcome = "skipped"
        else:
            outcome = "passed"
        cases.append((case.get("name"), outcome, float(case.get("time", 0))))
    return cases


def main(paths):
    print("## Offline firmware HIL test\n")
    found = [p for p in paths if os.path.isfile(p)]
    ok = bool(found)
    if not found:
        print("No test results found. The hardware jobs did not run or aborted before the tests started.")
    for path in found:
        cases = read_cases(path)
        failed = sum(1 for _, outcome, _ in cases if outcome == "failed")
        ok = ok and failed == 0 and bool(cases)
        name = os.path.splitext(os.path.basename(path))[0].replace("junit_", "").upper()
        print(f"### {name}: {'passed' if failed == 0 and cases else 'FAILED'}\n")
        print("| Test | Result | Duration |")
        print("| :--- | :--- | ---: |")
        for test, outcome, seconds in cases:
            print(f"| `{test}` | {ICONS[outcome]} {outcome} | {seconds:.0f} s |")
        print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
