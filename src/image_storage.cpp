#include "image_storage.h"
#include <cstring>


namespace ImageStorage {
static bool imageName(const char *name) {
    return !strcmp(name, "tmp.bmp") || !strcmp(name, "tmp_raw.bin");
}

static RecoveryPermission (*recoveryGate)() = nullptr;
void setRecoveryGate(RecoveryPermission (*gate)()) { recoveryGate = gate; }

Space inspect(bool diagnose) {
    Space s;
    uint8_t id[5];
    if (!SerialFlash.awaitReady())
        return s;
    SerialFlash.readID(id);
    s.capacity = SerialFlash.capacity(id);
    s.block = SerialFlash.blockSize();
    if (!s.capacity || !s.block)
        return s;
    uint32_t header[2];
    SerialFlash.read(0, header, sizeof(header));
    if (header[0] == 0xFFFFFFFF) {
        s.directoryBytes = 8 + 600 * 12 + 25560; // pinned SerialFlash defaults
        s.valid = s.directoryBytes <= s.block && s.capacity >= s.block;
        s.imageOnly = true;
        s.tailFree = s.valid ? s.capacity - s.block : 0;
        return s;
    }
    if (header[0] != 0xFA96554C)
        return s;
    uint32_t slots = header[1] & 0xffff;
    s.directoryBytes = 8 + slots * 12 + (header[1] >> 16) * 4;
    if (!slots || s.directoryBytes > s.block || s.block > s.capacity)
        return s;
    uint32_t tail = s.block;
    s.imageOnly = true;
    for (uint32_t i = 0; i < slots; ++i) {
        uint16_t hash;
        SerialFlash.read(8 + i * 2, &hash, 2);
        if (hash == 0xffff)
            break;
        uint32_t entry[3] = {};
        SerialFlash.read(8 + slots * 2 + i * 10, entry, 10);
        // Deleted entries still reserve their complete extent in this allocator.
        if (entry[0] < s.block || entry[0] > s.capacity || entry[1] > s.capacity - entry[0])
            return s;
        uint32_t nameAddress = 8 + slots * 12 + (entry[2] & 0xffff) * 4;
        if (nameAddress >= s.directoryBytes)
            return s;
        char name[80] = {};
        uint32_t nameBytes = s.directoryBytes - nameAddress;
        if (nameBytes > sizeof(name))
            nameBytes = sizeof(name);
        SerialFlash.read(nameAddress, name, nameBytes);
        if (!memchr(name, 0, nameBytes))
            return s;
        if (!imageName(name) && strcmp(name, "tmp.gz"))
            s.imageOnly = false;
        ++s.entries;
        if (diagnose) Serial.printf("[FLASH] Entry=%u name=%s deleted=%d address=%u reserved=%u\n",
                                    i, name, hash == 0, entry[0], entry[1]);
        uint32_t end = entry[0] + entry[1];
        if (end > tail)
            tail = end;
    }
    tail = ((tail + s.block - 1) / s.block) * s.block;
    s.tailFree = tail <= s.capacity ? s.capacity - tail : 0;
    s.valid = !SerialFlash.failed();
    return s;
}

static constexpr uint32_t COMMITTED = 0x534C4F54;
static bool isSlot(SerialFlashFile &file) {
    return file && file.size() == SLOT_BYTES;
}
uint32_t logicalLength() {
    auto file = SerialFlash.open(IMAGE_SLOT);
    if (!isSlot(file) || SerialFlash.failed()) return 0;
    uint32_t meta[4];
    SerialFlash.read(file.getFlashAddress() + MAX_IMAGE_BYTES, meta, sizeof(meta));
    return !SerialFlash.failed() && meta[0] == COMMITTED && meta[1] &&
           meta[1] <= MAX_IMAGE_BYTES && meta[2] == ~meta[1] && meta[3] == ~COMMITTED
               ? meta[1] : 0;
}
bool discard(const char *name) {
    if (!imageName(name) || !SerialFlash.awaitReady()) return false;
    auto file = SerialFlash.open(IMAGE_SLOT);
    if (!file) return true;
    if (!isSlot(file)) return false;
    uint32_t invalid = 0;
    SerialFlash.write(file.getFlashAddress() + MAX_IMAGE_BYTES, &invalid, sizeof(invalid));
    return SerialFlash.awaitReady() && logicalLength() == 0;
}

bool prepare(const char *name, uint32_t required, SerialFlashFile &file, bool allowRebuild) {
    file = SerialFlashFile();
    Space s = inspect();
    if (strcmp(name, IMAGE_SLOT) || !s.valid || !required || required > MAX_IMAGE_BYTES ||
        SLOT_BYTES % s.block || SLOT_BYTES > s.capacity - s.block) {
        Serial.printf("[FLASH] Invalid slot request need=%u capacity=%u block=%u free_tail=%u\n",
                      required, s.capacity, s.block, s.tailFree);
        return false;
    }
    file = SerialFlash.open(IMAGE_SLOT);
    if (file && !isSlot(file)) file = SerialFlashFile();
    if (!file) {
        if (s.tailFree < SLOT_BYTES || SerialFlash.exists(IMAGE_SLOT)) {
            s = inspect(true);
            Serial.printf("[FLASH] FULL slot unavailable entries=%u free_tail=%u image_only=%d\n",
                          s.entries, s.tailFree, s.imageOnly);
            // Validate BEFORE invoking the gate: rejected metadata must not consume the latch.
            if (!s.valid || !s.imageOnly) {
                Serial.println("[FLASH] RECOVERY blocked: unknown or invalid metadata/files; NVS latch untouched");
                return false;
            }
            if (!allowRebuild || SerialFlash.failed() || !recoveryGate) {
                Serial.println("[FLASH] RECOVERY blocked: disabled, SPI fault or missing gate; NVS latch untouched");
                return false;
            }
            RecoveryPermission permission = recoveryGate();
            if (permission != RecoveryPermission::Granted) {
                Serial.println(permission == RecoveryPermission::AlreadyUsed
                    ? "[FLASH] RECOVERY blocked: NVS latch already set"
                    : "[FLASH] RECOVERY blocked: NVS latch read/write failed");
                return false;
            }
            Serial.println("[FLASH] RECOVERY ONCE: external image directory block 0 only; latch persisted");
            SerialFlash.eraseBlock(0);
            if (!SerialFlash.awaitReady()) return false;
            s = inspect();
            if (!s.valid || s.entries || s.tailFree < SLOT_BYTES) return false;
        }
        if (!SerialFlash.createErasable(IMAGE_SLOT, SLOT_BYTES)) return false;
        file = SerialFlash.open(IMAGE_SLOT);
        if (!isSlot(file)) { file = SerialFlashFile(); return false; }
        Serial.printf("[FLASH] Slot CREATED address=%u reserved=%u\n", file.getFlashAddress(), file.size());
    } else {
        Serial.printf("[FLASH] Slot REUSE address=%u reserved=%u free_tail=%u\n",
                      file.getFlashAddress(), file.size(), s.tailFree);
    }
    if (file.getFlashAddress() % s.block) { file = SerialFlashFile(); return false; }
    // Invalidate durably before erasing any pixel, including on power interruption.
    if (!discard(IMAGE_SLOT)) { file = SerialFlashFile(); return false; }
    // Erase the metadata sector FIRST. An erased trailer is never a committed image.
    for (uint32_t n = file.size(); n; n -= s.block) {
        SerialFlash.eraseBlock(file.getFlashAddress() + n - s.block);
        if (!SerialFlash.awaitReady()) { file = SerialFlashFile(); return false; }
    }
    return true;
}

bool write(SerialFlashFile &file, const uint8_t *data, uint32_t size) {
    if (!isSlot(file) || file.position() > MAX_IMAGE_BYTES ||
        size > MAX_IMAGE_BYTES - file.position() || SerialFlash.failed())
        return false;
    uint8_t verify[256];
    for (uint32_t pos = 0; pos < size;) {
        uint32_t chunk = size - pos > sizeof(verify) ? sizeof(verify) : size - pos;
        uint32_t address = file.getFlashAddress() + file.position();
        if (file.write(data + pos, chunk) != chunk || !SerialFlash.awaitReady())
            return false;
        SerialFlash.read(address, verify, chunk);
        if (SerialFlash.failed() || memcmp(data + pos, verify, chunk))
            return false;
        pos += chunk;
    }
    return true;
}
} // namespace ImageStorage

bool ImageStorage::finish(const char *name, SerialFlashFile &file, uint32_t required,
                          uint32_t written, bool transportOk) {
    bool ok = !strcmp(name, IMAGE_SLOT) && transportOk && isSlot(file) && required &&
              required <= MAX_IMAGE_BYTES && required == written && file.position() == written &&
              !SerialFlash.failed();
    if (ok) {
        uint32_t meta[4] = {COMMITTED, written, ~written, ~COMMITTED};
        SerialFlash.write(file.getFlashAddress() + MAX_IMAGE_BYTES, meta, sizeof(meta));
        ok = SerialFlash.awaitReady() && logicalLength() == written;
    }
    file.close(); // SerialFlash close() is a no-op; explicitly drop only the RAM handle.
    file = SerialFlashFile();
    return ok;
}
