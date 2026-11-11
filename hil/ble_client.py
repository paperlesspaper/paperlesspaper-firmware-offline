"""BLE client for the offline firmware (and the firmware upload of the cloud firmware).

Mirrors web/src/DeviceBleInterface.js. Two upload protocols exist:
  V2      offline firmware >= 0.1.0: 1 byte sequence number per packet,
          window CRC via status read, total CRC in END / END_FW
  legacy  cloud firmware and old offline builds: CRC32 per packet,
          status read returns only the number of buffered bytes
"""

import asyncio
import json
import struct
import sys
import zlib
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner

from . import settings
from .cloud import mask_uid, register_github_mask

STATUS_UPLOAD_ERROR = 0xFFFF
STATUS_SEQ_ERROR = 0xFFFE


class BleError(RuntimeError):
    pass


@dataclass
class UploadStatus:
    position: int  # bytes buffered in RAM, or 0xFFFF / 0xFFFE on error
    crc: int | None
    max_payload: int | None

    @property
    def is_v2(self):
        return self.max_payload is not None


def crc32(data):
    return zlib.crc32(bytes(data)) & 0xFFFFFFFF


def ble_run(coro, timeout=120):
    """Runs one BLE coroutine to completion from synchronous test code."""
    return asyncio.run(asyncio.wait_for(coro, timeout))


