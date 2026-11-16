"""Runs the built web UI (web/dist) in a headless Chromium against a BLE backend.

    async with WebApp(site_dir, backend) as app:
        await app.connect()
        ...

`backend` answers the GATT operations and the serial port of the page (see shim.js). It is either a
SimulatedDevice or the bridge to a real device (hil/web_bridge.py). A backend has
    async handle(op, args) -> dict     raises GattError for a failed operation
    emit                               set here: async (event) -> None, events to the page

The page is served from a local web server, and every request to another host is
blocked and recorded: a test never depends on, or leaks to, the internet.
"""

import asyncio
import base64
import functools
import http.server
import os
import shutil
import tempfile
import threading

from playwright.async_api import async_playwright

WEBTEST_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(WEBTEST_DIR, ".."))
DEFAULT_DIST = os.path.join(REPO_ROOT, "web", "dist")


# Counts how often the blocking transfer screen opened, so a test can wait for "the next transfer".
TRANSFER_COUNTER = """
window.__transferOpens = 0;
document.addEventListener("DOMContentLoaded", () => {
  const dialog = document.getElementById("transferDialog");
  if (!dialog) return;
  new MutationObserver(() => { if (dialog.open) window.__transferOpens++; })
    .observe(dialog, { attributes: true, attributeFilter: ["open"] });
});
"""


