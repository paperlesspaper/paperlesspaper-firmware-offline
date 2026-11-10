"""Control of one test device running the offline (or cloud) firmware.

The relay cuts the supply, so every power cycle looks like a press of the
reset button to the firmware:
  1 press            -> setup mode (BLE advertising)
  2 quick presses    -> skip setup mode, force download
  5 quick presses    -> factory reset
"Quick" means the next press comes before the firmware clears its press
counter, 3 s after boot.
"""

import re
import time
from dataclasses import dataclass

from . import settings
from .cloud import ESP32HardwareController, mask_uid, register_github_mask, sanitize_log_line

VERSION_RE = re.compile(r"\[MAIN\] INIT Device V:\s*(\S+)")
UID_RE = re.compile(r"\[MAIN\] UID:\s*(\S+)")
COUNTER_RE = re.compile(r"\[MAIN\] Current counter value:\s*(\d+)")
OFFLINE_MARKERS = ("[MAIN] FW: offline", "[MAIN] Setup Mode Triggered", "[MAIN] skip setup Mode")

CRASH_PATTERNS = (
    "Guru Meditation",
    "Backtrace:",
    "abort() was called",
    "assert failed",
    "Stack canary",
    "[MAIN] Timeout Failsafe",
)


@dataclass
class BootInfo:
    firmware: str  # "offline" or "cloud"
    version: str
    uid: str
    counter: int | None


