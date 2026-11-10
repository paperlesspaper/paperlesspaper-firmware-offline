#!/usr/bin/env python3
"""CLI for the offline firmware HIL tests.

    python -m hil.run --target epd7 -v
    python -m hil.run --target epd13 --candidate-bin .pio/build/epd13/firmware.bin
"""

import argparse
import os
import sys

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Offline firmware HIL tests")
    parser.add_argument("--target", choices=["epd7", "epd13"], required=True)
    parser.add_argument("--candidate-bin", help="Firmware to test (default: .pio/build/<target>/firmware.bin)")
    parser.add_argument("--candidate-version", help="Version the candidate must report in its boot log")
    parser.add_argument("--force-verify", action="store_true", help="Re-detect ports and relays, ignore the cached mapping")
    parser.add_argument("--junitxml")
    parser.add_argument("-k", dest="keyword", help="pytest -k expression")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    if args.candidate_bin:
        os.environ[f"OFFLINE_CANDIDATE_{args.target.upper()}"] = os.path.abspath(args.candidate_bin)
    if args.candidate_version:
        os.environ["OFFLINE_CANDIDATE_VERSION"] = args.candidate_version

    import pytest

    from . import settings
    from .cloud import ESP32HardwareController, HardwareSetupError
    from .lock import hardware_lock

    target = settings.TARGETS[args.target]

    # Port/relay assignment is the cloud testbench's job; it also works with the
    # offline firmware, which prints the same UID and version lines at boot.
    with hardware_lock():
        try:
            ESP32HardwareController.verify_and_pair_hardware(
                required_targets=[args.target], use_cached_first=not args.force_verify
            )
        except HardwareSetupError as e:
            print(f"\n{e}\n❌ Aborted: hardware setup incomplete.")
            sys.exit(1)

    pytest_args = [os.path.dirname(__file__), "-s", "-p", "no:cacheprovider", f"--target={args.target}"]
    if args.verbose:
        pytest_args.append("-v")
    if args.keyword:
        pytest_args += ["-k", args.keyword]
    if args.junitxml:
        pytest_args.append(f"--junitxml={args.junitxml}")

    try:
        exit_code = pytest.main(pytest_args)
    finally:
        for relay in (target.relay_port, target.other_relay_port):
            if relay:
                ESP32HardwareController.set_relay_power(relay, power_on=False)

    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(int(exit_code))  # bleak/pyserial threads can keep the process alive on Windows


if __name__ == "__main__":
    main()
