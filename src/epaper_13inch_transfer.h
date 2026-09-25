#pragma once
#include <cstdint>

// EL133UF3: two 600x1600 controllers, packed 4bpp. RAM windows are transport
// only; the optical update is always one complete, unshortened waveform.
namespace Epd13 {
// Match the public Cloud 13-inch path; leave SerialFlash clock unchanged.
constexpr uint32_t SPI_HZ = 10000000;
constexpr uint16_t WIDTH = 1200, HEIGHT = 1600, HALF_WIDTH = 600;
constexpr uint32_t IMAGE_BYTES = uint32_t(WIDTH) * HEIGHT / 2;
constexpr uint16_t STRIP_ROWS = 2, HALF_ROW_BYTES = HALF_WIDTH / 2;

// IO owns SPI transactions/CS and logs. Reader runs only while BOTH panel CS
// lines are high: SerialFlash shares this SPI bus with the panel.
template<class IO, class Reader, class Map>
bool writeFrame(IO &io, Reader read, Map map, bool rotate180, uint32_t &written) {
    uint8_t strip[STRIP_ROWS * HALF_ROW_BYTES];
    written = 0;
    for (uint8_t half = 0; half < 2; ++half) {
        for (uint16_t y = 0; y < HEIGHT; y += STRIP_ROWS) {
            for (uint16_t row = 0; row < STRIP_ROWS; ++row) {
                uint16_t srcY = rotate180 ? HEIGHT - 1 - y - row : y + row;
                uint8_t srcHalf = rotate180 ? 1 - half : half;
                uint8_t *line = strip + row * HALF_ROW_BYTES;
                if (!read(uint32_t(srcY) * (WIDTH / 2) + srcHalf * HALF_ROW_BYTES,
                          line, HALF_ROW_BYTES)) return false;
                if (rotate180) {
                    for (uint16_t b = 0; b < HALF_ROW_BYTES / 2; ++b) {
                        uint8_t left = line[b], right = line[HALF_ROW_BYTES - 1 - b];
                        line[b] = uint8_t((right << 4) | (right >> 4));
                        line[HALF_ROW_BYTES - 1 - b] = uint8_t((left << 4) | (left >> 4));
                    }
                }
                for (uint16_t b = 0; b < HALF_ROW_BYTES; ++b)
                    line[b] = uint8_t((map(line[b] >> 4) << 4) | map(line[b] & 15));
            }
            // Horizontal coordinates are doubled, vertical coordinates halved.
            const uint16_t lastGate = (y + STRIP_ROWS) / 2 - 1;
            const uint8_t window[] = {0, 0, 0x04, 0xAF, uint8_t((y / 2) >> 8),
                                     uint8_t(y / 2), uint8_t(lastGate >> 8), uint8_t(lastGate), 1};
            io.command(half, 0x83, window, sizeof(window));
            io.command(half, 0x91, nullptr, 0);
            io.command(half, 0x10, strip, sizeof(strip));
            written += sizeof(strip);
            io.yieldBus();
        }
        io.halfComplete(half, uint32_t(HALF_WIDTH) * HEIGHT / 2);
    }
    return written == IMAGE_BYTES;
}

// Same PTLW-disable sequence as the pinned driver/public Cloud path, sent
// transactionally to BOTH controllers. With enable=0 the coordinates are unused.
template<class IO> void fullWindow(IO &io) {
    const uint8_t window[9] = {};
    io.command(2, 0x83, window, sizeof(window));
}

// Millisecond-scale signal qualification, not an optical-refresh minimum.
constexpr uint32_t BUSY_ACTIVE_STABLE_MS = 5;
constexpr uint32_t BUSY_IDLE_STABLE_MS = 20;
constexpr uint32_t BUSY_ASSERT_TIMEOUT_MS = 2000;
constexpr uint32_t BUSY_TIMEOUT_MS = 120000;

template<class IO> bool waitStableLevel(IO &io, bool active, uint32_t stableMs, uint32_t timeoutMs) {
    const uint32_t start = io.now();
    uint32_t levelStart = start;
    bool tracking = false;
    for (;;) {
        const uint32_t now = io.now();
        if (uint32_t(now - start) >= timeoutMs) return false;
        if (io.busy() == active) {
            if (!tracking) { levelStart = now; tracking = true; }
            if (uint32_t(now - levelStart) >= stableMs) return true;
        } else {
            tracking = false; // a bounce restarts qualification, never the overall timeout
        }
        io.pause(1);
    }
}

template<class IO> bool waitIdle(IO &io, uint32_t timeoutMs) {
    // Observe the manufacturer's 20 ms settling interval, checking the pin
    // throughout it instead of blindly delaying after the first idle sample.
    return waitStableLevel(io, false, BUSY_IDLE_STABLE_MS, timeoutMs);
}

template<class IO> bool refreshFull(IO &io) {
    fullWindow(io);
    if (!waitIdle(io, BUSY_TIMEOUT_MS)) { io.failure("before PON"); return false; }
    io.command(2, 0x04, nullptr, 0); // PON, both controllers
    io.pause(1);
    if (!waitIdle(io, BUSY_TIMEOUT_MS)) { io.failure("PON timeout"); return false; }
    io.pause(50); // manufacturer's delay before DRF
    const uint8_t zero = 0;
    io.refreshBegin();
    uint32_t start = io.now();
    io.command(2, 0x12, &zero, 1); // one DRF, full built-in waveform
    // Require genuine activation; an isolated low pulse cannot validate a refresh.
    if (!waitStableLevel(io, true, BUSY_ACTIVE_STABLE_MS, BUSY_ASSERT_TIMEOUT_MS)) {
        io.failure("DRF BUSY not stable within 2000 ms"); return false;
    }
    if (!waitIdle(io, BUSY_TIMEOUT_MS)) {
        io.failure("DRF idle timeout/unstable"); return false;
    }
    io.refreshEnd(uint32_t(io.now() - start)); // duration is diagnostic, never a success threshold
    io.command(2, 0x02, &zero, 1); // POF only AFTER waveform completion
    io.pause(1);
    if (!waitIdle(io, BUSY_TIMEOUT_MS)) { io.failure("POF idle timeout/unstable"); return false; }
    return true;
}
} // namespace Epd13
