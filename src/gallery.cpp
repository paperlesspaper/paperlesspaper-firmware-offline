#include "gallery.h"
#include "epaper_display.h"
#include "storage.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <miniz.h>
#include <rom/crc.h>

// main.cpp
void setDisplayContent(uint8_t content);

namespace {

constexpr uint32_t RAW_SIZE = (uint32_t)EPD_WIDTH * EPD_HEIGHT / 2;
constexpr uint32_t MAX_FILE_SIZE = GALLERY_HEADER_SIZE + GALLERY_MAX_THUMB_SIZE + RAW_SIZE + GALLERY_SIZE_MARGIN;
constexpr uint32_t PUT_OVERHEAD = 8192; // room a new file needs besides its bytes

// ---------------------------------------------------------------------------
// Where the pictures are stored
// ---------------------------------------------------------------------------

#ifdef EPD_TYPE_13INCH
} // namespace
#include "SdFat.h"
extern SdFs sd;
extern SystemData systemData;
bool sdInit();
bool powerSupplyDisplay(bool enable);
namespace {

#define GALLERY_DIR "/gallery"
const char *const VOLUME_NAME = "sd";

class GalFile
{
 public:
   bool openRead(const char *path) { return file.open(path, O_RDONLY); }
   bool openWrite(const char *path) { return file.open(path, O_WRONLY | O_CREAT | O_TRUNC); }
   explicit operator bool() const { return file.isOpen(); }
   uint32_t read(void *buf, uint32_t len) {
      const int result = file.read(buf, len);
      return (result > 0) ? (uint32_t)result : 0;
   }
   uint32_t write(const void *buf, uint32_t len) { return (uint32_t)file.write(buf, len); }
   bool seek(uint32_t pos) { return file.seekSet(pos); }
   uint32_t size() { return (uint32_t)file.fileSize(); }
   bool close() { return file.isOpen() ? file.close() : true; }

