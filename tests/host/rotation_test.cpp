#define ROTATION_TEST
#include "display_test.cpp"
#include "display_sync.h"
#include <functional>
#include <thread>

// Compile the exact production timer and orientation-service functions.
std::atomic<bool> stopAccRecheck{false}, epaperIsUpdating{false};
RotationRequests rotationRequests;
struct { bool autoRotation = true; } settings;
struct { int deviceOrientation = 0; } systemData;
bool isOrientUpdate = false;
int storedOrientation = 0, mockSensor = 0, mockRotation = 0;
unsigned sensorReads = 0, flashWrites = 0;
std::vector<int> samples;
int accInit(bool) {
    ++sensorReads;
    if (samples.empty()) return mockSensor;
    int value = samples.front(); samples.erase(samples.begin()); return value;
}
void delay(int) {}
void displaySetRotation(int value) { mockRotation = value; }
int readIntFromFlash(int address) { assert(address == 220); return storedOrientation; }
void writeIntToFlash(int value, int address) {
    assert(address == 220 && !epaperIsUpdating); storedOrientation = value; ++flashWrites;
}
struct { template<class... Args> void printf(const char *, Args...) {} } Serial;
#include "rotation_function.inc"

void testProductionOrientation() {
    for (int phase = 0; phase < 6; ++phase) {
        mockSensor = phase % 4;
        serviceOrientation(true);
        const int frozen = systemData.deviceOrientation;
        const unsigned reads = sensorReads, writes = flashWrites;
        epaperIsUpdating = true;
        mockSensor = (frozen + 1) % 4;
        std::thread timer([] { recheckAccOrient(0); }); timer.join();
        assert(sensorReads == reads && flashWrites == writes);
        serviceOrientation(false);
        assert(sensorReads == reads && systemData.deviceOrientation == frozen);
        epaperIsUpdating = false; // owner calls this only after POF/error cleanup
        serviceOrientation(false);
        assert(systemData.deviceOrientation == mockSensor);
        assert(mockRotation == (mockSensor >= 2 ? 1 : 0));
    }
    const int stable = systemData.deviceOrientation;
    samples = {0, 1}; serviceOrientation(true);
    assert(systemData.deviceOrientation == stable); // motion must not change snapshot
    mockSensor = 2; serviceOrientation(false); // retained request, stable retry
    assert(systemData.deviceOrientation == 2);
    settings.autoRotation = false;
    mockSensor = 3; recheckAccOrient(0); serviceOrientation(false);
    assert(systemData.deviceOrientation == 2);
    settings.autoRotation = true;
    stopAccRecheck = true;
    unsigned reads = sensorReads;
    recheckAccOrient(0); serviceOrientation(false);
    assert(sensorReads == reads);
    std::puts("PASS: production ACC callback/service: deferred sampling and NVS, stable retry, autoRotation off, stopped ticker");
}

struct RotationIO : FakeIO {
    std::function<void(int)> inject;
    void command(uint8_t half, uint8_t cmd, const uint8_t *data, uint32_t size) {
        if (cmd == 0x10) inject(half == 0 ? 1 : 2);
        if (cmd == 0x12) inject(3);
        if (cmd == 0x02) inject(5);
        FakeIO::command(half, cmd, data, size);
    }
    void pause(uint32_t ms) {
        if (stage == 1) inject(4);
        FakeIO::pause(ms);
    }
};

int main() {
    testProductionOrientation();
    unsigned cases = 0;
    for (int repeat = 0; repeat < 8; ++repeat) {
        for (int phase = 0; phase < 6; ++phase) {
            RotationRequests requests;
            int orientation = repeat % 4, sensor = orientation;
            const int initial = orientation, next = (initial + 1) % 4;
            unsigned cleanup = 0, applied = 0;
            bool active = false, injected = false;
            RotationIO io;
            io.refreshActiveMs = 525;
            io.inject = [&](int at) {
                if (at != phase || injected) return;
                injected = true;
                sensor = next;
                // A real competing thread publishes the timer request and tries
                // to enter the exact same resource mutex as power/init/SPI.
                std::thread competitor([&] {
                    requests.request();
                    assert(!displayMutex().try_lock());
                });
                competitor.join();
                assert(active && orientation == initial && cleanup == 0);
            };
            {
                auto frame = makeDisplayFrame([&] { active = true; return orientation; }, [&] {
                    assert(io.pof == 1 && !io.busy());
                    ++cleanup; active = false;
                    if (requests.take()) { orientation = sensor; ++applied; }
                });
                io.inject(0); // initReset/clearScreen inside the session
                uint32_t written;
                auto read = [](uint32_t, uint8_t *out, uint32_t len) { memset(out, 0, len); return true; };
                assert(Epd13::writeFrame(io, read, getColor, frame.orientation >= 2, written));
                assert(Epd13::refreshFull(io));
                assert(injected && orientation == initial && frame.orientation == initial);
                frame.finish();
                frame.finish(); // exactly-once even with explicit finish + destructor
                assert(orientation == next && cleanup == 1 && applied == 1);
            }
            assert(cleanup == 1 && !active);
            std::thread after([] { assert(displayMutex().try_lock()); displayMutex().unlock(); });
            after.join();
            ++cases;
        }
    }
    for (auto fault : {FakeIO::NoBusy, FakeIO::StuckRefresh, FakeIO::StuckPowerOn,
                       FakeIO::StuckPowerOff, FakeIO::UnstablePowerOff}) {
        RotationRequests requests;
        FakeIO io; io.fault = fault;
        unsigned cutRail = 0, applied = 0;
        {
            auto frame = makeDisplayFrame([] { return 0; }, [&] {
                ++cutRail; // production completion uses physical rail cutoff, not driver POF
                if (requests.take()) ++applied;
            });
            std::thread competitor([&] { requests.request(); assert(!displayMutex().try_lock()); });
            competitor.join();
            assert(!Epd13::refreshFull(io));
            assert(cutRail == 0 && applied == 0);
            frame.finish(); frame.finish();
        }
        assert(cutRail == 1 && applied == 1 && io.pof <= 1);
        ++cases;
    }
    // Early return before/during RAM must use the same destructor cleanup.
    for (int failAt : {0, 600, 480000, 960000}) {
        unsigned cleanup = 0;
        auto failure = [&] {
            auto frame = makeDisplayFrame([] { return 2; }, [&] { ++cleanup; });
            if (failAt == 0) return;
            FakeIO io;
            unsigned reads = 0; uint32_t written;
            auto read = [&](uint32_t, uint8_t *out, uint32_t len) {
                memset(out, 0, len); reads += len; return reads < unsigned(failAt);
            };
            assert(!Epd13::writeFrame(io, read, getColor, true, written));
            assert(io.drf == 0 && io.pof == 0);
        };
        failure(); assert(cleanup == 1); ++cases;
    }
    std::printf("PASS: %u rotation/session cases; init/master/slave/DRF/BUSY/POF, 8 alternating cycles, competing owner excluded, deferred apply, exactly-once failure cleanup\n", cases);
}
