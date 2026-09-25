#include "image_format.h"
#include "image_storage.h"
#include <algorithm>
#include <cassert>
#include <limits>
#include <vector>
#include <string>

static std::vector<uint8_t> memory;
static uint32_t blockSizeValue = 65536;
static bool dropDirectory = false, dropPixels = false, stuck = false;
static unsigned directoryErases = 0, cases = 0, allocations = 0;
static unsigned flashWrites = 0, blockErases = 0;
static bool recoveryUsed = false;
static unsigned recoveryGateCalls = 0;
static int cutAfter = -1;
struct PowerCut {};
static void powerTick() { if (cutAfter == 0) throw PowerCut{}; if (cutAfter > 0) --cutAfter; }
static ImageStorage::RecoveryPermission claimRecovery() {
    ++recoveryGateCalls;
    if (recoveryUsed) return ImageStorage::RecoveryPermission::AlreadyUsed;
    recoveryUsed = true;
    return ImageStorage::RecoveryPermission::Granted;
}
TestSerial Serial;
SerialFlashChip SerialFlash;
uint16_t SerialFlashChip::dirindex = 0;
bool SerialFlashChip::ioFault = false;
void SerialFlashChip::read(uint32_t address, void *buf, uint32_t len) {
    assert(address <= memory.size() && len <= memory.size() - address);
    memcpy(buf, memory.data() + address, len);
}
void SerialFlashChip::write(uint32_t address, const void *buf, uint32_t len) {
    ++flashWrites;
    assert(address <= memory.size() && len <= memory.size() - address);
    if ((dropDirectory && address < blockSizeValue) || (dropPixels && address >= blockSizeValue))
        return;
    powerTick();
    if (address >= 8 && address < 1208 && len == 2 && memory[address] == 255 && memory[address + 1] == 255)
        ++allocations;
    auto bytes = static_cast<const uint8_t *>(buf);
    for (uint32_t i = 0; i < len; ++i)
        memory[address + i] &= bytes[i];
}
void SerialFlashChip::readID(uint8_t *id) { memset(id, 0, 5); }
uint32_t SerialFlashChip::capacity(const uint8_t *) { return memory.size(); }
uint32_t SerialFlashChip::blockSize() { return blockSizeValue; }
bool SerialFlashChip::awaitReady(uint32_t) {
    if (stuck)
        ioFault = true;
    return !ioFault;
}
bool SerialFlashChip::ready() { return !stuck; }
void SerialFlashChip::eraseBlock(uint32_t address) {
    ++blockErases;
    assert(address + blockSizeValue <= memory.size());
    powerTick();
    if (!address)
        ++directoryErases;
    if (!stuck)
        std::fill(memory.begin() + address, memory.begin() + address + blockSizeValue, 255);
}
// Reset the test transport via the real class declaration, never production hardware.
bool SerialFlashChip::begin(uint8_t, uint32_t) {
    ioFault = false;
    return true;
}
static void reset(uint32_t capacity = 4194304, uint32_t block = 65536) {
    memory.assign(capacity, 255);
    blockSizeValue = block;
    dropDirectory = dropPixels = stuck = false;
    directoryErases = allocations = 0;
    recoveryUsed = false;
    recoveryGateCalls = 0;
    cutAfter = -1;
    ImageStorage::setRecoveryGate(claimRecovery);
    SerialFlash.begin(21);
}
static void roundTrip(uint32_t length, unsigned content = 0) {
    SerialFlashFile file;
    assert(ImageStorage::prepare("tmp.bmp", length, file));
    assert(file.size() >= length);
    std::vector<uint8_t> bytes(length);
    for (uint32_t i = 0; i < length; ++i)
        bytes[i] = uint8_t(i * 17 + content);
    assert(ImageStorage::write(file, bytes.data(), length));
    assert(ImageStorage::finish("tmp.bmp", file, length, length, true));
    assert(ImageStorage::logicalLength() == length);
    file = SerialFlash.open(ImageStorage::IMAGE_SLOT);
    file.seek(0);
    std::vector<uint8_t> out(length);
    assert(file.read(out.data(), length) == length && out == bytes);
    ++cases;
}
int main() {
    SerialFlashFile file;
    // Exact physical device layout: 17 * 983040 + directory block = 16 MiB.
    reset(16777216);
    for (unsigned i = 0; i < 16; ++i) {
        assert(SerialFlash.createErasable("tmp.gz", 983040));
        if (i < 15) assert(SerialFlash.remove("tmp.gz"));
    }
    assert(SerialFlash.createErasable("tmp.bmp", 983040));
    assert(SerialFlash.remove("tmp.bmp"));
    auto full = ImageStorage::inspect(true);
    assert(full.valid && full.entries == 17 && full.tailFree == 0 && full.capacity == 16777216);
    // Check each physical directory record, including active/deleted status.
    for (unsigned i = 0; i < 17; ++i) {
        uint16_t hash;
        uint32_t entry[3] = {};
        SerialFlash.read(8 + i * 2, &hash, 2);
        SerialFlash.read(8 + 600 * 2 + i * 10, entry, 10);
        assert((hash != 0) == (i == 15));
        assert(entry[0] == 65536 + i * 983040 && entry[1] == 983040);
        assert(!strcmp(reinterpret_cast<const char *>(memory.data() + 8 + 600 * 12 + entry[2] * 4),
                       i < 16 ? "tmp.gz" : "tmp.bmp"));
    }
#ifdef LEGACY_WHITELIST_TEST
    assert(!full.imageOnly);
    for (unsigned i = 0; i < 6; ++i)
        assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
    assert(recoveryGateCalls == 0 && !recoveryUsed && directoryErases == 0 && allocations == 17);
    std::puts("PASS: v2 whitelist rejection of exact physical layout never invokes NVS gate");
    return 0;
#endif
    assert(full.imageOnly);
    roundTrip(960118); // one recovery and one persistent slot creation
    assert(directoryErases == 1 && allocations == 18 && recoveryGateCalls == 1 && recoveryUsed);
    uint32_t recoveredAddress = SerialFlash.open(ImageStorage::IMAGE_SLOT).getFlashAddress();
    for (unsigned i = 0; i < 24; ++i) {
        SerialFlash.begin(21);
        roundTrip(960118, i + 1); // all 24 must take REUSE, including after reboot
        assert(directoryErases == 1 && allocations == 18 && recoveryGateCalls == 1);
        assert(ImageStorage::inspect().entries == 1);
        auto slot = SerialFlash.open(ImageStorage::IMAGE_SLOT);
        assert(slot.size() == 983040 && slot.getFlashAddress() == recoveredAddress);
    }
    std::puts("PASS: exact tmp.gz physical layout: recovery=1, new allocations=1, subsequent REUSE=24");
    // 24 downloads with different URLs, validators and payloads. The production
    // downloader passes only IMAGE_SLOT, never URL/hash, to the storage layer.
    reset(1048576);
    uint32_t address = 0;
    for (unsigned i = 0; i < 24; ++i) {
        std::string url = "http://host/image/" + std::to_string(i) + ".bmp";
        std::string hash = "validator-" + std::to_string(i);
        assert(!url.empty() && !hash.empty());
        roundTrip(960000 + (i % 3 == 0 ? 118 : i % 3 == 1 ? 4 : 0), i);
        auto slot = SerialFlash.open(ImageStorage::IMAGE_SLOT);
        if (!i) address = slot.getFlashAddress();
        assert(slot.getFlashAddress() == address && slot.size() == 983040);
        assert(allocations == 1 && directoryErases == 0);
        assert(ImageStorage::inspect().tailFree == 0);
        // Includes the actual display lifecycle: open/read/close, then deep sleep.
        slot.close();
        SerialFlash.begin(21);
    }
    // Existing deployed allocation is adopted, even when tail is zero.
    reset(1048576);
    assert(SerialFlash.createErasable("tmp.bmp", 983040));
    roundTrip(960118);
    assert(allocations == 1 && directoryErases == 0);
    // Reset during invalidation, sector erases, pixel writes, and commit.
    for (int cut : {0, 1, 2, 8, 16, 17, 100, 3766, 3767}) {
        reset(1048576);
        roundTrip(960118, 7);
        cutAfter = cut;
        try {
            assert(ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
            std::vector<uint8_t> pixels(960118, 55);
            assert(ImageStorage::write(file, pixels.data(), pixels.size()));
            ImageStorage::finish(ImageStorage::IMAGE_SLOT, file, pixels.size(), pixels.size(), true);
        } catch (const PowerCut &) {}
        cutAfter = -1;
        SerialFlash.begin(21); // preserve only flash and persistent recovery latch
        assert(SerialFlash.exists(ImageStorage::IMAGE_SLOT));
        for (unsigned i = 0; i < 20; ++i) roundTrip(960118, i);
        assert(allocations == 1 && directoryErases == 0);
    }
    reset(1048576);
    assert(SerialFlash.createErasable("tmp_raw.bin", 983040));
    assert(SerialFlash.remove("tmp_raw.bin"));
    assert(ImageStorage::inspect().tailFree == 0);
    const unsigned beforeRecovery = allocations;
    for (unsigned i = 0; i < 24; ++i) {
        roundTrip(960118, i);
        assert(allocations == beforeRecovery + 1 && directoryErases == 1);
        assert(ImageStorage::inspect().entries == 1);
    }
    // The persistent latch prevents another reset even across six retries/reboots.
    assert(SerialFlash.remove(ImageStorage::IMAGE_SLOT));
    for (unsigned i = 0; i < 6; ++i) {
        SerialFlash.begin(21);
        assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
        assert(directoryErases == 1 && allocations == beforeRecovery + 1);
    }
    // Reproduce the reported 16 MiB device with no allocator tail remaining.
    reset(16777216);
    while (ImageStorage::inspect().tailFree) {
        uint32_t bytes = std::min(ImageStorage::inspect().tailFree, ImageStorage::SLOT_BYTES);
        assert(SerialFlash.createErasable("tmp_raw.bin", bytes));
        assert(SerialFlash.remove("tmp_raw.bin"));
    }
    unsigned exhaustedAllocations = allocations;
    for (unsigned i = 0; i < 24; ++i) {
        roundTrip(960118, i);
        assert(allocations == exhaustedAllocations + 1 && directoryErases == 1);
        assert(ImageStorage::inspect().entries == 1);
    }
    // Failed recovery creation cannot trigger another erase.
    reset(1048576);
    assert(SerialFlash.createErasable("tmp_raw.bin", 983040));
    dropDirectory = true;
    assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
    for (unsigned i = 0; i < 6; ++i)
        assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
    assert(directoryErases == 1);
    dropDirectory = false;
    roundTrip(960118);
    // Unknown active AND deleted files prevent destructive image recovery.
    for (const char *unknown : {"keep.dat", "tmp.gz.bak", "TMP.GZ", "other.gz"})
    for (bool deleted : {false, true}) {
        reset(1048576);
        assert(SerialFlash.createErasable(unknown, 983040));
        if (deleted) assert(SerialFlash.remove(unknown));
        assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
        assert(directoryErases == 0 && !recoveryUsed && recoveryGateCalls == 0);
    }
    reset(524288);
    assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
    assert(directoryErases == 0 && allocations == 0);
    reset();
    assert(ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
    uint8_t data[54] = {};
    assert(ImageStorage::write(file, data, sizeof(data)));
    assert(!ImageStorage::finish(ImageStorage::IMAGE_SLOT, file, 960118, 54, false));
    assert(SerialFlash.exists(ImageStorage::IMAGE_SLOT) && !ImageStorage::logicalLength());
    assert(ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
    dropPixels = true;
    assert(!ImageStorage::write(file, data, sizeof(data)));
    assert(!ImageStorage::finish(ImageStorage::IMAGE_SLOT, file, 960118, 0, false));
    assert(SerialFlash.exists(ImageStorage::IMAGE_SLOT) && !ImageStorage::logicalLength());
    dropPixels = false;
    roundTrip(960118);
    assert(allocations == 1);
    assert(ImageStorage::discard(ImageStorage::IMAGE_SLOT));
    assert(!ImageStorage::logicalLength() && SerialFlash.exists(ImageStorage::IMAGE_SLOT));
    roundTrip(960004);
    assert(allocations == 1);
    reset();
    stuck = true;
    assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file));
    assert(SerialFlash.failed());
    reset();
    assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, std::numeric_limits<uint32_t>::max(), file));
    assert(allocations == 0);
    memory[0] = 0;
    assert(!ImageStorage::prepare(ImageStorage::IMAGE_SLOT, 960118, file) && directoryErases == 0);
    uint8_t header[54] = {};
    header[0] = 'B';
    header[1] = 'M';
    header[26] = 1;
    header[28] = 4;
    auto put32 = [&](unsigned at, uint32_t value) {
        for (unsigned i = 0; i < 4; ++i)
            header[at + i] = value >> (8 * i);
    };
    put32(2, 960118);
    put32(10, 118);
    put32(14, 40);
    put32(18, 1200);
    put32(22, uint32_t(-1600));
    assert(ImageFormat::validBmp4(header, 960118, 1200, 1600));
    ++cases;
    assert(!ImageFormat::validBmp4(header, 960004, 1200, 1600));
    ++cases;
    put32(22, 1600);
    assert(!ImageFormat::validBmp4(header, 960118, 1200, 1600));
    ++cases;
    put32(22, uint32_t(-1600));
    put32(10, 960119);
    assert(!ImageFormat::validBmp4(header, 960118, 1200, 1600));
    ++cases;
    std::printf("PASS: %u storage/format cases\n", cases);
    return 0;
}
