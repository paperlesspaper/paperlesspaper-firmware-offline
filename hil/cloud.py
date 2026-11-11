"""Access to the cloud firmware testbench (relay, serial port, log masking).

The hardware layer lives in the paperlesspaper-firmware repository. It is not
copied here; the checkout is located through CLOUD_TESTBENCH_ROOT (set by the
workflow) or found next to this repository.
"""

import os
import sys

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _find_cloud_root():
    candidates = [
        os.environ.get("CLOUD_TESTBENCH_ROOT"),
        os.path.join(_REPO_ROOT, "_cloud"),
        os.path.join(_REPO_ROOT, "..", "paperlesspaper-firmware"),
    ]
    for path in candidates:
        if path and os.path.isfile(os.path.join(path, "testbench", "hardware_controller.py")):
            return os.path.abspath(path)
    raise RuntimeError(
        "Cloud testbench not found. Check out paperlesspaper-firmware and set "
        "CLOUD_TESTBENCH_ROOT to its root directory."
    )


CLOUD_ROOT = _find_cloud_root()
if CLOUD_ROOT not in sys.path:
    sys.path.insert(0, CLOUD_ROOT)

from testbench import config as cloud_config  # noqa: E402
from testbench.hardware_controller import ESP32HardwareController, HardwareSetupError  # noqa: E402
from testbench.flasher import fetch_production_firmware  # noqa: E402
from testbench import privacy as _privacy  # noqa: E402
from testbench.privacy import mask_mac, mask_path, mask_ssid, sanitize_log_line  # noqa: E402

from .results import remember  # noqa: E402


def register_github_mask(value):
    """Masks the value in the job log and keeps it out of the uploaded result file."""
    remember(value)
    _privacy.register_github_mask(value)


def mask_uid(uid):
    remember(uid)
    return _privacy.mask_uid(uid)

__all__ = [
    "CLOUD_ROOT",
    "cloud_config",
    "ESP32HardwareController",
    "HardwareSetupError",
    "fetch_production_firmware",
    "mask_mac",
    "mask_path",
    "mask_ssid",
    "mask_uid",
    "register_github_mask",
    "sanitize_log_line",
]
