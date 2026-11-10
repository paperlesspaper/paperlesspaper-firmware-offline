import os

import pytest

from . import settings
from .cloud import ESP32HardwareController
from .device import OfflineDevice
from .lock import hardware_lock


def pytest_addoption(parser):
    parser.addoption("--target", choices=sorted(settings.TARGETS), default=os.environ.get("HIL_TARGET", "epd7"))


@pytest.fixture(scope="session")
def target(request):
    return settings.TARGETS[request.config.getoption("--target")]


@pytest.fixture(scope="session")
def device(target):
    """The device under test: powered alone, serial port open for the whole run."""
    with hardware_lock():
        ports = [p["port"] for p in ESP32HardwareController.list_ports()]
        if target.relay_port not in ports:
            pytest.exit(f"Relay port {target.relay_port} for {target.name} is not connected.", returncode=1)
        dev = OfflineDevice(target)
        dev.open()
        try:
            yield dev
        finally:
            dev.close()


@pytest.fixture(scope="session")
def run_state():
    """Facts earlier tests leave for later ones (firmware found at start, candidate version...)."""
    return {}


@pytest.fixture(autouse=True)
def no_firmware_crash(device):
    """Fails a test during which the firmware crashed or ran into its failsafe timer."""
    position = device.log_position()
    yield
    crashes = device.crash_lines_since(position)
    assert not crashes, "Firmware crashed or hung during this test:\n" + "\n".join(crashes)
