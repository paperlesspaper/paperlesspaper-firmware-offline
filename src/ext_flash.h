#pragma once
#include <Arduino.h>

// Driver for the external SPI NOR flash (W25Q128JV and compatible chips with 3 byte addresses).
namespace ExtFlash {

constexpr uint32_t SECTOR_SIZE = 4096;
constexpr uint32_t PAGE_SIZE = 256;

bool begin(uint8_t csPin, uint32_t spiHz);
uint32_t capacity(); // bytes, 0 if no chip answered
bool read(uint32_t addr, uint8_t *buf, uint32_t len);
bool program(uint32_t addr, const uint8_t *buf, uint32_t len); // read back and compared
bool eraseSector(uint32_t addr);                               // 4 KB

} // namespace ExtFlash