def run(coro, timeout=180):
    """Runs one async test body to completion from a synchronous test."""
    return asyncio.run(asyncio.wait_for(coro, timeout))


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    # Python takes MIME types from the Windows registry, where ".js" is often "text/plain".
    # A browser refuses to register a service worker served like that (GitHub Pages sends the
    # right types).
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
    }

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Site:
    """A copy of the built web UI plus the files a test adds (firmware, pictures), served locally."""

    def __init__(self, dist_dir=None, files=None):
        self.dist_dir = dist_dir or os.environ.get("WEB_DIST") or DEFAULT_DIST
        self.files = files or {}
        self.root = None
        self.server = None
        self.requests = []

    def __enter__(self):
        index = os.path.join(self.dist_dir, "index.html")
        if not os.path.isfile(index):
            raise RuntimeError(f"Web UI is not built: {index} is missing. Run `npm run build` in web/.")
        self.root = tempfile.mkdtemp(prefix="webtest_")
        shutil.copytree(self.dist_dir, self.root, dirs_exist_ok=True)
        for name, content in self.files.items():
            self.add(name, content)

        site = self

        class Handler(_QuietHandler):
            def do_GET(self):
                site.requests.append(self.path)
                super().do_GET()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=self.root))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.root, ignore_errors=True)

    def add(self, name, content):
        """Adds a file to the site: bytes, or the path of a file to copy."""
        path = os.path.join(self.root, *name.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if isinstance(content, (bytes, bytearray)):
            with open(path, "wb") as f:
                f.write(content)
        else:
            shutil.copyfile(content, path)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/"


class WebApp:
    def __init__(self, site, backend=None, bluetooth=True, headless=None, init_script=None):
        self.site = site
        self.init_script = init_script  # runs in the page before its own scripts
        self.backend = backend
        self.bluetooth = bluetooth
        self.headless = os.environ.get("WEBTEST_HEADED", "") == "" if headless is None else headless
        self.console_errors = []
        self.expected_errors = []  # text fragments of console errors a test provokes on purpose
        self.blocked_requests = []
        self.page = None
        self._playwright = self._browser = None
        self._events = set()

    async def __aenter__(self):
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=self.headless)
        context = await self._browser.new_context(accept_downloads=True, viewport={"width": 1280, "height": 900})
        self.page = page = await context.new_page()
        page.set_default_timeout(15000)

        async def route(request_route):
            url = request_route.request.url
            if url.startswith(self.site.url) or url.startswith(("data:", "blob:")):
                await request_route.continue_()
            else:
                self.blocked_requests.append(url)
                await request_route.abort()

        await context.route("**/*", route)
        page.on("console", lambda msg: self.console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: self.console_errors.append(f"uncaught: {err}"))

        await page.add_init_script(TRANSFER_COUNTER)
        if self.init_script:
            await page.add_init_script(self.init_script)
        if self.bluetooth:
            await page.expose_binding("__bleBridge", self._bridge)
            with open(os.path.join(WEBTEST_DIR, "shim.js"), "r", encoding="utf-8") as f:
                await page.add_init_script(f.read())
            if self.backend is not None:
                self.backend.emit = self._emit
        else:
            await page.add_init_script("Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });")

        await page.goto(self.site.url)
        # The status text sits in a toast that is hidden unless a message is being shown.
        await page.wait_for_selector("#status", state="attached")
        return self

    async def __aexit__(self, *exc):
        for task in list(self._events):
            task.cancel()
        try:
            await self._browser.close()
        finally:
            await self._playwright.stop()

    # --- bridge to the backend --------------------------------------------

    async def _bridge(self, source, op, args):
        args = dict(args or {})
        if "data" in args:
            args["data"] = base64.b64decode(args["data"])
        try:
            result = dict(await self.backend.handle(op, args) or {})
        except Exception as err:  # reported to the page as a rejected GATT operation
            return {"error": {"name": getattr(err, "name", "NetworkError"), "message": str(err) or type(err).__name__}}
        if "data" in result:
            result["data"] = base64.b64encode(bytes(result["data"])).decode("ascii")
        return result

    async def _emit(self, event):
        event = dict(event)
        if "data" in event:
            event["data"] = base64.b64encode(bytes(event["data"])).decode("ascii")
        try:
            await self.page.evaluate("event => window.__bleEvent(event)", event)
        except Exception:
            pass  # the page is gone

    # --- the page, as a user sees it --------------------------------------

    def locator(self, selector):
        return self.page.locator(selector)

    async def click(self, selector):
        await self.page.click(selector)

    async def text(self, selector):
        # text_content: the text of the document, not its CSS rendering (text-transform: uppercase)
        return (await self.page.locator(selector).text_content() or "").strip()

    async def status(self):
        return await self.text("#status")

    async def wait_status(self, fragment, timeout=15000):
        """Waits until the status line contains `fragment`."""
        await self.page.wait_for_function(
            "fragment => document.getElementById('status').textContent.includes(fragment)", arg=fragment, timeout=timeout
        )

    async def status_log(self):
        return await self.page.evaluate("document.getElementById('statusLogOutput').textContent")

    async def view(self, name):
        """Opens a view: bild, geraet, firmware or hilfe."""
        await self.click(f'[data-view-target="{name}"]')

    async def open_expert_area(self):
        """The expert settings of the device view (switches, factory reset)."""
        await self.view("geraet")

    async def gallery_view(self):
        """Opens the gallery ("Bild", "Galerie"); a device that downloads its picture opens the other side."""
        await self.view("bild")
        if await self.page.get_attribute("#btnSourceGallery", "aria-pressed") != "true":
            await self.click("#btnSourceGallery")

    async def url_settings(self):
        """Opens the settings of the download from a URL ("Bild", "Abruf per URL")."""
        await self.view("bild")
        await self.click("#btnSourceUrl")

    async def open_more_firmware(self):
        """Opens the collapsed "Weitere Optionen" of the firmware view (cloud firmware, certificates, custom firmware)."""
        await self.view("firmware")
        if await self.page.get_attribute('[aria-controls="moreFirmwareBody"]', "aria-expanded") != "true":
            await self.click('[aria-controls="moreFirmwareBody"]')

    async def start_connect(self, usb=False, button="#btnConnect"):
        """Presses "Verbinden" and answers the question how: Bluetooth, or the USB link of the shim."""
        await self.click(button)
        await self.page.wait_for_selector("#connectDialog[open]")
        await self.click("#btnConnectUsbAndSend" if usb else "#btnConnectAndSend")

    async def connect(self, timeout=40000):
        await self.start_connect()
        await self.page.wait_for_function(
            "() => !document.getElementById('systemStatusBar').hidden", timeout=timeout
        )

    async def connect_usb(self, timeout=40000):
        """Connects over the serial port of the shim (the USB link) instead of Bluetooth."""
        await self.start_connect(usb=True)
        await self.page.wait_for_function(
            "() => !document.getElementById('systemStatusBar').hidden", timeout=timeout
        )

    async def disconnect(self):
        await self.click("#btnDisconnect")
        await self.page.wait_for_function("() => document.getElementById('systemStatusBar').hidden")

    async def is_connected(self):
        return not await self.page.evaluate("document.getElementById('systemStatusBar').hidden")

    async def confirm(self, accept=True):
        """Answers the confirmation dialog of the page."""
        await self.page.wait_for_selector("#messageDialog[open]")
        await self.click("#messageOk" if accept else "#messageCancel")
        await self.page.wait_for_selector("#messageDialog:not([open])", state="attached")
        # The page reacts to the "close" event of the dialog, which fires just after it closed.
        await self.page.evaluate("() => new Promise(resolve => setTimeout(resolve, 50))")

    async def load_image(self, png_bytes):
        """Adds a picture to the gallery, opens it in the editor and waits for the dithered preview."""
        await self.add_pictures([png_bytes])
        await self.open_tile(len([tile for tile in await self.tiles() if tile["key"]]) - 1)
        await self.wait_status("Bildvorschau optimiert", timeout=60000)

    async def save_picture(self):
        """Stores the picture of the editor in the gallery; the editor closes."""
        await self.click("#btnSaveToGallery")
        await self.page.wait_for_selector("#editorDialog:not([open])", state="attached", timeout=60000)
        await self.wait_idle()

    async def wait_idle(self, timeout=120000):
        """Waits until the page has finished preparing pictures."""
        await self.page.wait_for_function("() => !document.getElementById('btnAddPictures').disabled", timeout=timeout)

    async def tiles(self):
        """The tiles of the gallery: key (picture of the gallery) or remote (id of a picture that is only on
        the device), status (synced, new, changed, remote or None), has_image, shown."""
        return await self.page.evaluate(
            """() => [...document.querySelectorAll('#galleryGrid .tile')].map((tile) => ({
                key: tile.dataset.key || null, remote: tile.dataset.remote || null, status: tile.dataset.status || null,
                has_image: Boolean(tile.querySelector('img')), shown: Boolean(tile.querySelector('.tile-shown')),
            }))"""
        )

    async def add_pictures(self, pictures, timeout=180000):
        """Quick add: several PNG files at once, prepared with the automatic settings."""
        await self.gallery_view()
        before = len([tile for tile in await self.tiles() if tile["key"]])
        files = [{"name": f"picture{index + 1}.png", "mimeType": "image/png", "buffer": bytes(data)} for index, data in enumerate(pictures)]
        await self.page.set_input_files("#galleryFileInput", files)
        await self.page.wait_for_function(
            "count => document.querySelectorAll('#galleryGrid .tile[data-key]').length >= count", arg=before + len(files), timeout=timeout
        )
        await self.wait_idle()

    async def open_tile(self, index):
        """Opens the tile at this position (a picture of the gallery) in the editor."""
        await self.page.locator("#galleryGrid .tile .tile-open").nth(index).click()
        await self.page.wait_for_selector("#editorDialog[open]")

    async def move_tile(self, key, steps):
        """Moves a picture in the order with the keyboard: steps < 0 towards the front."""
        await self.page.locator(f'#galleryGrid .tile[data-key="{key}"] .tile-open').focus()
        for _ in range(abs(steps)):
            await self.page.keyboard.press("Shift+ArrowLeft" if steps < 0 else "Shift+ArrowRight")
            await self.page.evaluate("() => new Promise(resolve => setTimeout(resolve, 100))")

    async def delete_tile(self, selector, accept=True):
        """Deletes a picture with the button on its tile and answers the confirmation."""
        tile = self.page.locator(selector)
        await tile.hover()
        await tile.locator(".tile-delete").click()
        await self.confirm(accept)

    async def sync(self, timeout=180000):
        """Presses "Synchronisieren" and waits for the end of the transfer (see transfer())."""
        return await self.transfer(lambda: self.click("#btnSyncGallery"), timeout=timeout)

    async def transfer(self, trigger, timeout=120000):
        """Runs `trigger` (the clicks that start an upload or a flash) and waits for the blocking
        transfer screen to finish. Returns (title, message) of the result screen, or None if the
        transfer closed without one (plain success)."""
        opens = await self.page.evaluate("window.__transferOpens")
        await trigger()
        await self.page.wait_for_function(
            "opens => { const d = document.getElementById('transferDialog');"
            " return window.__transferOpens > opens && (!d.open || !document.getElementById('btnTransferOk').hidden); }",
            arg=opens,
            timeout=timeout,
        )
        if not await self.page.evaluate("document.getElementById('transferDialog').open"):
            return None
        result = (await self.text("#transferTitle"), await self.text("#transferText"))
        await self.click("#btnTransferOk")
        return result

    async def ble_stats(self):
        return await self.page.evaluate("window.__bleStats")
