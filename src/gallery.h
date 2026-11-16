#pragma once
#include "types.h"
#include <Arduino.h>

// Pictures of the gallery: stored compressed in the flash (7.3") or on the SD card (13.3").
// File format and commands: README, "Gallery".
namespace Gallery {

struct Item
{
   uint32_t id; // CRC32 of the picture file
   uint32_t size;
   uint16_t thumbLen;
   uint16_t reserved;
};

enum ReadKind
{
   READ_LIST,
   READ_THUMB,
   READ_PICTURE
};

// Loads the list. reconcile: also compares it with the stored files (slower).
void begin(bool reconcile);
uint16_t count();
uint32_t revision();
String stateJson();

// Play settings and the picture on the display
bool shuffle();
bool autoSwitch();
void setPlay(bool shuffle, bool autoSwitch);
bool select(uint32_t id);
bool next();       // selects the next picture, false if there is none
int showCurrent(); // 0 = the selected picture is on the display

// Changes. beginPut() returns 0 or a STATUS_* code.
uint16_t beginPut(uint32_t id, uint32_t size);
bool writePut(const uint8_t *data, uint32_t len);
bool endPut(uint32_t crc);
void abortPut();
bool putActive();
bool setOrder(const uint8_t *ids, uint16_t n); // n ids, 4 bytes each, little endian
void remove(uint32_t id);
void clear();

// Reading the list, a preview or a picture file in chunks
bool openRead(ReadKind kind, uint32_t id, uint32_t offset, uint32_t &length);
uint32_t readChunk(uint8_t *buf, uint32_t maxLen);
void closeRead();

} // namespace Gallery
