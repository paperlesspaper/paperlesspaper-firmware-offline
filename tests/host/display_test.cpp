#include "epaper_13inch_transfer.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>
#define EPD_TYPE_13INCH
#include "get_color_function.inc"

struct FakeIO {
    enum Fault { None, NoBusy, StuckRefresh, StuckPowerOn, StuckPowerOff, ActiveGlitch, UnstableIdle, IdleBounce, UnstablePowerOff } fault = None;
    uint32_t clock = 0, busyFrom = 0, busyUntil = 0;
    uint32_t refreshActiveMs = 40000, elapsedRefresh = 0, stageStart = 0;
    uint8_t stage = 0;
    bool active = false, neverIdle = false, failed = false;
    unsigned drf = 0, pon = 0, pof = 0, begins = 0, ends = 0, completedHalves = 0;
    std::array<std::vector<uint8_t>, 2> ram = {std::vector<uint8_t>(480000, 0xff), std::vector<uint8_t>(480000, 0xff)};
    std::array<std::array<unsigned, 1600>, 2> coverage{};
    std::array<std::array<uint8_t, 9>, 2> window{};
    void command(uint8_t half, uint8_t cmd, const uint8_t *data, uint32_t size) {
        if (cmd == 0x83) {
            assert(size == 9);
            if (data[8]) assert(data[0] == 0 && data[1] == 0 && data[2] == 4 && data[3] == 0xaf);
            for (unsigned h = 0; h < 2; ++h) if (half == 2 || half == h) memcpy(window[h].data(), data, 9);
        } else if (cmd == 0x91) {
            assert(half < 2 && size == 0 && window[half][8] == 1);
        } else if (cmd == 0x10) {
            assert(half < 2 && size == 600);
            auto &w = window[half];
            unsigned y = 2 * (unsigned(w[4]) * 256 + w[5]);
            unsigned end = 2 * (unsigned(w[6]) * 256 + w[7] + 1);
            assert(w[8] == 1 && y % 2 == 0 && end == y + 2 && end <= 1600);
            for (unsigned row = y; row < end; ++row) assert(++coverage[half][row] == 1);
            memcpy(ram[half].data() + y * 300, data, size);
        } else if (cmd == 0x04) {
            assert(half == 2 && size == 0); ++pon;
            active = true; busyFrom = clock; busyUntil = clock + 100;
            neverIdle = fault == StuckPowerOn;
        } else if (cmd == 0x12) {
            assert(half == 2 && size == 1 && data[0] == 0 && pon == 1 && drf == 0);
            for (const auto &w : window) {
                const std::array<uint8_t, 9> full = {};
                assert(w == full); // driver-defined partial disable on BOTH controllers
            }
            ++drf; stage = 1; stageStart = clock; active = fault != NoBusy;
            busyFrom = clock + 5; busyUntil = busyFrom + (fault == ActiveGlitch ? 1 : refreshActiveMs);
            neverIdle = fault == StuckRefresh;
        } else if (cmd == 0x02) {
            assert(half == 2 && size == 1 && data[0] == 0 && ends == 1 && !busy());
            ++pof; stage = 2; stageStart = clock; active = true; busyFrom = clock; busyUntil = clock + 100;
            neverIdle = fault == StuckPowerOff;
        } else assert(false);
    }
    void yieldBus() {}
    void halfComplete(uint8_t, uint32_t bytes) { assert(bytes == 480000); ++completedHalves; }
    uint32_t now() { return clock; }
    bool busy() {
        uint32_t since = uint32_t(clock - stageStart);
        if (stage == 1 && fault == UnstableIdle && since > 100) return (since % 10) < 5;
        if (stage == 2 && fault == UnstablePowerOff && since > 100) return (since % 10) < 5;
        if (stage == 1 && fault == IdleBounce && since >= 100 && since < 105) return false;
        return active && int32_t(clock - busyFrom) >= 0 && (neverIdle || int32_t(busyUntil - clock) > 0);
    }
    void pause(uint32_t ms) { clock += ms; }
    void refreshBegin() { ++begins; }
    void refreshEnd(uint32_t ms) {
        assert(ms == refreshActiveMs + 5 + Epd13::BUSY_IDLE_STABLE_MS);
        elapsedRefresh = ms; ++ends;
    }
    void failure(const char *) { failed = true; }
};
#ifndef ROTATION_TEST
int main() {
    unsigned cases = 0;
    // Full replacement, asymmetric patterns and both retained rotations. All
    // 1,920,000 source pixels are checked independently against controller RAM.
    for (bool rotate : {false, true}) {
        FakeIO io;
        for (unsigned frame = 0; frame < 3; ++frame) {
            std::vector<uint8_t> source(960000);
            for (uint32_t i = 0; i < source.size(); ++i) source[i] = uint8_t(i * 17 + (i / 600) * 7 + frame * 31);
            io.coverage = {}; io.completedHalves = 0;
            auto read = [&](uint32_t at, uint8_t *out, uint32_t len) {
                assert(at + len <= source.size()); memcpy(out, source.data() + at, len); return true;
            };
            uint32_t written = 0;
            assert(Epd13::writeFrame(io, read, getColor, rotate, written));
            assert(written == 960000 && io.completedHalves == 2);
            for (unsigned y = 0; y < 1600; ++y) for (unsigned x = 0; x < 1200; ++x) {
                unsigned sx = rotate ? 1199 - x : x, sy = rotate ? 1599 - y : y;
                uint8_t src = source[sy * 600 + sx / 2];
                uint8_t expected = getColor(sx % 2 ? src & 15 : src >> 4);
                uint8_t actual = io.ram[x / 600][y * 300 + (x % 600) / 2];
                assert((x % 2 ? actual & 15 : actual >> 4) == expected);
                assert(io.coverage[x / 600][y] == 1);
            }
            ++cases;
        }
        assert(Epd13::refreshFull(io));
        assert(io.drf == 1 && io.pon == 1 && io.pof == 1 && io.ends == 1 && !io.failed);
        ++cases;
    }
    for (auto fault : {FakeIO::NoBusy, FakeIO::StuckRefresh, FakeIO::StuckPowerOn, FakeIO::StuckPowerOff, FakeIO::ActiveGlitch, FakeIO::UnstableIdle, FakeIO::UnstablePowerOff}) {
        FakeIO io; io.fault = fault;
        assert(!Epd13::refreshFull(io) && io.failed);
        assert(io.ends == ((fault == FakeIO::StuckPowerOff || fault == FakeIO::UnstablePowerOff) ? 1u : 0u));
        assert(io.drf == (fault == FakeIO::StuckPowerOn ? 0u : 1u));
        ++cases;
    }
    // Regression: durations previously rejected purely by the 10-second cutoff.
    for (uint32_t elapsed : {9999u, 10148u, 525u}) {
        FakeIO io;
        io.refreshActiveMs = elapsed - 5 - Epd13::BUSY_IDLE_STABLE_MS;
        assert(Epd13::refreshFull(io));
        assert(io.elapsedRefresh == elapsed && io.ends == 1 && io.pof == 1 && !io.failed);
        assert(!io.busy() && uint32_t(io.clock - io.busyUntil) >= Epd13::BUSY_IDLE_STABLE_MS);
        std::printf("PASS: valid DRF elapsed=%u ms, stable idle and monitored POF\n", elapsed);
        ++cases;
    }
    FakeIO bounce; bounce.fault = FakeIO::IdleBounce;
    assert(Epd13::refreshFull(bounce) && bounce.ends == 1 && bounce.pof == 1);
    assert(bounce.elapsedRefresh == 40025); // a five-ms HIGH gap cannot end the refresh
    ++cases;
    // Explicit deadline and debounce reset boundaries, independent of refresh simulation.
    struct LevelIO {
        uint32_t time = 0, idleAt = 0;
        bool busy() { return time < idleAt; }
        uint32_t now() { return time; }
        void pause(uint32_t ms) { time += ms; }
    } level;
    level.idleAt = 81;
    assert(!Epd13::waitIdle(level, 100) && level.time == 100); // only 19 ms idle
    level = {}; level.idleAt = 79;
    assert(Epd13::waitIdle(level, 100) && level.time == 99);
    cases += 2;
    FakeIO wrap; wrap.clock = 0xfffffff0;
    assert(Epd13::refreshFull(wrap) && wrap.ends == 1);
    ++cases;
    FakeIO shortRead;
    uint32_t written = 0;
    auto read = [](uint32_t at, uint8_t *out, uint32_t len) { memset(out, 0, len); return at < 1200; };
    assert(!Epd13::writeFrame(shortRead, read, getColor, false, written));
    assert(written == 600 && shortRead.drf == 0);
    ++cases;
    std::printf("PASS: %u display cases; full pixel coverage, rotations/color mapping, one DRF, BUSY failures, read failure\n", cases);
}

#endif