 private:
   FsFile file;
};

bool volReady() {
   powerSupplyDisplay(true); // the card is supplied together with the display
   if (!systemData.sdReady && !sdInit())
      return false;
   return sd.exists(GALLERY_DIR) || sd.mkdir(GALLERY_DIR);
}

bool volRemove(const char *path) {
   return !sd.exists(path) || sd.remove(path);
}

bool volRename(const char *from, const char *to) {
   volRemove(to);
   return sd.rename(from, to);
}

void volList(Storage::ListCallback callback, void *context) {
   FsFile dir;
   if (!dir.open(GALLERY_DIR, O_RDONLY))
      return;
   FsFile entry;
   char name[32];
   while (entry.openNext(&dir, O_RDONLY)) {
      if (!entry.isDir() && entry.getName(name, sizeof(name)) > 0)
         callback(name, (uint32_t)entry.fileSize(), context);
      entry.close();
   }
   dir.close();
}

uint32_t volFree() {
   const uint64_t bytes = (uint64_t)sd.freeClusterCount() * sd.bytesPerCluster();
   return (bytes > 0xFFFFFFFFULL) ? 0xFFFFFFFFUL : (uint32_t)bytes;
}

uint32_t volTotal() {
   const uint64_t bytes = (uint64_t)sd.clusterCount() * sd.bytesPerCluster();
   return (bytes > 0xFFFFFFFFULL) ? 0xFFFFFFFFUL : (uint32_t)bytes;
}

#else

#define GALLERY_DIR "g"
const char *const VOLUME_NAME = "flash";
constexpr uint32_t FLASH_RESERVE = 65536; // kept free for the list, the state and the file system itself

typedef StoreFile GalFile;

bool volReady() {
   static bool dirMade = false;
   if (!Storage::ready())
      return false;
   if (!dirMade)
      dirMade = Storage::makeDir(GALLERY_DIR);
   return dirMade;
}

bool volRemove(const char *path) {
   return Storage::remove(path);
}

bool volRename(const char *from, const char *to) {
   return Storage::rename(from, to);
}

void volList(Storage::ListCallback callback, void *context) {
   Storage::list(GALLERY_DIR, callback, context);
}

uint32_t volFree() {
   const uint32_t bytes = Storage::freeBytes();
   return (bytes > FLASH_RESERVE) ? bytes - FLASH_RESERVE : 0;
}

uint32_t volTotal() {
   return Storage::totalBytes();
}

#endif

const char *const INDEX_PATH = GALLERY_DIR "/index";
const char *const INDEX_NEW_PATH = GALLERY_DIR "/index.new";
const char *const UPLOAD_PATH = GALLERY_DIR "/upload.tmp";
const char *const STATE_PATH = "gal.state"; // always in the flash

void picturePath(uint32_t id, char *out, size_t outSize) {
   snprintf(out, outSize, GALLERY_DIR "/%08x.pg", (unsigned)id);
}

// ---------------------------------------------------------------------------
// List and state
// ---------------------------------------------------------------------------

const uint8_t FLAG_SHUFFLE = 0x01;
const uint8_t FLAG_AUTO = 0x02;
const uint8_t FLAG_HAS_CURRENT = 0x04;

struct State
{
   uint16_t magic;
   uint8_t version;
   uint8_t flags;
   uint32_t currentId;
   uint32_t seed; // order of the running shuffle round, 0 = start a new round
   uint16_t pos;  // pictures shown in this round
   uint16_t reserved;
};
const uint16_t STATE_MAGIC = 0x5347; // "GS"

struct IndexHeader
{
   uint8_t magic[2]; // "GI"
   uint8_t version;
   uint8_t reserved;
   uint16_t count;
   uint16_t reserved2;
};

Gallery::Item items[GALLERY_MAX_ITEMS];
uint16_t itemCount = 0;
State state = {STATE_MAGIC, 1, FLAG_AUTO, 0, 0, 0, 0};
bool loaded = false;
uint32_t freeCache = 0;
bool freeCacheValid = false;
SemaphoreHandle_t galLock = nullptr;

// Static: they are used from the BLE task, whose stack is small.
GalFile putFile;
GalFile auxFile;
GalFile readFile;

struct Lock
{
   Lock() {
      if (galLock == nullptr)
         galLock = xSemaphoreCreateRecursiveMutex();
      xSemaphoreTakeRecursive(galLock, portMAX_DELAY);
   }
   ~Lock() { xSemaphoreGiveRecursive(galLock); }
};

int findItem(uint32_t id) {
   for (uint16_t i = 0; i < itemCount; i++) {
      if (items[i].id == id)
         return i;
   }
   return -1;
}

StoreFile stateFile;

void saveState() {
   if (stateFile.openWrite(STATE_PATH)) {
      stateFile.write(&state, sizeof(state));
      stateFile.close();
   }
}

void loadState() {
   State stored;
   if (stateFile.openRead(STATE_PATH) && stateFile.read(&stored, sizeof(stored)) == sizeof(stored) && stored.magic == STATE_MAGIC && stored.version == 1)
      state = stored;
   stateFile.close();
}

bool readIndexFile(const char *path) {
   IndexHeader header;
   if (!auxFile.openRead(path))
      return false;
   bool ok = auxFile.read(&header, sizeof(header)) == sizeof(header) && header.magic[0] == 'G' && header.magic[1] == 'I' &&
             header.version == 1 && header.count <= GALLERY_MAX_ITEMS;
   if (ok) {
      const uint32_t bytes = (uint32_t)header.count * sizeof(Gallery::Item);
      ok = auxFile.read(items, bytes) == bytes;
      itemCount = ok ? header.count : 0;
   }
   auxFile.close();
   return ok;
}

bool saveIndex() {
   IndexHeader header = {{'G', 'I'}, 1, 0, itemCount, 0};
   const uint32_t bytes = (uint32_t)itemCount * sizeof(Gallery::Item);
   bool ok = auxFile.openWrite(INDEX_NEW_PATH);
   if (ok) {
      ok = auxFile.write(&header, sizeof(header)) == sizeof(header) && auxFile.write(items, bytes) == bytes;
      ok = auxFile.close() && ok;
   }
   ok = ok && volRename(INDEX_NEW_PATH, INDEX_PATH);
   if (!ok)
      Serial.println("[GALLERY] ERROR: The list could not be stored.");
   freeCacheValid = false;
   return ok;
}

// A change of the list starts a new shuffle round.
void listChanged() {
   state.seed = 0;
   state.pos = 0;
   if ((state.flags & FLAG_HAS_CURRENT) && findItem(state.currentId) < 0)
      state.flags &= ~FLAG_HAS_CURRENT;
   saveState();
   saveIndex();
}

// Window of the deflate stream as a power of two (9 .. 15), 0 if the header names none that exists.
uint8_t windowBits(const uint8_t *header) {
   if (header[6] == 0)
      return 15; // not named: the largest
   return (header[6] >= 9 && header[6] <= 15) ? header[6] : 0;
}

bool parseHeader(const uint8_t *header, uint32_t fileSize, uint16_t &thumbLen, uint32_t &rawCrc) {
#ifdef EPD_TYPE_13INCH
   const uint8_t displayType = 13;
#else
   const uint8_t displayType = 7;
#endif
   thumbLen = (uint16_t)(header[4] | (header[5] << 8));
   const uint32_t rawLen = (uint32_t)header[8] | ((uint32_t)header[9] << 8) | ((uint32_t)header[10] << 16) | ((uint32_t)header[11] << 24);
   rawCrc = (uint32_t)header[12] | ((uint32_t)header[13] << 8) | ((uint32_t)header[14] << 16) | ((uint32_t)header[15] << 24);
   return header[0] == 'P' && header[1] == 'G' && header[2] == 1 && header[3] == displayType && windowBits(header) != 0 &&
          thumbLen <= GALLERY_MAX_THUMB_SIZE && rawLen == RAW_SIZE &&
          fileSize > (uint32_t)GALLERY_HEADER_SIZE + thumbLen && fileSize <= MAX_FILE_SIZE;
}

// Reads the header of a stored picture file.
bool readPictureHeader(const char *path, uint32_t &fileSize, uint16_t &thumbLen, uint32_t &rawCrc) {
   uint8_t header[GALLERY_HEADER_SIZE];
   if (!auxFile.openRead(path))
      return false;
   fileSize = auxFile.size();
   const bool ok = auxFile.read(header, sizeof(header)) == sizeof(header) && parseHeader(header, fileSize, thumbLen, rawCrc);
   auxFile.close();
   return ok;
}

// "1a2b3c4d.pg" -> id
bool idFromName(const char *name, uint32_t &id) {
   if (strlen(name) != 11 || strcmp(name + 8, ".pg") != 0)
      return false;
   char *end = nullptr;
   id = (uint32_t)strtoul(name, &end, 16);
   return end == name + 8;
}

struct Reconcile
{
   uint8_t seen[(GALLERY_MAX_ITEMS + 7) / 8];
   uint32_t unknown[16];
   uint8_t unknownCount;
};

void reconcileEntry(const char *name, uint32_t size, void *context) {
   Reconcile *r = (Reconcile *)context;
   uint32_t id;
   if (!idFromName(name, id))
      return;
   const int index = findItem(id);
   if (index >= 0)
      r->seen[index / 8] |= (uint8_t)(1 << (index % 8));
   else if (r->unknownCount < sizeof(r->unknown) / sizeof(r->unknown[0]))
      r->unknown[r->unknownCount++] = id;
}

// Makes the list match the files: an upload may have ended between storing a file and the list.
void reconcile() {
   static Reconcile r;
   bool changed = false;
   volRemove(UPLOAD_PATH);
   for (int pass = 0; pass < 32; pass++) {
      memset(&r, 0, sizeof(r));
      volList(reconcileEntry, &r);
      if (pass == 0) {
         uint16_t kept = 0;
         for (uint16_t i = 0; i < itemCount; i++) {
            if (r.seen[i / 8] & (1 << (i % 8)))
               items[kept++] = items[i];
         }
         changed = kept != itemCount;
         itemCount = kept;
      }
      if (r.unknownCount == 0)
         break;
      for (uint8_t i = 0; i < r.unknownCount; i++) {
         char path[40];
         picturePath(r.unknown[i], path, sizeof(path));
         uint32_t fileSize = 0, rawCrc = 0;
         uint16_t thumbLen = 0;
         if (itemCount < GALLERY_MAX_ITEMS && readPictureHeader(path, fileSize, thumbLen, rawCrc)) {
            items[itemCount++] = {r.unknown[i], fileSize, thumbLen, 0};
         }
         else {
            volRemove(path); // not a picture of this display, or no room in the list
         }
         changed = true;
      }
   }
   if (changed) {
      Serial.printf("[GALLERY] List repaired: %u pictures\n", itemCount);
      listChanged();
   }
}

void ensureLoaded() {
   if (loaded)
      return;
   loaded = true;
   loadState();
   itemCount = 0;
   if (!volReady()) {
      Serial.println("[GALLERY] Storage not available.");
      return;
   }
   if (!readIndexFile(INDEX_PATH))
      readIndexFile(INDEX_NEW_PATH);
   Serial.printf("[GALLERY] %u pictures (%s)\n", itemCount, VOLUME_NAME);
}

uint32_t usedBytes() {
   uint32_t used = 0;
   for (uint16_t i = 0; i < itemCount; i++)
      used += items[i].size;
   return used;
}

uint32_t freeBytes() {
   if (!freeCacheValid) {
      freeCache = volReady() ? volFree() : 0;
      freeCacheValid = true;
   }
   return freeCache;
}

uint32_t nextRandom(uint32_t &seed) {
   seed ^= seed << 13;
   seed ^= seed >> 17;
   seed ^= seed << 5;
   return seed;
}

// Index of the picture at position `pos` of the shuffle round with this seed.
uint16_t shuffledIndex(uint32_t seed, uint16_t pos) {
   static uint16_t order[GALLERY_MAX_ITEMS];
   for (uint16_t i = 0; i < itemCount; i++)
      order[i] = i;
   for (uint16_t i = itemCount - 1; i > 0; i--) {
      const uint16_t j = (uint16_t)(nextRandom(seed) % (uint32_t)(i + 1));
      const uint16_t swap = order[i];
      order[i] = order[j];
      order[j] = swap;
   }
   return order[pos];
}

// ---------------------------------------------------------------------------
// Inflating a picture
// ---------------------------------------------------------------------------

class InflateReader
{
 public:
   ~InflateReader() { end(); }

