"""Lets the web UI in a test browser talk to the real device.

The page under test gets a replacement for navigator.bluetooth (webtest/shim.js) that
forwards every GATT operation to this bridge, which performs it with the PC's Bluetooth
(bleak). So the shipped page code drives the real firmware: connection setup, settings,
picture upload and firmware update. Not covered is Chrome's own Bluetooth stack and its
device chooser; they are replaced by the bridge.
"""

import asyncio
import contextlib
import os

import pytest

from . import settings
from .ble_client import BleSession

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IN_CI = bool(os.environ.get("GITHUB_ACTIONS"))

DISCONNECTED = "GATT Server is disconnected. Cannot perform GATT operations."


class GattError(Exception):
    """Becomes a DOMException with this name in the page."""

    def __init__(self, name, message):
        super().__init__(message)
        self.name = name


class HardwareBridge:
    """BLE backend of webtest.harness.WebApp for one real device."""

    def __init__(self, uid):
        self.uid = uid
        self.session = None
        self.emit = None  # set by the harness: async (event) -> None
        self.commands = []  # commands the page wrote to the upload characteristic
        self.connections = 0
        self._watchdog = None

    def _client(self):
        client = self.session.client if self.session else None
        if client is None or not client.is_connected:
            raise GattError("NetworkError", DISCONNECTED)
        return client

    async def _open(self):
        await self.close()
        session = BleSession(self.uid)
        await session.__aenter__()
        self.session = session
        self._watchdog = asyncio.get_running_loop().create_task(self._watch(session))

    async def close(self):
        if self._watchdog:
            self._watchdog.cancel()
            self._watchdog = None
        session, self.session = self.session, None
        if session:
            await session.__aexit__(None, None, None)

    async def _watch(self, session):
        """Tells the page when the device closed the connection (reboot, reset, sleep)."""
        while session.client is not None and session.client.is_connected:
            await asyncio.sleep(0.5)
        if self.session is session and self.emit:
            self.session = None
            await self.emit({"type": "disconnected"})

    async def handle(self, op, args):
        if op == "request_device":
            await self._open()  # scan and connect: the name is only known after the scan
            return {"name": self.session.advertised_name or self.uid}
        if op == "connect":
            if self.session is None or self.session.client is None or not self.session.client.is_connected:
                await self._open()
            self.connections += 1
            return {}
        if op == "disconnect":
            await self.close()
            return {}

        client = self._client()
        if op == "has_service":
            return {"exists": client.services.get_service(args["uuid"]) is not None}
        if op == "has_characteristic":
            service = client.services.get_service(args["service"])
            return {"exists": service is not None and service.get_characteristic(args["uuid"]) is not None}
        if op == "read":
            return {"data": bytes(await client.read_gatt_char(args["uuid"]))}
        if op == "write":
            if args["uuid"] == settings.CHR_UPLOAD_CMD:
                self.commands.append(args["data"].decode("utf-8", errors="replace"))
            await client.write_gatt_char(args["uuid"], args["data"], response=bool(args.get("response", True)))
            return {}
        if op == "subscribe":
            uuid = args["uuid"]
            loop = asyncio.get_running_loop()

            def notified(_, data):
                if self.emit:
                    loop.create_task(self.emit({"type": "notify", "uuid": uuid, "data": bytes(data)}))

            await client.start_notify(uuid, notified)
            return {}
        raise GattError("NotSupportedError", f"Unknown operation {op}")


def web_dist():
    """Folder of the built web UI. Missing: the test is skipped locally and fails in CI."""
    dist = os.environ.get("WEB_DIST") or os.path.join(REPO_ROOT, "web", "dist")
    if os.path.isfile(os.path.join(dist, "index.html")):
        return dist
    message = "Web UI is not built (web/dist is missing). Run `npm run build` in web/."
    if IN_CI:
        pytest.fail(message)
    pytest.skip(message)


@contextlib.asynccontextmanager
async def web_ui(device, files=None):
    """The web UI in a browser, connected to `device` in setup mode. Yields (app, bridge, site)."""
    try:
        from webtest.harness import Site, WebApp
    except ImportError as err:  # playwright is not installed
        if IN_CI:
            raise
        pytest.skip(f"Browser tests need playwright: {err}")

    bridge = HardwareBridge(device.uid)
    with Site(dist_dir=web_dist(), files=files) as site:
        async with WebApp(site, bridge) as app:
            try:
                # The page is loaded first: setup mode only lasts 30 s without a connection.
                await asyncio.to_thread(device.enter_setup_mode)
                try:
                    await app.connect(timeout=120000)
                except Exception as err:
                    # The status line of the page says why (device not found, GATT error, ...).
                    raise AssertionError(f"The web UI did not connect to the device. Status line: {await app.status()}") from err
                yield app, bridge, site
            finally:
                await bridge.close()
