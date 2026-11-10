"""Machine-wide lock for the shared test hardware.

GitHub's `concurrency` only works inside one repository. This lock keeps a
local run and a runner job (or two runner instances) from switching the same
relays at the same time.
"""

import os
import tempfile
import time
from contextlib import contextmanager

from . import settings


def _lock_path():
    if settings.LOCK_FILE:
        return settings.LOCK_FILE
    shared_dir = "C:\\testbench"
    base = shared_dir if os.path.isdir(shared_dir) else tempfile.gettempdir()
    return os.path.join(base, "paperlesspaper_hil.lock")


def _try_lock(handle):
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(handle):
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


@contextmanager
def hardware_lock(timeout=None):
    """Holds the hardware lock; waits up to `timeout` seconds for another run."""
    timeout = settings.LOCK_TIMEOUT if timeout is None else timeout
    path = _lock_path()
    handle = open(path, "a+")
    try:
        handle.seek(0)
        start = time.time()
        announced = False
        while not _try_lock(handle):
            if time.time() - start > timeout:
                raise TimeoutError(f"Test hardware is still in use after {timeout}s (lock: {path}).")
            if not announced:
                print(f"⏳ Test hardware is in use by another run, waiting (lock: {path})...")
                announced = True
            time.sleep(5)
        try:
            yield
        finally:
            _unlock(handle)
    finally:
        handle.close()
