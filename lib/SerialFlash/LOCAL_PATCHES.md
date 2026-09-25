# Pinned SerialFlash source

Source: https://github.com/smarthomeagentur/SerialFlash
Commit: 13f477b8a39f9c5b61f540568f976f8a959ae3af (2026-06-23).
The original MIT copyright/license headers are retained in the source files.

Local patches:
- `awaitReady(timeout)` and a latched I/O fault replace unbounded directory waits.
- Low-level `wait()` times out after 10 seconds and yields to the scheduler.
- Reads await readiness before entering the driver, avoiding the upstream
  unbounded suspend/resume polling branches; writes/erases fail closed after faults.
- `begin()` clears the I/O fault latch on hardware reinitialization.

The append-only allocation format is unchanged. Safe image-only directory
reclamation, checked allocation/reuse and verified writes are in
`src/image_storage.cpp`. Rebuilding the directory erases its first external flash
sector only, and is refused if an active non-image file or invalid directory exists.
This local library takes precedence over external packages; the unpinned remote
SerialFlash dependency was removed from platformio.ini.