   // bits: window of the stream. The memory needed grows with it (4 KB for 12, 32 KB for 15).
   bool begin(GalFile *source, uint32_t offset, uint32_t length, uint8_t bits) {
      file = source;
      dataOffset = offset;
      dataLength = length;
      dictSize = 1UL << bits;
      decoder = (tinfl_decompressor *)malloc(sizeof(tinfl_decompressor));
      dict = (uint8_t *)malloc(dictSize);
      input = (uint8_t *)malloc(INPUT_SIZE);
      if (!decoder || !dict || !input) {
         Serial.printf("[GALLERY] Not enough memory to unpack the picture (window %u, heap free %u, largest block %u).\n", (unsigned)dictSize,
                       (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
         end();
         return false;
      }
      return rewind();
   }

   bool rewind() {
      if (!decoder || !file->seek(dataOffset))
         return false;
      tinfl_init(decoder);
      remaining = dataLength;
      inPos = inAvail = 0;
      dictOfs = pendingPos = pendingLen = 0;
      finished = failed = false;
      crc = 0;
      total = 0;
      return true;
   }

   // The next bytes of the picture. Fewer than len: the picture has ended or is damaged.
   uint32_t read(uint8_t *out, uint32_t len) {
      uint32_t got = 0;
      while (got < len && !failed) {
         if (pendingLen > 0) {
            const uint32_t n = (pendingLen < len - got) ? pendingLen : (len - got);
            memcpy(out + got, dict + pendingPos, n);
            crc = crc32_le(crc, dict + pendingPos, n);
            pendingPos += n;
            pendingLen -= n;
            got += n;
            total += n;
            continue;
         }
         if (finished)
            break;
         if (inAvail == 0 && remaining > 0) {
            const uint32_t n = (remaining < INPUT_SIZE) ? remaining : INPUT_SIZE;
            if (file->read(input, n) != n) {
               failed = true;
               break;
            }
            inPos = 0;
            inAvail = n;
            remaining -= n;
         }
         size_t inBytes = inAvail;
         size_t outBytes = dictSize - dictOfs;
         const tinfl_status status = tinfl_decompress(decoder, input + inPos, &inBytes, dict, dict + dictOfs, &outBytes,
                                                      (remaining > 0) ? TINFL_FLAG_HAS_MORE_INPUT : 0);
         inPos += inBytes;
         inAvail -= inBytes;
         pendingPos = dictOfs;
         pendingLen = outBytes;
         dictOfs = (dictOfs + outBytes) & (dictSize - 1);
         if (status == TINFL_STATUS_DONE)
            finished = true;
         else if (status < TINFL_STATUS_DONE || (inBytes == 0 && outBytes == 0))
            failed = true; // damaged or cut off
      }
      return got;
   }

   void end() {
      free(decoder);
      free(dict);
      free(input);
      decoder = nullptr;
      dict = nullptr;
      input = nullptr;
   }

   uint32_t crc = 0;
   uint32_t total = 0;
   bool failed = false;

 private:
   static const uint32_t INPUT_SIZE = 1024;
   GalFile *file = nullptr;
   uint32_t dataOffset = 0, dataLength = 0, remaining = 0, dictSize = 0;
   tinfl_decompressor *decoder = nullptr;
   uint8_t *dict = nullptr;
   uint8_t *input = nullptr;
   uint32_t inPos = 0, inAvail = 0, dictOfs = 0, pendingPos = 0, pendingLen = 0;
   bool finished = false;
};

// Unpacks the whole picture once and compares length and checksum.
bool verifyPicture(InflateReader &reader, uint32_t rawCrc) {
   uint8_t buf[512];
   while (reader.read(buf, sizeof(buf)) == sizeof(buf)) {
   }
   return !reader.failed && reader.total == RAW_SIZE && reader.crc == rawCrc;
}

struct PictureRows
{
   InflateReader *reader;
   uint32_t crc;
};

bool rowRewind(void *context) {
   return ((PictureRows *)context)->reader->rewind();
}

// A damaged picture fails at its last row at the latest: the display is not refreshed.
bool rowRead(void *context, uint8_t *row, int len) {
   PictureRows *rows = (PictureRows *)context;
   if (rows->reader->read(row, (uint32_t)len) != (uint32_t)len)
      return false;
   return rows->reader->total < RAW_SIZE || rows->reader->crc == rows->crc;
}

// Upload in progress
uint32_t putId = 0;
uint32_t putSize = 0;
uint32_t putReceived = 0;
uint32_t putCrc = 0;

// Stream that is being read
String listData;
bool readingList = false;
uint32_t readRemaining = 0;
uint32_t readPos = 0;

} // namespace

namespace Gallery {

void begin(bool withReconcile) {
   Lock lock;
   ensureLoaded();
   if (withReconcile && volReady())
      reconcile();
}

uint16_t count() {
   Lock lock;
   ensureLoaded();
   return itemCount;
}

uint32_t revision() {
   Lock lock;
   ensureLoaded();
   return (crc32_le(itemCount, (const uint8_t *)items, itemCount * sizeof(Item)) & 0x7FFFFFFFUL);
}

String stateJson() {
   Lock lock;
   ensureLoaded();
   char current[12] = "";
   if (state.flags & FLAG_HAS_CURRENT)
      snprintf(current, sizeof(current), "%08x", (unsigned)state.currentId);
   char json[240];
   snprintf(json, sizeof(json),
            "{\"count\":%u,\"used\":%u,\"free\":%u,\"total\":%u,\"storage\":\"%s\",\"shuffle\":%d,\"auto\":%d,\"current\":\"%s\",\"rev\":%u}",
            itemCount, (unsigned)usedBytes(), (unsigned)freeBytes(), (unsigned)(volReady() ? volTotal() : 0), VOLUME_NAME,
            (state.flags & FLAG_SHUFFLE) ? 1 : 0, (state.flags & FLAG_AUTO) ? 1 : 0, current, (unsigned)revision());
   return String(json);
}

bool shuffle() {
   Lock lock;
   ensureLoaded();
   return (state.flags & FLAG_SHUFFLE) != 0;
}

bool autoSwitch() {
   Lock lock;
   ensureLoaded();
   return (state.flags & FLAG_AUTO) != 0;
}

void setPlay(bool shuffleOn, bool autoOn) {
   Lock lock;
   ensureLoaded();
   const uint8_t flags = (state.flags & FLAG_HAS_CURRENT) | (shuffleOn ? FLAG_SHUFFLE : 0) | (autoOn ? FLAG_AUTO : 0);
   if (flags == state.flags)
      return;
   state.flags = flags;
   state.seed = 0;
   state.pos = 0;
   saveState();
}

bool select(uint32_t id) {
   Lock lock;
   ensureLoaded();
   if (findItem(id) < 0)
      return false;
   state.currentId = id;
   state.flags |= FLAG_HAS_CURRENT;
   saveState();
   return true;
}

bool next() {
   Lock lock;
   ensureLoaded();
   if (itemCount == 0)
      return false;
   int index;
   if (state.flags & FLAG_SHUFFLE) {
      index = -1;
      // at most twice: the first picture of a new round may be the one on the display
      for (int attempt = 0; attempt < 2; attempt++) {
         if (state.seed == 0 || state.pos >= itemCount) {
            state.seed = esp_random() | 1;
            state.pos = 0;
         }
         index = shuffledIndex(state.seed, state.pos++);
         if (itemCount == 1 || !(state.flags & FLAG_HAS_CURRENT) || items[index].id != state.currentId)
            break;
      }
   }
   else {
      index = (state.flags & FLAG_HAS_CURRENT) ? findItem(state.currentId) : -1;
      index = (index + 1) % itemCount;
   }
   state.currentId = items[index].id;
   state.flags |= FLAG_HAS_CURRENT;
   saveState();
   return true;
}

int showCurrent() {
   char path[40];
   {
      Lock lock;
      ensureLoaded();
      if (!(state.flags & FLAG_HAS_CURRENT) || findItem(state.currentId) < 0)
         return -1;
      picturePath(state.currentId, path, sizeof(path));
   }
   Serial.printf("[GALLERY] Showing %s\n", path);

   uint8_t header[GALLERY_HEADER_SIZE];
   uint16_t thumbLen = 0;
   uint32_t rawCrc = 0;
   GalFile file;
   if (!volReady() || !file.openRead(path))
      return -1;
   const uint32_t fileSize = file.size();
   if (file.read(header, sizeof(header)) != sizeof(header) || !parseHeader(header, fileSize, thumbLen, rawCrc)) {
      Serial.println("[GALLERY] Picture file is damaged.");
      return -1;
   }
   const uint32_t dataOffset = (uint32_t)GALLERY_HEADER_SIZE + thumbLen;
   InflateReader reader;
   if (!reader.begin(&file, dataOffset, fileSize - dataOffset, windowBits(header)))
      return -1;

#ifndef EPD_TYPE_13INCH
   // drawn in several passes: checked before the first one (13.3": one pass, checked at its end)
   if (!verifyPicture(reader, rawCrc) || !reader.rewind()) {
      Serial.println("[GALLERY] Picture could not be unpacked.");
      return -1;
   }
#endif
   PictureRows rows = {&reader, rawCrc};
   const int result = setImageFromRows(rowRewind, rowRead, &rows);
   Serial.printf("[EPD] Set Image Done: %d\n", result);
   if (result == 0)
      setDisplayContent(DISPLAY_PICTURE);
   return result;
}

uint16_t beginPut(uint32_t id, uint32_t size) {
   Lock lock;
   ensureLoaded();
   abortPut();
   if (size <= GALLERY_HEADER_SIZE || size > MAX_FILE_SIZE || !volReady())
      return STATUS_UPLOAD_ERROR;
   const int existing = findItem(id);
   if (existing < 0 && itemCount >= GALLERY_MAX_ITEMS)
      return STATUS_NO_SPACE;
   freeCacheValid = false;
   if (size + PUT_OVERHEAD > freeBytes())
      return STATUS_NO_SPACE;
   if (!putFile.openWrite(UPLOAD_PATH))
      return STATUS_UPLOAD_ERROR;
   putId = id;
   putSize = size;
   putReceived = 0;
   putCrc = 0;
   return 0;
}

bool putActive() {
   return (bool)putFile;
}

bool writePut(const uint8_t *data, uint32_t len) {
   Lock lock;
   if (!putFile || putReceived + len > putSize || putFile.write(data, len) != len)
      return false;
   putCrc = crc32_le(putCrc, data, len);
   putReceived += len;
   return true;
}

void abortPut() {
   Lock lock;
   if (putFile) {
      putFile.close();
      volRemove(UPLOAD_PATH);
      freeCacheValid = false;
   }
}

bool endPut(uint32_t crc) {
   Lock lock;
   if (!putFile)
      return false;
   bool ok = putFile.close() && putReceived == putSize && putCrc == crc && crc == putId;

   // read the stored file back: header and checksum
   uint16_t thumbLen = 0;
   uint32_t rawCrc = 0;
   if (ok) {
      uint8_t *buf = (uint8_t *)malloc(2048);
      ok = buf != nullptr && auxFile.openRead(UPLOAD_PATH);
      if (ok) {
         uint32_t fileCrc = 0;
         uint32_t done = 0;
         while (done < putSize) {
            const uint32_t n = auxFile.read(buf, 2048);
            if (n == 0)
               break;
            if (done == 0)
               ok = n >= GALLERY_HEADER_SIZE && parseHeader(buf, putSize, thumbLen, rawCrc);
            fileCrc = crc32_le(fileCrc, buf, n);
            done += n;
         }
         ok = ok && done == putSize && fileCrc == putId;
      }
      auxFile.close();
      free(buf);
   }

   char path[40];
   picturePath(putId, path, sizeof(path));
   ok = ok && volRename(UPLOAD_PATH, path);
   if (!ok) {
      Serial.printf("[GALLERY] Upload of %08x discarded (%u of %u bytes).\n", (unsigned)putId, (unsigned)putReceived, (unsigned)putSize);
      volRemove(UPLOAD_PATH);
      freeCacheValid = false;
      return false;
   }

   const int existing = findItem(putId);
   if (existing >= 0) {
      items[existing].size = putSize;
      items[existing].thumbLen = thumbLen;
   }
   else {
      items[itemCount++] = {putId, putSize, thumbLen, 0};
   }
   listChanged();
   Serial.printf("[GALLERY] Stored %08x (%u bytes), %u pictures\n", (unsigned)putId, (unsigned)putSize, itemCount);
   return true;
}

bool setOrder(const uint8_t *ids, uint16_t n) {
   Lock lock;
   ensureLoaded();
   abortPut();
   Item *ordered = (Item *)malloc(sizeof(Item) * (itemCount ? itemCount : 1));
   if (ordered == nullptr)
      return false;
   uint8_t placed[(GALLERY_MAX_ITEMS + 7) / 8];
   memset(placed, 0, sizeof(placed));
   uint16_t orderedCount = 0;
   for (uint16_t i = 0; i < n; i++) {
      const uint32_t id = (uint32_t)ids[i * 4] | ((uint32_t)ids[i * 4 + 1] << 8) | ((uint32_t)ids[i * 4 + 2] << 16) | ((uint32_t)ids[i * 4 + 3] << 24);
      const int index = findItem(id);
      if (index < 0 || (placed[index / 8] & (1 << (index % 8))))
         continue;
      placed[index / 8] |= (uint8_t)(1 << (index % 8));
      ordered[orderedCount++] = items[index];
   }
   for (uint16_t i = 0; i < itemCount; i++) {
      if (!(placed[i / 8] & (1 << (i % 8))))
         ordered[orderedCount++] = items[i];
   }
   memcpy(items, ordered, (size_t)itemCount * sizeof(Item));
   free(ordered);
   listChanged();
   return true;
}

void remove(uint32_t id) {
   Lock lock;
   ensureLoaded();
   abortPut();
   const int index = findItem(id);
   if (index < 0 || !volReady())
      return;
   char path[40];
   picturePath(id, path, sizeof(path));
   volRemove(path);
   for (uint16_t i = index; i + 1 < itemCount; i++)
      items[i] = items[i + 1];
   itemCount--;
   listChanged();
}

void clear() {
   Lock lock;
   ensureLoaded();
   abortPut();
   closeRead();
   if (volReady()) {
      char path[40];
      for (uint16_t i = 0; i < itemCount; i++) {
         picturePath(items[i].id, path, sizeof(path));
         volRemove(path);
      }
   }
   itemCount = 0;
   state.flags &= ~FLAG_HAS_CURRENT;
   if (volReady())
      listChanged();
   else
      saveState();
}

bool openRead(ReadKind kind, uint32_t id, uint32_t offset, uint32_t &length) {
   Lock lock;
   ensureLoaded();
   closeRead();
   if (kind == READ_LIST) {
      listData = "{\"items\":[";
      listData.reserve(16 + (size_t)itemCount * 30);
      char entry[40];
      for (uint16_t i = 0; i < itemCount; i++) {
         snprintf(entry, sizeof(entry), "%s[\"%08x\",%u,%u]", i ? "," : "", (unsigned)items[i].id, (unsigned)items[i].size, items[i].thumbLen);
         listData += entry;
      }
      listData += "]}";
      length = listData.length();
      readingList = true;
      readPos = (offset < length) ? offset : length;
      return true;
   }

   const int index = findItem(id);
   if (index < 0 || !volReady())
      return false;
   char path[40];
   picturePath(id, path, sizeof(path));
   if (!readFile.openRead(path))
      return false;
   const uint32_t start = (kind == READ_THUMB) ? GALLERY_HEADER_SIZE : 0;
   length = (kind == READ_THUMB) ? items[index].thumbLen : items[index].size;
   if (offset > length)
      offset = length;
   if (!readFile.seek(start + offset)) {
      readFile.close();
      return false;
   }
   readRemaining = length - offset;
   return true;
}

uint32_t readChunk(uint8_t *buf, uint32_t maxLen) {
   Lock lock;
   if (readingList) {
      const uint32_t left = listData.length() - readPos;
      const uint32_t n = (left < maxLen) ? left : maxLen;
      memcpy(buf, listData.c_str() + readPos, n);
      readPos += n;
      return n;
   }
   if (!readFile || readRemaining == 0)
      return 0;
   const uint32_t n = readFile.read(buf, (readRemaining < maxLen) ? readRemaining : maxLen);
   readRemaining -= n;
   if (n == 0 || readRemaining == 0)
      readFile.close();
   return n;
}

void closeRead() {
   Lock lock;
   readingList = false;
   listData = String();
   readRemaining = 0;
   if (readFile)
      readFile.close();
}

} // namespace Gallery