class _Controller(ESP32HardwareController):
    """Cloud controller that keeps cleared log lines, so a crash is still found later."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.archive = []

    def clear_logs(self):
        with self._lock:
            self.archive.extend(self.log_history)
            self.log_history.clear()
            self._new_line_event.clear()

    def all_logs(self):
        with self._lock:
            return self.archive + list(self.log_history)


class OfflineDevice:
    def __init__(self, target):
        self.target = target
        self.ctrl = _Controller(target.port, name=target.name.upper(), relay_port=target.relay_port)
        self.uid = target.device_id
        self._last_power_on = 0.0

    # --- connection -------------------------------------------------------

    def open(self):
        """Powers only this device and opens its serial port."""
        if self.target.other_relay_port:
            ESP32HardwareController.set_relay_power(self.target.other_relay_port, power_on=False)
        ESP32HardwareController.set_relay_power(self.target.relay_port, power_on=True)
        self._last_power_on = time.time()
        self.ctrl.connect(retries=20, retry_delay=0.5)

    def close(self):
        self.ctrl.disconnect()
        ESP32HardwareController.set_relay_power(self.target.relay_port, power_on=False)

    # --- logs -------------------------------------------------------------

    def wait_for(self, pattern, timeout, from_current=False):
        return self.ctrl.wait_for_pattern(pattern, timeout=timeout, from_current=from_current)

    def log_position(self):
        return len(self.ctrl.all_logs())

    def logs_since(self, position):
        return self.ctrl.all_logs()[position:]

    def crash_lines_since(self, position):
        return [
            sanitize_log_line(line)
            for line in self.logs_since(position)
            if any(p in line for p in CRASH_PATTERNS)
        ]

    def _wait_until(self, predicate, timeout, poll=0.1):
        end = time.time() + timeout
        while time.time() < end:
            if predicate(self.ctrl.get_logs()):
                return True
            time.sleep(poll)
        return predicate(self.ctrl.get_logs())

    # --- power gestures ---------------------------------------------------

    def _let_press_counter_expire(self):
        """Waits until the firmware has cleared its press counter of the last boot."""
        remaining = settings.STARTUP_COUNTER_WINDOW + 0.8 - (time.time() - self._last_power_on)
        if remaining > 0:
            time.sleep(remaining)

    def _power_cycle(self):
        self.ctrl.clear_logs()
        ESP32HardwareController.set_relay_power(self.target.relay_port, power_on=False)
        time.sleep(self.target.relay_off_seconds)
        ESP32HardwareController.set_relay_power(self.target.relay_port, power_on=True)
        self._last_power_on = time.time()
        if not (self.ctrl._running and self.ctrl.ser and self.ctrl.ser.is_open):
            try:
                self.ctrl.connect(retries=12, retry_delay=0.25)
            except ConnectionError:
                pass  # the reader thread keeps retrying

    def press(self, count=1):
        """Simulates `count` quick presses of the reset button; power stays on afterwards."""
        self._let_press_counter_expire()
        for i in range(count):
            self._power_cycle()
            if i == count - 1:
                break
            # Stay on long enough for the counter to be stored (it is written right
            # at boot), but cut power well before it is cleared again.
            start = time.time()
            self._wait_until(lambda logs: any(COUNTER_RE.search(l) for l in logs), timeout=2.2)
            elapsed = time.time() - start
            if elapsed < 1.2:
                time.sleep(1.2 - elapsed)

    # --- identification ---------------------------------------------------

    def _boot_lines(self, since):
        """Log lines of the most recent boot after log position `since`."""
        lines = self.logs_since(since)
        starts = [i for i, l in enumerate(lines) if VERSION_RE.search(l)]
        return lines[starts[-1]:] if starts else []

    def read_boot_info(self, since, timeout=None):
        """Reads firmware type, version and UID from the boot log written after position `since`."""
        timeout = settings.BOOT_TIMEOUT if timeout is None else timeout
        end = time.time() + timeout
        while time.time() < end and not any(UID_RE.search(l) for l in self._boot_lines(since)):
            time.sleep(0.2)
        # The lines that tell an old offline build from the cloud firmware follow the UID.
        end = time.time() + 3.0
        while time.time() < end and not any(m in l for l in self._boot_lines(since) for m in OFFLINE_MARKERS):
            time.sleep(0.2)

        version = uid = counter = None
        offline = False
        for line in self._boot_lines(since):
            if (m := VERSION_RE.search(line)):
                version = m.group(1)
            if (m := UID_RE.search(line)):
                uid = m.group(1)
            if (m := COUNTER_RE.search(line)):
                counter = int(m.group(1))
            if any(marker in line for marker in OFFLINE_MARKERS):
                offline = True

        if not version or not uid:
            tail = "\n".join(sanitize_log_line(l) for l in self.logs_since(since)[-15:]) or "<no log output>"
            raise RuntimeError(f"[{self.target.name}] Device did not print a boot log within {timeout}s:\n{tail}")
        if not uid.lower().startswith(f"{self.target.name}-"):
            raise RuntimeError(
                f"[{self.target.name}] Wrong device on {self.target.port}: UID starts with '{uid.split('-')[0]}-'."
            )

        self.uid = uid
        register_github_mask(uid)
        info = BootInfo("offline" if offline else "cloud", version, uid, counter)
        print(f"🔎 [{self.target.name}] Firmware: {info.firmware} V{info.version} (UID {mask_uid(info.uid)})")
        return info

    def identify(self):
        """Restarts the device once and reports which firmware it runs."""
        since = self.log_position()
        self.press(1)
        return self.read_boot_info(since)

    def wait_for_reboot(self, since, timeout=60):
        """Reads the boot log of a boot the device starts on its own (after OTA or reset).

        `since` is a log position taken before the reboot was triggered.
        """
        return self.read_boot_info(since, timeout=timeout)

    # --- offline firmware -------------------------------------------------

    def enter_setup_mode(self):
        """Offline firmware: one button press, then waits for BLE advertising."""
        for attempt in (1, 2):
            self.press(1)
            try:
                self.wait_for(r"\[BLE\] BLE Advertising started", timeout=settings.BLE_READY_TIMEOUT)
                return
            except TimeoutError:
                if attempt == 2:
                    raise
                print(f"ℹ️ [{self.target.name}] Setup mode not reached, pressing again...")

    def factory_reset_offline(self):
        """Offline firmware: five quick presses; the firmware resets itself 3 s after the fifth boot."""
        print(f"🏭 [{self.target.name}] Factory reset with {settings.FACTORY_RESET_PRESSES} quick presses...")
        self.press(settings.FACTORY_RESET_PRESSES)
        self.wait_for(r"\[MAIN\] \+5 button presses", timeout=15)
        self.wait_for(r"\[MAIN\] Reset - WIFI 1", timeout=10)
        return self.wait_for_reboot(self.log_position(), timeout=30)

    # --- cloud firmware ---------------------------------------------------

    def factory_reset_cloud(self):
        """Cloud firmware: factory reset, which leaves the device in BLE advertising."""
        self.ctrl.factory_reset_via_power_cycles(min_cycles=6)
        self._last_power_on = time.time()
        try:
            self.wait_for(r"\[BLE\] BLE Advertising started", timeout=90)
        except TimeoutError:
            self.ctrl.reset(method="relay_hex")
            self._last_power_on = time.time()
            self.wait_for(r"\[BLE\] BLE Advertising started", timeout=90)
