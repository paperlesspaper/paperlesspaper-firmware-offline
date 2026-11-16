#pragma once
#include <Arduino.h>
#include <lfs.h>

// Files on the external flash (LittleFS). The first 64 KB of the chip are left untouched:
// the cloud firmware keeps its directory there.

#define STORAGE_OFFSET 0x10000UL
#define STORAGE_CACHE_SIZE 256

// One open file. Must not be copied or moved while it is open.
class StoreFile
{
 public:
   StoreFile() {}
   ~StoreFile() { close(); }
   StoreFile(const StoreFile &) = delete;
   StoreFile &operator=(const StoreFile &) = delete;

   bool openRead(const char *name);
   bool openWrite(const char *name); // creates the file or empties it
   explicit operator bool() const { return opened; }
   uint32_t read(void *buf, uint32_t len);        // bytes read
   uint32_t write(const void *buf, uint32_t len); // bytes written, less than len on an error
   bool seek(uint32_t pos);
   uint32_t size();
   uint32_t position();
   bool close(); // false if the data could not be stored

 private:
   lfs_file_t file;
   lfs_file_config config;
   uint8_t cache[STORAGE_CACHE_SIZE];
   bool opened = false;
};

namespace Storage {

typedef void (*ListCallback)(const char *name, uint32_t size, void *context);

bool begin(uint8_t csPin, uint32_t spiHz); // mounts, formats an unknown flash
bool ready();
bool exists(const char *name);
int32_t fileSize(const char *name); // -1 if the file does not exist
bool remove(const char *name);
bool rename(const char *from, const char *to); // replaces an existing file
bool makeDir(const char *name);
bool list(const char *dir, ListCallback callback, void *context); // files only
uint32_t totalBytes();
uint32_t freeBytes();

} // namespace Storage