class BleSession:
    """One BLE connection to a device, found by its advertised name (= UID)."""

    def __init__(self, uid, scan_timeout=20.0):
        self.uid = uid
        self.scan_timeout = scan_timeout
        self.client = None
        self.advertised_name = None

    async def __aenter__(self):
        target = self.uid.lower()
        register_github_mask(self.uid)
        device = await BleakScanner.find_device_by_filter(
            lambda d, adv: target in ((adv.local_name or d.name or "").lower()),
            timeout=self.scan_timeout,
        )
        if device is None:
            raise BleError(f"BLE device '{mask_uid(self.uid)}' is not advertising.")
        register_github_mask(device.address)
        self.advertised_name = device.name
        # Windows caches the GATT table per address; it changes when the firmware is switched.
        kwargs = {"winrt": {"use_cached_services": False}} if sys.platform == "win32" else {}
        self.client = BleakClient(device, timeout=25.0, **kwargs)
        await self.client.connect()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        try:
            await self.client.disconnect()
        except Exception:
            pass  # the device may already have rebooted

    # --- characteristics --------------------------------------------------

    def service_uuids(self):
        return {s.uuid.lower() for s in self.client.services}

    def characteristic_uuids(self):
        return {c.uuid.lower() for s in self.client.services for c in s.characteristics}

    def characteristic_properties(self, uuid):
        char = self.client.services.get_characteristic(uuid)
        return set(char.properties) if char else set()

    async def try_read(self, uuid):
        """Returns the value of a characteristic, or None if the device refuses the read."""
        try:
            return await self.read_bytes(uuid)
        except Exception:
            return None

    async def read_bytes(self, uuid):
        return bytes(await self.client.read_gatt_char(uuid))

    async def read_text(self, uuid):
        return (await self.read_bytes(uuid)).decode("utf-8", errors="replace")

    async def write_text(self, uuid, value):
        await self.client.write_gatt_char(uuid, str(value).encode("utf-8"), response=True)

    async def read_system_info(self):
        return json.loads(await self.read_text(settings.CHR_SYSTEM_INFO))

    async def command(self, text):
        await self.client.write_gatt_char(settings.CHR_UPLOAD_CMD, text.encode("utf-8"), response=True)

    async def status(self):
        raw = await self.read_bytes(settings.CHR_UPLOAD_CMD)
        if len(raw) >= 8:
            position, crc, max_payload = struct.unpack_from("<HIH", raw)
            return UploadStatus(position, crc, max_payload)
        if len(raw) >= 2:
            return UploadStatus(struct.unpack_from("<H", raw)[0], None, None)
        raise BleError(f"Unexpected upload status of {len(raw)} bytes.")

    # --- upload -----------------------------------------------------------

    def _max_write(self):
        return max(20, self.client.mtu_size - 3)

    async def _send_window(self, window, chunk_size, v2, burst_size, burst_delay):
        sequence = 0
        for start in range(0, len(window), chunk_size):
            chunk = window[start:start + chunk_size]
            if v2:
                packet = bytes([sequence & 0xFF]) + chunk
            else:
                packet = struct.pack("<I", crc32(chunk)) + chunk
            sequence += 1
            last = start + chunk_size >= len(window)
            await self.client.write_gatt_char(settings.CHR_UPLOAD_DATA, packet, response=last)
            if not last and sequence % burst_size == 0:
                await asyncio.sleep(burst_delay)

    async def upload(self, data, firmware, progress=None):
        """Uploads an image payload or a firmware binary.

        Returns the protocol that was used ("v2" or "legacy"). After a firmware
        upload the device reboots on its own; an image still needs APPLY.
        """
        data = bytes(data)
        await self.command("START_FW" if firmware else "START")
        initial = await self.status()
        if initial.position == STATUS_UPLOAD_ERROR:
            raise BleError("Device could not open its upload buffer (flash or RAM error).")

        v2 = initial.is_v2
        if v2:
            await self.command("V2")
            if firmware:
                await self.command(f"FW_SIZE:{len(data)}")
                if (await self.status()).position == STATUS_UPLOAD_ERROR:
                    raise BleError(f"Device rejected the firmware size of {len(data)} bytes.")
            negotiated = initial.max_payload if 20 <= initial.max_payload <= 508 else 240
            chunk_size = min(negotiated, self._max_write() - 1)
            checkpoint, burst_size, burst_delay = 32768, 6, 0.001
        else:
            chunk_size = min(238, self._max_write() - 4)
            checkpoint, burst_size, burst_delay = 19040, 1, 0.006

        total_crc = crc32(data)
        offset = 0
        retries = 0
        while offset < len(data):
            window = data[offset:offset + checkpoint]
            await self._send_window(window, chunk_size, v2, burst_size, burst_delay)
            status = await self.status()
            if v2 and status.position == STATUS_UPLOAD_ERROR:
                raise BleError("Device reported a write error during the upload.")
            valid = status.position == len(window) and (not v2 or status.crc == crc32(window))

            if valid:
                await self.command("FLUSH")
                if firmware and v2 and offset == 0 and (await self.status()).position == STATUS_UPLOAD_ERROR:
                    raise BleError("Device rejected the firmware header.")
                offset += len(window)
                retries = 0
                if progress:
                    progress(offset, len(data))
            else:
                retries += 1
                if retries > 10:
                    raise BleError(f"Upload failed: window at offset {offset} could not be transferred.")
                burst_size = max(1, burst_size // 2)
                burst_delay = min(0.012, burst_delay + 0.002)
                await asyncio.sleep(0.03)
                await self.command("CLEAR")

        if firmware:
            await self._end_firmware(v2, total_crc)
        else:
            await self.command(f"END:{total_crc:08x}" if v2 else "END")
            if v2:
                end = await self.status()
                if end.position == STATUS_UPLOAD_ERROR or end.crc != total_crc:
                    raise BleError("Device rejected the image: CRC of the stored data does not match.")
        return "v2" if v2 else "legacy"

    async def _end_firmware(self, v2, total_crc):
        if not v2:
            # Legacy firmware restarts inside the write callback, so the write may never be confirmed.
            try:
                await self.command("END_FW")
            except Exception:
                pass
            return
        await self.command(f"END_FW:{total_crc:08x}")
        end = await self.status()
        if end.position in (STATUS_UPLOAD_ERROR, STATUS_SEQ_ERROR) or end.crc != total_crc:
            raise BleError("Device rejected the firmware: size or CRC check failed.")


def upload_firmware(uid, path, timeout=None):
    """Connects to the device and flashes the firmware file over BLE. Returns the protocol used."""
    timeout = settings.BLE_FW_UPLOAD_TIMEOUT if timeout is None else timeout
    with open(path, "rb") as f:
        data = f.read()
    if not (settings.MIN_OTA_FW_SIZE <= len(data) <= settings.MAX_OTA_FW_SIZE) or data[0] != 0xE9:
        raise BleError(f"'{path}' is not a valid ESP32 application image for the OTA partition.")

    last_decile = -1

    def progress(done, total):
        nonlocal last_decile
        decile = done * 10 // total
        if decile != last_decile:
            last_decile = decile
            print(f"   ➔ firmware upload {decile * 10}% ({done:,} / {total:,} bytes)")

    async def run():
        async with BleSession(uid) as session:
            return await session.upload(data, firmware=True, progress=progress)

    return ble_run(run(), timeout=timeout)
