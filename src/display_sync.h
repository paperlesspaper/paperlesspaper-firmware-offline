#pragma once
#include <atomic>
#ifdef ARDUINO
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#else
#include <mutex>
#endif

// One recursive owner for panel pins, power, configuration and shared SPI.
// Recursion permits the owner to use ordinary display/storage entry points.
class DisplayMutex {
#ifdef ARDUINO
    SemaphoreHandle_t handle;
public:
    DisplayMutex() : handle(xSemaphoreCreateRecursiveMutex()) { configASSERT(handle); }
    void lock() { xSemaphoreTakeRecursive(handle, portMAX_DELAY); }
    void unlock() { xSemaphoreGiveRecursive(handle); }
    bool try_lock() { return xSemaphoreTakeRecursive(handle, 0) == pdTRUE; }
#else
    std::recursive_mutex handle;
public:
    void lock() { handle.lock(); }
    void unlock() { handle.unlock(); }
    bool try_lock() { return handle.try_lock(); }
#endif
};
DisplayMutex &displayMutex();
class DisplayGuard {
public:
    DisplayGuard() { displayMutex().lock(); }
    ~DisplayGuard() { displayMutex().unlock(); }
    DisplayGuard(const DisplayGuard &) = delete;
    DisplayGuard &operator=(const DisplayGuard &) = delete;
};

// Timer publishes only a request. Sampling and applying are owner-task work.
class RotationRequests {
    std::atomic<bool> pending{false};
public:
    void request() { pending.store(true); }
    bool take() { return pending.exchange(false); }
};

// Lock precedes the snapshot; completion (including failure cleanup and deferred
// rotation) precedes unlock. Explicit finish and destructor cannot clean up twice.
template<class Finish> class DisplayFrame {
    DisplayGuard guard;
    Finish finishAction;
    bool finished = false;
public:
    const int orientation;
    template<class Prepare> DisplayFrame(Prepare prepare, Finish finish)
        : finishAction(finish), orientation(prepare()) {}
    void finish() {
        if (!finished) { finished = true; finishAction(); }
    }
    ~DisplayFrame() { finish(); }
    DisplayFrame(const DisplayFrame &) = delete;
};
template<class Prepare, class Finish>
DisplayFrame<Finish> makeDisplayFrame(Prepare prepare, Finish finish) {
    return DisplayFrame<Finish>(prepare, finish);
}
