import contextlib
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from webtest.harness import Site, WebApp  # noqa: E402

if sys.platform == "win32":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


@contextlib.asynccontextmanager
async def open_app(device=None, files=None, bluetooth=True):
    """The web UI in a browser, connected to nothing yet. Yields (app, site)."""
    with Site(files=files) as site:
        async with WebApp(site, device, bluetooth=bluetooth) as app:
            yield app, site
            # Every test ends with these two checks: the page ran without script errors
            # and did not try to reach anything outside the test site.
            unexpected = [e for e in app.console_errors if not any(text in e for text in app.expected_errors)]
            assert not unexpected, f"Errors in the browser console: {unexpected}"
            assert not app.blocked_requests, f"The page contacted other hosts: {app.blocked_requests}"


@pytest.fixture
def app_session():
    return open_app
