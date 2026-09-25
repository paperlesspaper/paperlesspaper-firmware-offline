#pragma once
#include <SerialFlash.h>

namespace ImageStorage {
// Retain the deployed filename: a compatible existing allocation is adopted in place.
constexpr const char *IMAGE_SLOT = "tmp.bmp";
constexpr uint32_t SLOT_BYTES = 983040;
constexpr uint32_t MAX_IMAGE_BYTES = SLOT_BYTES - 16;
struct Space {
    uint32_t capacity = 0, block = 0, tailFree = 0, directoryBytes = 0;
    uint32_t entries = 0;
    bool valid = false, imageOnly = false;
};
// Must persist a one-shot recovery latch BEFORE permitting a directory erase.
enum class RecoveryPermission { Granted, AlreadyUsed, Unavailable };
void setRecoveryGate(RecoveryPermission (*gate)());
Space inspect(bool diagnose = false);
bool prepare(const char *name, uint32_t required, SerialFlashFile &file, bool allowRebuild = true);
bool write(SerialFlashFile &file, const uint8_t *data, uint32_t size);
bool finish(const char *name, SerialFlashFile &file, uint32_t required, uint32_t written,
            bool transportOk);
uint32_t logicalLength();
bool discard(const char *name); // invalidate content only; never remove the allocation
} // namespace ImageStorage
