#include "ext_flash.h"
#include <SPI.h>

namespace ExtFlash {

static const uint8_t CMD_PAGE_PROGRAM = 0x02;
static const uint8_t CMD_READ = 0x03;
static const uint8_t CMD_READ_STATUS = 0x05;
static const uint8_t CMD_WRITE_ENABLE = 0x06;
static const uint8_t CMD_SECTOR_ERASE = 0x20;
static const uint8_t CMD_JEDEC_ID = 0x9F;
static const uint8_t CMD_RELEASE_POWER_DOWN = 0xAB;
static const uint8_t STATUS_BUSY = 0x01;

static const uint32_t PROGRAM_TIMEOUT_MS = 100; // page program: 3 ms at most
static const uint32_t ERASE_TIMEOUT_MS = 2000;  // sector erase: 400 ms at most
static const uint32_t MAX_CAPACITY = 0x1000000; // 16 MB, the limit of 3 byte addresses

static uint8_t cs = 0xFF;
static uint32_t speed = 8000000;
static uint32_t chipBytes = 0;

static void select() {
   SPI.beginTransaction(SPISettings(speed, MSBFIRST, SPI_MODE0));
   digitalWrite(cs, LOW);
}

static void release() {
   digitalWrite(cs, HIGH);
   SPI.endTransaction();
}

static void sendAddress(uint8_t command, uint32_t addr) {
   SPI.transfer(command);
   SPI.transfer((addr >> 16) & 0xFF);
   SPI.transfer((addr >> 8) & 0xFF);
   SPI.transfer(addr & 0xFF);
}

static bool busy() {
   select();
   SPI.transfer(CMD_READ_STATUS);
   const uint8_t status = SPI.transfer(0);
   release();
   return (status & STATUS_BUSY) != 0;
}

static bool waitIdle(uint32_t timeoutMs) {
   const unsigned long start = millis();
   uint32_t fastPolls = 0;
   while (busy()) {
      if (millis() - start > timeoutMs)
         return false;
      if (fastPolls < 40) {
         delayMicroseconds(50);
         fastPolls++;
      }
      else {
         delay(1);
      }
   }
   return true;
}

static void writeEnable() {
   select();
   SPI.transfer(CMD_WRITE_ENABLE);
   release();
}

bool begin(uint8_t csPin, uint32_t spiHz) {
   cs = csPin;
   speed = spiHz;
   pinMode(cs, OUTPUT);
   digitalWrite(cs, HIGH);

   select();
   SPI.transfer(CMD_RELEASE_POWER_DOWN);
   release();
   delayMicroseconds(100);

   uint8_t id[3];
   select();
   SPI.transfer(CMD_JEDEC_ID);
   for (uint8_t &b : id)
      b = SPI.transfer(0);
   release();

   chipBytes = 0;
   const bool answered = !(id[0] == 0xFF && id[1] == 0xFF && id[2] == 0xFF) && !(id[0] == 0 && id[1] == 0 && id[2] == 0);
   if (answered && id[2] >= 0x10 && id[2] <= 0x20) {
      chipBytes = 1UL << id[2];
      if (chipBytes > MAX_CAPACITY)
         chipBytes = MAX_CAPACITY;
   }
   Serial.printf("[FLASH] JEDEC ID %02X %02X %02X, %u bytes\n", id[0], id[1], id[2], (unsigned)chipBytes);
   return chipBytes > 0 && waitIdle(ERASE_TIMEOUT_MS);
}

uint32_t capacity() {
   return chipBytes;
}

bool read(uint32_t addr, uint8_t *buf, uint32_t len) {
   if (addr + len > chipBytes)
      return false;
   if (len == 0)
      return true;
   select();
   sendAddress(CMD_READ, addr);
   SPI.transferBytes(nullptr, buf, len);
   release();
   return true;
}

bool program(uint32_t addr, const uint8_t *buf, uint32_t len) {
   if (addr + len > chipBytes)
      return false;
   uint8_t check[PAGE_SIZE];
   uint32_t done = 0;
   while (done < len) {
      const uint32_t pageAddr = addr + done;
      const uint32_t roomInPage = PAGE_SIZE - (pageAddr % PAGE_SIZE);
      const uint32_t chunk = (len - done < roomInPage) ? (len - done) : roomInPage;

      writeEnable();
      select();
      sendAddress(CMD_PAGE_PROGRAM, pageAddr);
      SPI.writeBytes(buf + done, chunk);
      release();
      if (!waitIdle(PROGRAM_TIMEOUT_MS))
         return false;

      if (!read(pageAddr, check, chunk) || memcmp(check, buf + done, chunk) != 0) {
         Serial.printf("[FLASH] Program verify failed at 0x%06X\n", (unsigned)pageAddr);
         return false;
      }
      done += chunk;
   }
   return true;
}

bool eraseSector(uint32_t addr) {
   if (addr >= chipBytes)
      return false;
   writeEnable();
   select();
   sendAddress(CMD_SECTOR_ERASE, addr & ~(SECTOR_SIZE - 1));
   release();
   return waitIdle(ERASE_TIMEOUT_MS);
}

} // namespace ExtFlash
