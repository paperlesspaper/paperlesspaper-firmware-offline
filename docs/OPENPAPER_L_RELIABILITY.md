# OpenPaper L: reliable image updates and server-directed sleep

This document describes the reliability path used by the 13.3-inch
OpenPaper L (`EL133UF3`). It covers persistent image storage, full-panel
refresh synchronization, conditional HTTP downloads, and the optional
server-directed sleep interval.

## Goals

- Reuse one external-flash image allocation indefinitely instead of consuming
  a new allocation on every download.
- Never display an incomplete image after a reset, disconnect, or write error.
- Transfer all 1,920,000 pixels to both display controllers and wait for a
  completed full refresh before powering the panel down.
- Skip flash writes and panel refreshes when the HTTP image did not change.
- Let a server align the next wake-up with a timetable without replacing the
  BLE-configured fallback interval.

## Persistent image slot

The 13.3-inch 4-bit BMP is 960,118 bytes. The external NOR flash reserves one
983,040-byte erase-aligned slot named `tmp.bmp`. The final 16 bytes contain a
small commit record, leaving 983,024 bytes for image data.

Before changing image data, the firmware invalidates the commit record. It
then erases and writes the existing slot, verifies the write by reading it
back, and only then writes the new commit record. A reset during this sequence
therefore leaves an allocated but invalid slot that can be reused on the next
wake-up.

The SerialFlash directory is append-only: deleting a directory entry does not
return allocator space. For devices already filled with legacy `tmp.bmp`,
`tmp_raw.bin`, or `tmp.gz` entries, the firmware can perform one guarded
recovery. Recovery is allowed only when every directory entry is a known image
cache name. It erases only the external-flash directory block, records a
persistent one-time latch in NVS, and recreates the single image slot. Unknown
files, malformed metadata, an incompatible flash geometry, or I/O errors block
recovery.

Downloaded HTTP images must be validated top-down 4-bit BMP files with the
expected 1200 x 1600 geometry. Formats that require a second large conversion
file are rejected on this single-slot path.

## Full 13.3-inch refresh

The panel consists of two 600 x 1600 controller halves. The image is streamed
in bounded RAM strips to both controllers. The transfer code checks storage
reads, verifies complete pixel and byte counts, and issues one full-display
refresh only after both halves are complete.

The refresh sequence is serialized with accelerometer-driven orientation
updates. Orientation changes detected during a transfer are deferred until the
panel has completed the refresh and power-off sequence. BUSY must become active
and then remain idle for a stable interval; timeout and unstable transitions
fail the update instead of reporting success prematurely.

## Conditional HTTP requests

For a successful image response, the firmware stores a bounded `ETag` or
`Last-Modified` validator in NVS. On later wakes it sends `If-None-Match` or
`If-Modified-Since`.

- `200 OK`: validate and store the new image, then refresh the panel.
- `304 Not Modified`: do not touch external flash and do not refresh the panel.
- Network or protocol failure: preserve the last committed image and use the
  retry policy described below.

Double-button force-download keeps its existing behavior and bypasses the
conditional request for that wake-up.

## Optional server-directed sleep

An image server may return this response header on both `200` and `304`:

```text
X-OpenPaper-Sleep-Seconds: 1323
```

The value is a decimal number of seconds until the device should wake again.
Accepted values are 60 through 86,400 seconds. The firmware subtracts time
already spent downloading, writing, and refreshing before entering deep sleep,
so processing time does not shift a timetable later on every cycle.

The header applies only to the current sleep cycle. It does not overwrite the
interval stored through BLE. Missing, malformed, negative, out-of-range, or
stale values are ignored and the BLE interval remains the fallback.

The server remains responsible for wall-clock and time-zone calculations. A
typical server computes the next timetable slot in its configured time zone,
subtracts a small wake-ahead margin, and returns the remaining duration. The
device itself does not need a real-time clock or time-zone database.

Example sequence:

1. The device wakes and requests the configured image URL.
2. The server selects the content for the relevant timetable slot and returns
   the image or `304`, plus `X-OpenPaper-Sleep-Seconds`.
3. A new image is committed and displayed; an unchanged image is skipped.
4. The device subtracts elapsed processing time and sleeps for the remaining
   duration.
5. The next request repeats the calculation from the server's current time.

If an image request fails, no server-provided value is trusted. The firmware
retries after 60 to 300 seconds rather than sleeping for a long configured
interval. BLE setup and manual wake behavior are unchanged.

## Server contract

The sleep header is intentionally optional and backwards compatible. A normal
static web server can omit it. A timetable-aware server should:

- return the same validator for byte-identical image content;
- include the sleep header on both `200` and `304` responses;
- calculate durations from the response time, including daylight-saving
  changes;
- keep values within 60 to 86,400 seconds;
- select upcoming content during any deliberate pre-wake window, avoiding an
  extra one-minute wake solely to cross a slot boundary.

## Validation

Run the deterministic host suite:

```bash
./tests/run_host_tests.sh
```

It covers storage allocation and recovery, interrupted writes, readback
failures, repeated downloads, complete dual-controller transfers, display
timeouts, orientation races, conditional `200`/`304` requests, malformed sleep
headers, elapsed-time subtraction, timer wraparound, and bounded error retries.

Build the target firmware with:

```bash
pio run -e ESP32-C6-DevKitM-1
```

For a physical acceptance test, alternate at least two full-screen images over
multiple deep-sleep cycles. The log should show one initial `Slot CREATED`, then
`Slot REUSE`; unchanged responses should log HTTP 304 and no panel refresh. A
successful full refresh ends with `PANEL REFRESH END` followed by `POF complete`.
