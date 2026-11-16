#include "storage.h"
#include "ext_flash.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

void prepareSpiBusForFlash(); // main.cpp: chip selects of the shared bus, supply of the 13.3" board

namespace {

lfs_t fs;
lfs_config fsConfig;
bool mounted = false;
SemaphoreHandle_t fsLock = nullptr;
uint8_t readBuffer[STORAGE_CACHE_SIZE];
uint8_t progBuffer[STORAGE_CACHE_SIZE];
uint8_t lookaheadBuffer[64];

// Files are used from the main loop and from the BLE task.
struct Lock
{
   Lock() {
      if (fsLock)
         xSemaphoreTakeRecursive(fsLock, portMAX_DELAY);
   }
   ~Lock() {
      if (fsLock)
         xSemaphoreGiveRecursive(fsLock);
   }
};

int bdRead(const lfs_config *c, lfs_block_t block, lfs_off_t off, void *buffer, lfs_size_t size) {
   prepareSpiBusForFlash();
   return ExtFlash::read(STORAGE_OFFSET + block * c->block_size + off, (uint8_t *)buffer, size) ? LFS_ERR_OK : LFS_ERR_IO;
}

int bdProg(const lfs_config *c, lfs_block_t block, lfs_off_t off, const void *buffer, lfs_size_t size) {
   prepareSpiBusForFlash();
   // LFS_ERR_CORRUPT: the file system moves the data to another block
   return ExtFlash::program(STORAGE_OFFSET + block * c->block_size + off, (const uint8_t *)buffer, size) ? LFS_ERR_OK : LFS_ERR_CORRUPT;
}

int bdErase(const lfs_config *c, lfs_block_t block) {
   prepareSpiBusForFlash();
   return ExtFlash::eraseSector(STORAGE_OFFSET + block * c->block_size) ? LFS_ERR_OK : LFS_ERR_CORRUPT;
}

int bdSync(const lfs_config *c) {
   return LFS_ERR_OK;
}

} // namespace

bool StoreFile::openRead(const char *name) {
   close();
   if (!mounted)
      return false;
   Lock lock;
   memset(&config, 0, sizeof(config));
   config.buffer = cache;
   opened = lfs_file_opencfg(&fs, &file, name, LFS_O_RDONLY, &config) == LFS_ERR_OK;
   return opened;
}

bool StoreFile::openWrite(const char *name) {
   close();
   if (!mounted)
      return false;
   Lock lock;
   memset(&config, 0, sizeof(config));
   config.buffer = cache;
   opened = lfs_file_opencfg(&fs, &file, name, LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC, &config) == LFS_ERR_OK;
   return opened;
}

uint32_t StoreFile::read(void *buf, uint32_t len) {
   if (!opened)
      return 0;
   Lock lock;
   const lfs_ssize_t result = lfs_file_read(&fs, &file, buf, len);
   return (result > 0) ? (uint32_t)result : 0;
}

uint32_t StoreFile::write(const void *buf, uint32_t len) {
   if (!opened)
      return 0;
   Lock lock;
   const lfs_ssize_t result = lfs_file_write(&fs, &file, buf, len);
   return (result > 0) ? (uint32_t)result : 0;
}

bool StoreFile::seek(uint32_t pos) {
   if (!opened)
      return false;
   Lock lock;
   return lfs_file_seek(&fs, &file, pos, LFS_SEEK_SET) >= 0;
}

uint32_t StoreFile::size() {
   if (!opened)
      return 0;
   Lock lock;
   const lfs_soff_t result = lfs_file_size(&fs, &file);
   return (result > 0) ? (uint32_t)result : 0;
}

uint32_t StoreFile::position() {
   if (!opened)
      return 0;
   Lock lock;
   const lfs_soff_t result = lfs_file_tell(&fs, &file);
   return (result > 0) ? (uint32_t)result : 0;
}

bool StoreFile::close() {
   if (!opened)
      return true;
   Lock lock;
   opened = false;
   return lfs_file_close(&fs, &file) == LFS_ERR_OK;
}

