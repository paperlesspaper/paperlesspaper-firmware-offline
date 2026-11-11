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
import threading
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
        self._release_port()
        time.sleep(self.target.relay_off_seconds)
        ESP32HardwareController.set_relay_power(self.target.relay_port, power_on=True)
        self._last_power_on = time.time()

    def _release_port(self):
        """Hands the serial port back to the reader thread, which reopens it on its own.

        On the 13" board the USB bridge loses power with the device, so the COM port
        disappears during a power cycle and comes back some time after power-on. The
        reader thread retries until then. Nothing here may block: the timing of quick
        presses depends on it. (ESP32HardwareController.connect() is not used for
        this: it stops the reader thread and leaves it stopped if the port is late.)
        """
        ctrl = self.ctrl
        try:
            if ctrl.ser:
                ctrl.ser.close()
        except Exception:
            pass
        if not (ctrl._thread and ctrl._thread.is_alive()):
            ctrl._running = True
            ctrl._thread = threading.Thread(target=ctrl._reader_loop, daemon=True)
            ctrl._thread.start()

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
        try:
            since = self.log_position()
            self.press(1)
            return self.read_boot_info(since)
        except RuntimeError as first_error:
            # The COM port can come back too late to catch the first lines of the boot log.
            print(f"ℹ️ [{self.target.name}] No boot log seen, restarting once more ({str(first_error).splitlines()[0]})")
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
                self.wait_for(r"\[BLE\] BLE Advertising started", timeout=10)
                return
            except TimeoutError:
                if not self.ctrl.get_logs():
                    # The COM port came back after the boot log (13" board). Setup mode
                    # lasts 30 s, so the BLE scan that follows shows whether it is active.
                    print(f"ℹ️ [{self.target.name}] Boot log missed, continuing with the BLE scan.")
                    return
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