namespace Storage {

bool begin(uint8_t csPin, uint32_t spiHz) {
   if (fsLock == nullptr)
      fsLock = xSemaphoreCreateRecursiveMutex();
   Lock lock;
   if (mounted)
      return true;
   prepareSpiBusForFlash();
   if (!ExtFlash::begin(csPin, spiHz) || ExtFlash::capacity() <= STORAGE_OFFSET) {
      Serial.println("[FLASH] ERROR: No flash chip found, pictures cannot be stored.");
      return false;
   }

   memset(&fsConfig, 0, sizeof(fsConfig));
   fsConfig.read = bdRead;
   fsConfig.prog = bdProg;
   fsConfig.erase = bdErase;
   fsConfig.sync = bdSync;
   fsConfig.read_size = 1;
   fsConfig.prog_size = 1;
   fsConfig.block_size = ExtFlash::SECTOR_SIZE;
   fsConfig.block_count = (ExtFlash::capacity() - STORAGE_OFFSET) / ExtFlash::SECTOR_SIZE;
   fsConfig.block_cycles = 500;
   fsConfig.cache_size = STORAGE_CACHE_SIZE;
   fsConfig.lookahead_size = sizeof(lookaheadBuffer);
   fsConfig.read_buffer = readBuffer;
   fsConfig.prog_buffer = progBuffer;
   fsConfig.lookahead_buffer = lookaheadBuffer;

   int result = lfs_mount(&fs, &fsConfig);
   if (result != LFS_ERR_OK) {
      // first start with this firmware, or the cloud firmware used the flash in between
      Serial.printf("[FLASH] No file system found (%d), formatting...\n", result);
      result = lfs_format(&fs, &fsConfig);
      if (result == LFS_ERR_OK)
         result = lfs_mount(&fs, &fsConfig);
   }
   mounted = (result == LFS_ERR_OK);
   if (mounted)
      Serial.printf("[FLASH] File system ready: %u of %u bytes free\n", (unsigned)freeBytes(), (unsigned)totalBytes());
   else
      Serial.printf("[FLASH] ERROR: File system not usable (%d)\n", result);
   return mounted;
}

bool ready() {
   return mounted;
}

int32_t fileSize(const char *name) {
   if (!mounted)
      return -1;
   Lock lock;
   lfs_info info;
   if (lfs_stat(&fs, name, &info) != LFS_ERR_OK || info.type != LFS_TYPE_REG)
      return -1;
   return (int32_t)info.size;
}

bool exists(const char *name) {
   return fileSize(name) >= 0;
}

bool remove(const char *name) {
   if (!mounted)
      return false;
   Lock lock;
   const int result = lfs_remove(&fs, name);
   return result == LFS_ERR_OK || result == LFS_ERR_NOENT;
}

bool rename(const char *from, const char *to) {
   if (!mounted)
      return false;
   Lock lock;
   return lfs_rename(&fs, from, to) == LFS_ERR_OK;
}

bool makeDir(const char *name) {
   if (!mounted)
      return false;
   Lock lock;
   const int result = lfs_mkdir(&fs, name);
   return result == LFS_ERR_OK || result == LFS_ERR_EXIST;
}

bool list(const char *dir, ListCallback callback, void *context) {
   if (!mounted)
      return false;
   Lock lock;
   lfs_dir_t handle;
   if (lfs_dir_open(&fs, &handle, dir) != LFS_ERR_OK)
      return false;
   lfs_info info;
   while (lfs_dir_read(&fs, &handle, &info) > 0) {
      if (info.type == LFS_TYPE_REG)
         callback(info.name, info.size, context);
   }
   lfs_dir_close(&fs, &handle);
   return true;
}

uint32_t totalBytes() {
   return mounted ? fsConfig.block_count * fsConfig.block_size : 0;
}

uint32_t freeBytes() {
   if (!mounted)
      return 0;
   Lock lock;
   const lfs_ssize_t used = lfs_fs_size(&fs);
   if (used < 0 || (lfs_size_t)used >= fsConfig.block_count)
      return 0;
   return (fsConfig.block_count - used) * fsConfig.block_size;
}

} // namespace Storage
